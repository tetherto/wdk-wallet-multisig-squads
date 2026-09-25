// Copyright 2024 Tether Operations Limited
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

'use strict'

import { describe, it, expect, beforeEach, jest } from '@jest/globals'

import { getBase58Decoder, getBase58Encoder, getBase64Decoder, getBase64Encoder, getU64Encoder } from '@solana/codecs'

import { pipe } from '@solana/functional'
import { AccountRole } from '@solana/instructions'
import {
  appendTransactionMessageInstructions,
  compressTransactionMessageUsingAddressLookupTables,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash
} from '@solana/transaction-messages'
import { compileTransaction, getTransactionDecoder, isFullySignedTransaction } from '@solana/transactions'

import { AssertionError, MaximumFeeExceededError, NoSuchElementError, UnsupportedOperationError, ValueError } from '@tetherto/wdk-wallet'

import { AccountNotOwnerError, ThresholdNotMetError } from '@tetherto/wdk-wallet/multisig'

import { lookupTableAccount, rpcRequests, stubSolanaRpc } from './helpers/rpc.js'

import WalletManagerMultisigSquads, {
  WalletAccountMultisigSquads,
  WalletAccountReadOnlyMultisigSquads,
  PERMISSION,
  SQUADS_PROGRAM_ADDRESS
} from '@tetherto/wdk-wallet-multisig-squads'

const TEST_SEED_PHRASE =
  'test walk nut penalty hip pave soap entry language right filter choice'
const TEST_RPC_URL = 'https://dummy-url.com'
const TEST_MULTISIG_PDA = 'EEPqJbpYrwqisgoPt3Vu74YBqRji8mFrRxQdARVfDuNG'

// A fixed 32-byte create key secret, so the derived multisig address is stable.
const CREATE_KEY_SECRET = getBase58Decoder().decode(new Uint8Array(32).fill(9))

// What CREATE_KEY_SECRET derives to, and the multisig PDA the SDK derives from it.
const CREATE_KEY = 'J2xccRtuG43drESLYznHhLhQkLTdfepcKYbiQ9BsJVaf'
const DERIVED_MULTISIG_PDA = '7jmBsJmAV5aAwEQkw3AybYgTMHVUzbWgWMGvyMjhSEDQ'

// PDAs of TEST_MULTISIG_PDA, from the SDK's `getProposalPda` / `getSpendingLimitPda` rather
// than from the code under test, so a broken derivation fails instead of cancelling out.
const TEST_PROPOSAL_PDA_3 = 'E5EgUq6vmcx2ZorjGvtmdatZwNXLcA7V55ZuFUPursRx'
const TEST_PROPOSAL_PDA_4 = 'DNhyRfBQP5MAJEJ6Cr97DVbJgmoHcVWFpYKxZawXquP9'
const TEST_VAULT_PDA = '6soQChwEoXXbAo17wNPdfLFaxzrAjiAxPif9nbJkDXCm'

// The member key `getAccount(0)` derives from TEST_SEED_PHRASE.
const TEST_SIGNER = '3uXqWpwgqKVdiHAwF6Vmu4G4vdQzpR66xjPkz1G7zMKE'
const OTHER_MEMBER = '2JvLzXomThTBMSj2YQY3wE21kiaSpwGyJ17nm9xiLMsE'
const THIRD_MEMBER = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

// The signature each write path's stubbed send reports, one per builder so a result can never
// be mistaken for another path's, and the fee they all return.
const DUMMY_VOTE_HASH = 'deadbeef'
const DUMMY_DEPLOY_HASH = 'ba5eba11'
const DUMMY_CONFIG_HASH = 'facade'
const DUMMY_PROPOSE_HASH = 'cafebabe'
const DUMMY_EXECUTE_HASH = 'c0ffee'
const DUMMY_TRANSFER_HASH = 'feedface'
const DUMMY_FEE = 5000n

// What proposalApprove and proposalReject both pass: the multisig read-only, the voting member
// as a writable signer paying the rent, and the proposal writable.
const VOTE_ACCOUNTS = [
  { address: TEST_MULTISIG_PDA, role: 0 },
  { address: TEST_SIGNER, role: 3 },
  { address: TEST_PROPOSAL_PDA_3, role: 1 }
]

const CONFIG_TRANSACTION_DISCRIMINATOR = [94, 8, 4, 35, 113, 139, 139, 112]
const SYSTEM_PROGRAM = '11111111111111111111111111111111'
const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111'

/**
 * Serves a `Multisig` account holding the given members, so membership checks can run
 * without a network. Only the fields those checks read are populated.
 *
 * @param {Array<{ address: string, mask?: number }>|null} members - The members, or null
 *   to report the multisig as absent.
 * @returns {Function} A `getAccountInfo` mock.
 */
function multisigAccountValue (members, {
  threshold = 1,
  transactionIndex = 0n,
  staleTransactionIndex = 0n,
  timeLock = 0,
  configAuthority = null
} = {}) {
  const data = new Uint8Array(95 + 1 + 4 + members.length * 33)
  const view = new DataView(data.buffer)

  const MULTISIG_DISCRIMINATOR = [224, 116, 121, 186, 68, 161, 79, 236]

  data.set(MULTISIG_DISCRIMINATOR, 0)

  if (configAuthority) {
    data.set(getBase58Encoder().encode(configAuthority), 40)
  }

  view.setUint16(72, threshold, true)
  view.setUint32(74, timeLock, true)
  view.setBigUint64(78, transactionIndex, true)
  view.setBigUint64(86, staleTransactionIndex, true)

  let offset = 96

  view.setUint32(offset, members.length, true)
  offset += 4

  for (const { address, mask = 7 } of members) {
    data.set(getBase58Encoder().encode(address), offset)
    data[offset + 32] = mask
    offset += 33
  }

  return {
    owner: SQUADS_PROGRAM_ADDRESS,
    data: [getBase64Decoder().decode(data), 'base64'],
    executable: false,
    lamports: 2039280,
    space: data.length
  }
}

/**
 * Serves a `Proposal` account in the given status, holding the given votes.
 *
 * @param {Object} [options] - The proposal state.
 * @param {number} [options.status=1] - The status enum tag; 1 is open for voting.
 * @param {string[]} [options.approved] - The members who have approved.
 * @param {string[]} [options.rejected] - The members who have rejected.
 * @returns {Object} An account value.
 */
function proposalAccountValue ({ status = 1, approved = [], rejected = [], timestamp = 0n } = {}) {
  const voters = [approved, rejected, []]
  const data = new Uint8Array(58 + voters.reduce((total, list) => total + 4 + list.length * 32, 0))
  const view = new DataView(data.buffer)

  const PROPOSAL_DISCRIMINATOR = [26, 94, 189, 187, 116, 136, 53, 33]

  data.set(PROPOSAL_DISCRIMINATOR, 0)
  data[48] = status

  if (status !== 4) {
    view.setBigInt64(49, timestamp, true)
  }

  // The status carries an i64 timestamp for every tag but Executing, then the bump.
  let offset = status === 4 ? 50 : 58

  for (const list of voters) {
    view.setUint32(offset, list.length, true)
    offset += 4

    for (const voter of list) {
      data.set(getBase58Encoder().encode(voter), offset)
      offset += 32
    }
  }

  return {
    owner: SQUADS_PROGRAM_ADDRESS,
    data: [getBase64Decoder().decode(data.subarray(0, offset)), 'base64'],
    executable: false,
    lamports: 2039280,
    space: offset
  }
}

/**
 * Serves a `VaultTransaction` account holding a message over the given keys.
 *
 * @param {Object} [options] - The transaction state.
 * @param {string[]} [options.accountKeys] - The message's account keys.
 * @param {number} [options.vaultIndex=0] - The vault the transaction belongs to.
 * @param {number} [options.ephemeralSignerCount=0] - How many ephemeral signers it needs.
 * @returns {Object} An account value.
 */
function vaultTransactionAccountValue ({
  accountKeys = [TEST_SIGNER, OTHER_MEMBER, SYSTEM_PROGRAM],
  vaultIndex = 0,
  ephemeralSignerCount = 0,
  lookupTable = null
} = {}) {
  // 87 fixed fields, the ephemeral bumps, then the message: 3 header bytes, the key vec,
  // empty instruction vec, and the lookup vec, one entry of which is a key and two index vecs.
  const lookupSize = lookupTable ? 32 + 4 + 1 + 4 : 0
  const size = 87 + ephemeralSignerCount + 3 + 4 + accountKeys.length * 32 + 4 + 4 + lookupSize
  const data = new Uint8Array(size)
  const view = new DataView(data.buffer)

  const VAULT_TRANSACTION_DISCRIMINATOR = [168, 250, 162, 100, 81, 14, 162, 207]

  data.set(VAULT_TRANSACTION_DISCRIMINATOR, 0)
  data[81] = vaultIndex
  view.setUint32(83, ephemeralSignerCount, true)

  let offset = 87 + ephemeralSignerCount

  // One writable signer (the vault), then one writable non-signer, then the program.
  data[offset] = 1
  data[offset + 1] = 1
  data[offset + 2] = 1
  offset += 3

  view.setUint32(offset, accountKeys.length, true)
  offset += 4

  for (const key of accountKeys) {
    data.set(getBase58Encoder().encode(key), offset)
    offset += 32
  }

  // Zero instructions, then the lookups.
  offset += 4

  if (lookupTable) {
    view.setUint32(offset, 1, true)
    data.set(getBase58Encoder().encode(lookupTable), offset + 4)
    // One writable index, no read-only ones.
    view.setUint32(offset + 36, 1, true)
    data[offset + 40] = 0
    view.setUint32(offset + 41, 0, true)
  }

  return accountValue(data)
}

/**
 * Serves a `ConfigTransaction` account holding the given actions.
 *
 * `SetRentCollectorSome` writes the `Some` form of `SetRentCollector`, whose body is 32
 * bytes longer than the `None` form.
 *
 * @param {Array<string | { kind: string, key?: string }>} kinds - The action kinds, optionally
 *   with the address their body leads with.
 * @returns {Object} An account value.
 */
function configTransactionAccountValue (kinds) {
  const TAGS = [
    'AddMember',
    'RemoveMember',
    'ChangeThreshold',
    'SetTimeLock',
    'AddSpendingLimit',
    'RemoveSpendingLimit',
    'SetRentCollector'
  ]
  const BODIES = {
    AddMember: 33,
    RemoveMember: 32,
    ChangeThreshold: 2,
    SetTimeLock: 4,
    AddSpendingLimit: 74 + 4 + 4,
    RemoveSpendingLimit: 32,
    SetRentCollector: 1,
    SetRentCollectorSome: 33
  }
  const nameOf = (entry) => typeof entry === 'string' ? entry : entry.kind
  const size = 85 + kinds.reduce((total, entry) => total + 1 + BODIES[nameOf(entry)], 0)
  const data = new Uint8Array(size)
  const view = new DataView(data.buffer)

  data.set(CONFIG_TRANSACTION_DISCRIMINATOR, 0)
  view.setUint32(81, kinds.length, true)

  let offset = 85

  for (const entry of kinds) {
    const kind = nameOf(entry)

    data[offset] = TAGS.indexOf(kind.replace(/Some$/, ''))

    if (kind === 'SetRentCollectorSome') {
      data[offset + 1] = 1
    }

    // AddSpendingLimit leads with its create key; RemoveSpendingLimit with the account itself.
    if (entry.key) {
      data.set(getBase58Encoder().encode(entry.key), offset + 1)
    }

    offset += 1 + BODIES[kind]
  }

  return accountValue(data)
}

/**
 * Serves the clock sysvar reporting the given Unix timestamp.
 *
 * @param {bigint} now - The timestamp.
 * @returns {Object} An account value.
 */
function clockAccountValue (now) {
  const data = new Uint8Array(40)

  new DataView(data.buffer).setBigInt64(32, now, true)

  return { ...accountValue(data), owner: 'Sysvar1111111111111111111111111111111111111' }
}

/**
 * Wraps raw account data in the RPC's account shape.
 *
 * @param {Uint8Array} data - The account data.
 * @returns {Object} An account value.
 */
function accountValue (data) {
  return {
    owner: SQUADS_PROGRAM_ADDRESS,
    data: [getBase64Decoder().decode(data), 'base64'],
    executable: false,
    lamports: 2039280,
    space: data.length
  }
}

/**
 * Builds a voting account with a stubbed RPC and send.
 *
 * @param {Object} [options] - The scenario.
 * @param {number} [options.mask=7] - The signer's permission mask.
 * @param {boolean} [options.isMember=true] - Whether the signer is a member.
 * @param {boolean} [options.deployed=true] - Whether the multisig exists.
 * @param {Object|null} [options.proposal] - The proposal state, or null for absent.
 * @param {bigint} [options.staleTransactionIndex=0n] - The multisig's stale index.
 * @returns {Promise<{ account: Object, sendTransaction: Function, rpc: Object }>}
 */
async function votingAccount ({
  mask = 7,
  isMember = true,
  deployed = true,
  proposal = {},
  staleTransactionIndex = 0n
} = {}) {
  const wallet = new WalletManagerMultisigSquads(TEST_SEED_PHRASE, {
    provider: TEST_RPC_URL,
    multisigPdaOrCreateKey: TEST_MULTISIG_PDA
  })
  const account = await wallet.getAccount(0)

  const members = isMember
    ? [{ address: TEST_SIGNER, mask }, { address: OTHER_MEMBER, mask: 7 }]
    : [{ address: OTHER_MEMBER, mask: 7 }]

  const rpc = stubSolanaRpc({
    getMultipleAccounts: () => ({
      context: { slot: 1 },
      value: [
        deployed
          ? multisigAccountValue(members, { threshold: 2, transactionIndex: 7n, staleTransactionIndex })
          : null,
        proposal && proposalAccountValue(proposal)
      ]
    })
  })
  const sendTransaction = jest.fn(async () => ({ hash: DUMMY_VOTE_HASH, fee: DUMMY_FEE }))

  account._signerAccount.sendTransaction = sendTransaction

  return { account, sendTransaction, rpc }
}

/**
 * Builds a configuring account with a stubbed RPC and send.
 *
 * @param {Object} [options] - The scenario.
 * @param {Array} [options.members] - The current members.
 * @param {number} [options.threshold=1] - The current threshold.
 * @param {string|null} [options.configAuthority] - A configuration authority, if controlled.
 * @param {boolean} [options.deployed=true] - Whether the multisig exists.
 * @returns {Promise<{ account: Object, sendTransaction: Function, rpc: Object }>}
 */
async function configuringAccount ({
  members = [{ address: TEST_SIGNER, mask: 7 }],
  threshold = 1,
  configAuthority = null,
  deployed = true
} = {}) {
  const wallet = new WalletManagerMultisigSquads(TEST_SEED_PHRASE, {
    provider: TEST_RPC_URL,
    multisigPdaOrCreateKey: TEST_MULTISIG_PDA
  })
  const account = await wallet.getAccount(0)

  const rpc = stubSolanaRpc({
    getAccountInfo: () => ({
      context: { slot: 1 },
      value: deployed
        ? multisigAccountValue(members, { threshold, transactionIndex: 4n, configAuthority })
        : null
    }),
    // The real rent formula: (128 + size) * 6960 lamports.
    getMinimumBalanceForRentExemption: ([size]) => (128n + BigInt(size)) * 6960n
  })

  const sendTransaction = jest.fn(async () => ({ hash: DUMMY_CONFIG_HASH, fee: DUMMY_FEE }))
  account._signerAccount.sendTransaction = sendTransaction

  return { account, sendTransaction, rpc }
}

// The eight-byte Anchor discriminators a compiled bundle is read by. Hardcoded here so a unit
// test needs no SDK; the integration suite builds its bundles with `@sqds/multisig` instead, so a
// drift between these and the protocol's fails there.
const APPROVE_DISCRIMINATOR = [144, 37, 164, 136, 188, 216, 42, 248]
const VAULT_EXECUTE_DISCRIMINATOR = [194, 8, 161, 87, 153, 164, 25, 171]

// What the account charges a bundle it broadcasts, when the cluster cannot price the message: the
// base fee per signature slot. `BUNDLE_FEE` is what a cluster that can price it answers, and is
// deliberately not a multiple of the base fee so a computed number cannot pass for a quoted one.
const SIGNATURE_FEE = 5000n
const BUNDLE_FEE = 17_320n

// The lookup table a compressing coordinator borrows the multisig and proposal from.
const ADDRESS_LOOKUP_TABLE_PROGRAM = 'AddressLookupTab1e1111111111111111111111111'
const TEST_LOOKUP_TABLE = 'BSTq9w3kZwNwpBXJEvTZz2G9ZTNyKBvoSeXMvwb4cNZr'

const BUNDLE_BLOCKHASH = {
  blockhash: 'GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi',
  lastValidBlockHeight: 999n
}

/**
 * A `proposalApprove` as the account builds it, so a bundle carrying one decodes the way the
 * account expects: the multisig read-only, the member as a writable signer, the proposal writable.
 *
 * @param {string} member - The approving member.
 * @param {string} [proposalPda] - The proposal it approves (default: the one at index 3).
 * @returns {Object} The instruction.
 */
function approvalOf (member, proposalPda = TEST_PROPOSAL_PDA_3) {
  return {
    programAddress: SQUADS_PROGRAM_ADDRESS,
    accounts: [
      { address: TEST_MULTISIG_PDA, role: AccountRole.READONLY },
      { address: member, role: AccountRole.WRITABLE_SIGNER },
      { address: proposalPda, role: AccountRole.WRITABLE }
    ],
    data: new Uint8Array(APPROVE_DISCRIMINATOR)
  }
}

/**
 * A `SetComputeUnitPrice`, which a bundle may carry and which is what buys a priority fee.
 *
 * @param {bigint} microLamports - The price per compute unit.
 * @returns {Object} The instruction.
 */
function computeUnitPrice (microLamports) {
  return {
    programAddress: COMPUTE_BUDGET_PROGRAM,
    accounts: [],
    data: new Uint8Array([3, ...getU64Encoder().encode(microLamports)])
  }
}

/**
 * A System `AdvanceNonceAccount`, the one System instruction a bundle may carry: a coordinator
 * collecting from people needs a durable nonce, because a blockhash expires too soon.
 *
 * @returns {Object} The instruction.
 */
function advanceNonceAccount () {
  return {
    programAddress: SYSTEM_PROGRAM,
    accounts: [{ address: TEST_SIGNER, role: AccountRole.WRITABLE }],
    data: new Uint8Array([4, 0, 0, 0])
  }
}

/**
 * A `vaultTransactionExecute`, which is what makes a bundle report `'executed'`.
 *
 * @returns {Object} The instruction.
 */
function executionOf () {
  return {
    programAddress: SQUADS_PROGRAM_ADDRESS,
    accounts: [
      { address: TEST_MULTISIG_PDA, role: AccountRole.READONLY },
      { address: TEST_PROPOSAL_PDA_3, role: AccountRole.WRITABLE },
      { address: TEST_VAULT_PDA, role: AccountRole.READONLY }
    ],
    data: new Uint8Array(VAULT_EXECUTE_DISCRIMINATOR)
  }
}

/**
 * Compiles a bundle the way a coordinator has to: every approval it means to collect is in it
 * before the first signature, and so are the fee payer and the lifetime.
 *
 * @param {Object[]} instructions - What the bundle carries.
 * @param {string} [feePayer] - The account charged for it (default: the derived member).
 * @returns {Object} The compiled, unsigned transaction.
 */
function bundleOf (instructions, feePayer = TEST_SIGNER) {
  return compileTransaction(pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(BUNDLE_BLOCKHASH, m),
    (m) => appendTransactionMessageInstructions(instructions, m)
  ))
}

/**
 * Whether a base58 signature really is the member's over those bytes, which is what a coordinator
 * has to be able to check before it merges one into the bundle it holds.
 *
 * @param {string} address - The member the signature should be by.
 * @param {string} signature - The signature, base58 encoded.
 * @param {Uint8Array} messageBytes - The bytes it should cover.
 * @returns {Promise<boolean>} Whether it verifies.
 */
async function verifySignature (address, signature, messageBytes) {
  const key = await crypto.subtle.importKey(
    'raw', getBase58Encoder().encode(address), 'Ed25519', true, ['verify']
  )

  return await crypto.subtle.verify('Ed25519', key, getBase58Encoder().encode(signature), messageBytes)
}

/**
 * The same bundle with the given addresses moved into a lookup table, which is what a coordinator
 * does to fit more approvals under the 1232-byte transaction limit.
 *
 * @param {Object[]} instructions - What the bundle carries.
 * @param {string[]} borrowed - The addresses the table holds, in table order.
 * @returns {Object} The compiled, unsigned transaction.
 */
function compressedBundleOf (instructions, borrowed) {
  return compileTransaction(pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(TEST_SIGNER, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(BUNDLE_BLOCKHASH, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
    (m) => compressTransactionMessageUsingAddressLookupTables(m, { [TEST_LOOKUP_TABLE]: borrowed })
  ))
}

/**
 * Wraps an account value in the response envelope the RPC returns.
 *
 * @param {Object|null} value - The account, or null when it does not exist.
 * @returns {Object} The `result` field of the response.
 */
function serveValue (value) {
  return { context: { slot: 1 }, value }
}

describe('WalletAccountMultisigSquads', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  let wallet
  let account

  beforeEach(async () => {
    wallet = new WalletManagerMultisigSquads(TEST_SEED_PHRASE, {
      provider: TEST_RPC_URL,
      commitment: 'confirmed',
      multisigPdaOrCreateKey: TEST_MULTISIG_PDA
    })
    account = await wallet.getAccount(0)
  })

  it('exposes the configured multisig address', async () => {
    expect(await account.getAddress()).toBe(TEST_MULTISIG_PDA)
  })

  it('holds the multisig address in the base class, not the signer', async () => {
    expect(account._address).toBe(TEST_MULTISIG_PDA)
    expect(await account.getAddress()).toBe(TEST_MULTISIG_PDA)
    expect(await account.getSignerAddress()).toBe(TEST_SIGNER)
  })

  it('exposes the signer address', async () => {
    expect(await account.getSignerAddress()).toBe(TEST_SIGNER)
  })

  it('returns a read-only view', async () => {
    const readOnly = await account.toReadOnlyAccount()

    expect(readOnly).toBeInstanceOf(WalletAccountReadOnlyMultisigSquads)
    expect(await readOnly.getAddress()).toBe(TEST_MULTISIG_PDA)
  })

  // The copy carries no createKeySecret, so an address it cannot name here it can never name.
  it('resolves the address into a read-only view of a create-key-secret account', async () => {
    const deploying = new WalletManagerMultisigSquads(TEST_SEED_PHRASE, {
      provider: TEST_RPC_URL,
      createKeySecret: CREATE_KEY_SECRET
    })
    const readOnly = await (await deploying.getAccount(0)).toReadOnlyAccount()

    expect(await readOnly.getAddress()).toBe(DERIVED_MULTISIG_PDA)
  })

  it('refuses a read-only view of an account that names no multisig', async () => {
    const nameless = new WalletManagerMultisigSquads(TEST_SEED_PHRASE, {
      provider: TEST_RPC_URL
    })

    await expect((await nameless.getAccount(0)).toReadOnlyAccount())
      .rejects.toThrow("The account's address must be set to perform this operation.")
  })

  it('refuses a message carrying no instruction, before touching the network', async () => {
    await expect(account.propose({ instructions: [] }))
      .rejects.toThrow('A proposed transaction must carry at least one instruction.')
  })

  it('refuses a transaction that is neither arm of SolanaTransaction', async () => {
    await expect(account.propose({ value: 1n }))
      .rejects.toThrow('A proposed transaction must be either `{ to, value }` or a message carrying `instructions`.')
  })

  // The message-signing addon is optional in the shared interface, and Squads has no
  // primitive to back it, so the module leaves it out rather than stubbing it.
  it('does not expose the message-signing surface at all', () => {
    expect(account.proposeMessage).toBeUndefined()
    expect(account.approveMessageProposal).toBeUndefined()
    expect(account.getMessageProposal).toBeUndefined()
    expect(account.getMessageProposals).toBeUndefined()
  })

  // A multisig address is a PDA with no private key, so neither signing nor sending is a
  // matter of unfinished work.
  it('refuses to sign a transaction, naming the method', async () => {
    const error = await account.signTransaction({ instructions: [] }).catch((thrown) => thrown)

    expect(error).toBeInstanceOf(UnsupportedOperationError)
    expect(error.message).toBe("Method 'signTransaction(tx)' is not supported.")
  })

  it('refuses to send a transaction, naming the method', async () => {
    const error = await account.sendTransaction({ instructions: [] }).catch((thrown) => thrown)

    expect(error).toBeInstanceOf(UnsupportedOperationError)
    expect(error.message).toBe("Method 'sendTransaction(tx)' is not supported.")
  })

  it("exposes the signer's key pair, not the multisig's", async () => {
    const { privateKey, publicKey } = account.keyPair

    // The multisig has no key pair at all; this is the member key it votes with.
    expect(getBase58Decoder().decode(publicKey)).toBe(TEST_SIGNER)
    expect(privateKey).toHaveLength(32)
  })

  it('exposes the signer index and derivation path', async () => {
    expect(account.index).toBe(0)
    expect(account.path).toBe("m/44'/501'/0'/0'")
  })

  it('disposes the signer key, so the account can no longer sign', async () => {
    account.dispose()

    await expect(account.sign('hello'))
      .rejects.toThrow('The wallet account has been disposed.')
  })

  it('separates a malformed proposal from what the protocol cannot do', async () => {
    // A consumer catching ValueError to mean "my argument was wrong" must not also catch
    // "this protocol cannot do it".
    const error = await account.propose({ instructions: [] }).catch((thrown) => thrown)

    expect(error).toBeInstanceOf(ValueError)
    expect(error).not.toBeInstanceOf(UnsupportedOperationError)
  })

  describe('getCreateKey', () => {
    it('derives the create key from a 32-byte private key, synchronously', () => {
      expect(WalletAccountMultisigSquads.getCreateKey(CREATE_KEY_SECRET)).toBe(CREATE_KEY)
    })

    it('reads the create key out of a 64-byte keypair', () => {
      const keyPair = new Uint8Array(64)

      keyPair.set(getBase58Encoder().encode(CREATE_KEY_SECRET), 0)
      keyPair.set(getBase58Encoder().encode(CREATE_KEY), 32)

      expect(WalletAccountMultisigSquads.getCreateKey(keyPair)).toBe(CREATE_KEY)
    })

    it('agrees with the signer it would build', async () => {
      const signer = await WalletAccountMultisigSquads.getCreateKeySigner(CREATE_KEY_SECRET)

      expect(WalletAccountMultisigSquads.getCreateKey(CREATE_KEY_SECRET)).toBe(signer.address)
    })

    it.each([[undefined], [new Uint8Array(31)]])('refuses %s', (bad) => {
      expect(() => WalletAccountMultisigSquads.getCreateKey(bad)).toThrow(/createKeySecret/)
    })

    it('knows the multisig address at construction', async () => {
      const wallet = new WalletManagerMultisigSquads(TEST_SEED_PHRASE, {
        provider: TEST_RPC_URL,
        createKeySecret: CREATE_KEY_SECRET
      })
      const account = await wallet.getAccount(0)

      // No RPC, no await on the derivation: the constructor resolved it.
      expect(account._address).toBe(DERIVED_MULTISIG_PDA)
    })
  })

  describe('getCreateKeySigner', () => {
    it('derives the create key from a 32-byte private key', async () => {
      const { address } = await WalletAccountMultisigSquads.getCreateKeySigner(CREATE_KEY_SECRET)

      expect(address).toBe(CREATE_KEY)
    })

    it('derives the same key from the 64-byte keypair', async () => {
      const signer = await WalletAccountMultisigSquads.getCreateKeySigner(CREATE_KEY_SECRET)
      const keyPair = new Uint8Array(64)

      keyPair.set(new Uint8Array(32).fill(9), 0)
      keyPair.set(getBase58Encoder().encode(signer.address), 32)

      const { address } = await WalletAccountMultisigSquads.getCreateKeySigner(keyPair)

      expect(address).toBe(CREATE_KEY)
    })

    it('refuses a missing secret', async () => {
      await expect(WalletAccountMultisigSquads.getCreateKeySigner(undefined))
        .rejects.toThrow('A `createKeySecret` is required to create a multisig. Provide it in the configuration.')
    })

    it('refuses a secret of the wrong length', async () => {
      await expect(WalletAccountMultisigSquads.getCreateKeySigner(new Uint8Array(31)))
        .rejects.toThrow('Invalid createKeySecret of 31 bytes. Expected 32 or 64.')
    })

    it('refuses what the address derivation refuses, with the same message', async () => {
      const short = new Uint8Array(31)
      const message = 'Invalid createKeySecret of 31 bytes. Expected 32 or 64.'

      expect(() => WalletAccountMultisigSquads.getCreateKey(short)).toThrow(message)
      await expect(WalletAccountMultisigSquads.getCreateKeySigner(short)).rejects.toThrow(message)
    })
  })

  describe('deploy', () => {
    // Program-derived, so identical on every cluster.
    const PROGRAM_CONFIG_PDA = 'BSTq9w3kZwNwpBXJEvTZz2G9ZTNyKBvoSeXMvwb4cNZr'

    /**
     * Builds a deploying account whose RPC and send are stubbed.
     *
     * @param {Object} [options] - The scenario.
     * @param {boolean} [options.deployed=false] - Whether the multisig already exists.
     * @param {Object} [options.config] - Extra configuration.
     * @returns {Promise<{ account: Object, sendTransaction: Function, rpc: Object }>}
     */
    async function deployingAccount ({ deployed = false, config = {} } = {}) {
      const wallet = new WalletManagerMultisigSquads(TEST_SEED_PHRASE, {
        provider: TEST_RPC_URL,
        createKeySecret: CREATE_KEY_SECRET,
        ...config
      })
      const account = await wallet.getAccount(0)

      // ProgramConfig: discriminator(8) authority(32) creationFee(u64) treasury(32) reserved(64)
      const programConfig = new Uint8Array(144)
      programConfig.set([196, 210, 90, 231, 144, 149, 140, 63], 0)
      programConfig.set(getBase58Encoder().encode(OTHER_MEMBER), 48)

      const programConfigValue = {
        owner: SQUADS_PROGRAM_ADDRESS,
        data: [getBase64Decoder().decode(programConfig), 'base64'],
        executable: false,
        lamports: 1893120,
        space: 144
      }

      const multisigValue = deployed ? multisigAccountValue([{ address: TEST_SIGNER }]) : null

      const rpc = stubSolanaRpc({
        getAccountInfo: ([queried]) =>
          serveValue(queried === PROGRAM_CONFIG_PDA ? programConfigValue : multisigValue),
        getMinimumBalanceForRentExemption: () => 2039280
      })

      const sendTransaction = jest.fn(async () => ({ hash: DUMMY_DEPLOY_HASH, fee: DUMMY_FEE }))
      account._signerAccount.sendTransaction = sendTransaction

      return { account, sendTransaction, rpc }
    }

    it('sends six accounts with createKey and creator as signers', async () => {
      const { account, sendTransaction } = await deployingAccount()

      await account.deploy()

      const [{ instructions }] = sendTransaction.mock.calls[0]
      const [instruction] = instructions

      expect(instruction.accounts).toHaveLength(6)
      expect(instruction.accounts.map((a) => a.role)).toEqual([0, 1, 1, 2, 3, 0])
      // The createKey must carry a signer for that same key, so kit signs the creation with it.
      expect(instruction.accounts[3].address).toBe(CREATE_KEY)
      expect(instruction.accounts[3].signer.address).toBe(CREATE_KEY)
      expect(instruction.accounts[4].address).toBe(TEST_SIGNER)
      expect(instruction.programAddress).toBe(SQUADS_PROGRAM_ADDRESS)
    })

    it('charges a configured rentPayer for the creation rather than the signer', async () => {
      const { account, sendTransaction } = await deployingAccount({
        config: { rentPayer: OTHER_MEMBER }
      })

      await account.deploy()

      const [{ instructions }] = sendTransaction.mock.calls[0]
      const [instruction] = instructions

      expect(instruction.accounts).toHaveLength(6)
      expect(instruction.accounts.map((a) => a.role)).toEqual([0, 1, 1, 2, 3, 0])
      expect(instruction.accounts[4].address).toBe(OTHER_MEMBER)
    })

    it('defaults to the signer alone with threshold 1', async () => {
      const { account, sendTransaction } = await deployingAccount()

      await account.deploy()

      const [{ instructions }] = sendTransaction.mock.calls[0]
      const data = instructions[0].data

      expect(data).toHaveLength(54)
      // threshold u16 at offset 9, member count u32 at 11
      expect(new DataView(data.buffer).getUint16(9, true)).toBe(1)
      expect(new DataView(data.buffer).getUint32(11, true)).toBe(1)
    })

    it('returns the transaction hash', async () => {
      const { account } = await deployingAccount()

      expect(await account.deploy()).toEqual({ hash: DUMMY_DEPLOY_HASH })
    })

    it('resolves the multisig address from createKeySecret alone', async () => {
      const { account } = await deployingAccount()

      // No identity configured, only the secret.
      await expect(account.getAddress()).resolves.toBe(DERIVED_MULTISIG_PDA)
    })

    it('throws without a createKeySecret', async () => {
      const wallet = new WalletManagerMultisigSquads(TEST_SEED_PHRASE, {
        provider: TEST_RPC_URL,
        multisigPdaOrCreateKey: TEST_MULTISIG_PDA
      })
      const account = await wallet.getAccount(0)

      await expect(account.deploy()).rejects.toThrow(/createKeySecret. is required/)
    })

    it('reads the program config once', async () => {
      const { account, rpc } = await deployingAccount()

      await account.deploy()

      const reads = rpcRequests(rpc, 'getAccountInfo')
        .filter(([queried]) => queried === PROGRAM_CONFIG_PDA)

      expect(reads).toHaveLength(1)
    })

    it('throws when the multisig already exists', async () => {
      const { account, sendTransaction } = await deployingAccount({ deployed: true })

      await expect(account.deploy()).rejects.toThrow(/already exists/)
      expect(sendTransaction).not.toHaveBeenCalled()
    })

    it('refuses more owners than the program can hold', async () => {
      const { account, sendTransaction } = await deployingAccount()
      const owners = Array.from({ length: 65536 }, (_unused, index) => `owner-${index}`)

      await expect(account.deploy(owners, 1))
        .rejects.toThrow('Invalid member count 65536. It must be an integer between 1 and 65535.')
      expect(sendTransaction).not.toHaveBeenCalled()
    })

    it('rejects invalid owners and thresholds without sending', async () => {
      const { account, sendTransaction } = await deployingAccount()

      await expect(account.deploy([], 1)).rejects.toThrow(/At least one owner/)
      await expect(account.deploy([TEST_SIGNER, TEST_SIGNER], 1)).rejects.toThrow(/must be unique/)
      await expect(account.deploy([TEST_SIGNER], 0)).rejects.toThrow(/Invalid threshold/)
      await expect(account.deploy([TEST_SIGNER], 2)).rejects.toThrow(/Invalid threshold/)
      await expect(account.deploy(['nope'], 1)).rejects.toThrow(/Expected base58-encoded address string of length in the range \[32, 44\]/)
      expect(sendTransaction).not.toHaveBeenCalled()
    })

    it('refuses when the quote exceeds createMaxFee', async () => {
      const { account, sendTransaction } = await deployingAccount({
        config: { createMaxFee: 1000n }
      })

      await expect(account.deploy()).rejects.toThrow(MaximumFeeExceededError)
      await expect(account.deploy()).rejects.toThrow(/maximum fee/)
      expect(sendTransaction).not.toHaveBeenCalled()
    })

    it('accepts a quote exactly equal to createMaxFee', async () => {
      // The cap is a maximum, so the boundary itself is allowed.
      const { account: quoting } = await deployingAccount()
      const { fee } = await quoting.quoteDeploy()

      const { account, sendTransaction } = await deployingAccount({
        config: { createMaxFee: fee }
      })

      expect(await account.deploy()).toEqual({ hash: DUMMY_DEPLOY_HASH })
      expect(sendTransaction).toHaveBeenCalledTimes(1)
    })

    it('throws when a configured address does not match the createKeySecret', async () => {
      const { account } = await deployingAccount({
        config: { multisigPdaOrCreateKey: TEST_MULTISIG_PDA }
      })

      await expect(account.deploy()).rejects.toThrow(/does not derive from/)
    })

    it('throws when a configured create key does not match the createKeySecret', async () => {
      const { account } = await deployingAccount({
        config: { multisigPdaOrCreateKey: OTHER_MEMBER }
      })

      await expect(account.deploy()).rejects.toThrow(/does not derive from/)
    })

    it('accepts the create key the secret derives, configured alongside it', async () => {
      const { account, sendTransaction } = await deployingAccount({
        config: { multisigPdaOrCreateKey: CREATE_KEY }
      })

      expect(await account.deploy()).toEqual({ hash: DUMMY_DEPLOY_HASH })
      expect(sendTransaction).toHaveBeenCalledTimes(1)
    })

    it('accepts the address the secret derives, configured alongside it', async () => {
      const { account, sendTransaction } = await deployingAccount({
        config: { multisigPdaOrCreateKey: DERIVED_MULTISIG_PDA }
      })

      expect(await account.deploy()).toEqual({ hash: DUMMY_DEPLOY_HASH })
      expect(sendTransaction).toHaveBeenCalledTimes(1)
    })
  })

  it('still signs with the member key', async () => {
    // sign() is the one message operation that works — one member's consent. Ed25519 is
    // deterministic, so TEST_SIGNER signing 'hello' is this exact signature.
    expect(await account.sign('hello')).toBe(
      '484d6ed3113c38833d66d9fc6e4f31f9e71f146c781739ce8103a9ea6d671f92' +
      '63dd43b53be7f9dddfafed4d671fbd6e64b0c1599fdfa68a8f8e8d73b49e780c'
    )
  })

  describe('propose', () => {
    const TX = { to: OTHER_MEMBER, value: 100000n }

    /**
     * Builds a proposing account with a stubbed RPC and send.
     *
     * @param {Object} [options] - The scenario.
     * @param {number} [options.mask=7] - The signer's permission mask.
     * @param {bigint} [options.transactionIndex=0n] - The multisig's current index.
     * @param {boolean} [options.isMember=true] - Whether the signer is a member.
     * @param {boolean} [options.deployed=true] - Whether the multisig exists.
     * @returns {Promise<{ account: Object, sendTransaction: Function, getAccountInfo: Function }>}
     */
    async function proposingAccount ({
      mask = 7,
      transactionIndex = 0n,
      isMember = true,
      deployed = true,
      threshold = 2,
      timeLock = 0,
      config = {}
    } = {}) {
      const wallet = new WalletManagerMultisigSquads(TEST_SEED_PHRASE, {
        provider: TEST_RPC_URL,
        multisigPdaOrCreateKey: TEST_MULTISIG_PDA,
        ...config
      })
      const account = await wallet.getAccount(0)

      const members = isMember
        ? [{ address: TEST_SIGNER, mask }]
        : [{ address: OTHER_MEMBER, mask: 7 }]

      const rpc = stubSolanaRpc({
        getAccountInfo: () => serveValue(
          deployed ? multisigAccountValue(members, { threshold, transactionIndex, timeLock }) : null
        ),
        // The real rent formula: (128 + size) * 6960 lamports.
        getMinimumBalanceForRentExemption: ([size]) => (128n + BigInt(size)) * 6960n
      })
      const sendTransaction = jest.fn(async () => ({ hash: DUMMY_PROPOSE_HASH, fee: DUMMY_FEE }))

      account._signerAccount.sendTransaction = sendTransaction

      return { account, sendTransaction, rpc }
    }

    it('creates the transaction and its proposal in one transaction', async () => {
      const { account, sendTransaction } = await proposingAccount()

      await account.propose(TX)

      const [{ instructions }] = sendTransaction.mock.calls[0]

      expect(sendTransaction).toHaveBeenCalledTimes(1)
      expect(instructions).toHaveLength(2)
      expect(Array.from(instructions[0].data.slice(0, 8)))
        .toEqual([48, 250, 78, 168, 208, 226, 218, 211])
      expect(Array.from(instructions[1].data.slice(0, 8)))
        .toEqual([220, 60, 73, 224, 30, 108, 79, 159])
    })

    it('puts the signer in both the creator and the rent payer slot by default', async () => {
      const { account, sendTransaction } = await proposingAccount()

      await account.propose(TX)

      const [{ instructions }] = sendTransaction.mock.calls[0]

      for (const { accounts } of instructions) {
        expect(accounts[2]).toEqual({ address: TEST_SIGNER, role: 3 })
        expect(accounts[3]).toEqual({ address: TEST_SIGNER, role: 3 })
      }
    })

    it('keeps the signer as creator and charges a configured rentPayer for the rent', async () => {
      const { account, sendTransaction } = await proposingAccount({
        config: { rentPayer: OTHER_MEMBER }
      })

      await account.propose(TX)

      const [{ instructions }] = sendTransaction.mock.calls[0]

      for (const { accounts } of instructions) {
        expect(accounts[2]).toEqual({ address: TEST_SIGNER, role: 2 })
        expect(accounts[3]).toEqual({ address: OTHER_MEMBER, role: 3 })
      }
    })

    it('proposes at the next transaction index', async () => {
      const { account, sendTransaction } = await proposingAccount({ transactionIndex: 41n })

      const result = await account.propose(TX)
      const [{ instructions }] = sendTransaction.mock.calls[0]
      const data = instructions[1].data

      expect(result.proposalId).toBe('42')
      expect(new DataView(data.buffer).getBigUint64(8, true)).toBe(42n)
    })

    it('opens the proposal for voting rather than as a draft', async () => {
      const { account, sendTransaction } = await proposingAccount()

      await account.propose(TX)

      const [{ instructions }] = sendTransaction.mock.calls[0]

      // draft is the byte after the u64 index
      expect(instructions[1].data[16]).toBe(0)
    })

    it('records a memo on the transaction it creates', async () => {
      const { account, sendTransaction } = await proposingAccount()

      await account.propose(TX, { memo: 'ok' })

      const [{ instructions }] = sendTransaction.mock.calls[0]

      expect(Array.from(instructions[0].data.slice(-7))).toEqual([1, 2, 0, 0, 0, 111, 107])
    })

    it('writes an absent memo when none is given', async () => {
      const { account, sendTransaction } = await proposingAccount()

      await account.propose(TX)

      const [{ instructions }] = sendTransaction.mock.calls[0]

      expect(Array.from(instructions[0].data.slice(-1))).toEqual([0])
    })

    it('throws on a non-string memo', async () => {
      const { account, sendTransaction } = await proposingAccount()

      await expect(account.propose(TX, { memo: 42 })).rejects.toThrow(/must be a string/)
      expect(sendTransaction).not.toHaveBeenCalled()
    })

    it('reports the fee its own quote reports', async () => {
      const { account } = await proposingAccount({ threshold: 1 })

      const { fee: quoted } = await account.quotePropose(TX)
      const { transaction: { fee: charged } } = await account.propose(TX)

      // The quote assumes one signature, which is what the stub charges, so the two agree.
      expect(charged).toBe(quoted)
      expect(charged).toBe(4480280n)
    })

    it('returns the proposal with no confirmations of its own', async () => {
      const { account } = await proposingAccount()

      expect(await account.propose(TX)).toEqual({
        proposalId: '1',
        // DUMMY_FEE + rent for a 221 B vault transaction and a 166 B proposal.
        confirmations: 0,
        pendingConfirmations: 0,
        threshold: 2,
        status: 'pending',
        transaction: { hash: DUMMY_PROPOSE_HASH, fee: 4480280n }
      })
    })

    it('reads the multisig once for both index and threshold', async () => {
      const { account, rpc } = await proposingAccount()

      await account.propose(TX)

      expect(rpcRequests(rpc, 'getAccountInfo')).toEqual([[TEST_MULTISIG_PDA, { commitment: 'confirmed', encoding: 'base64' }]])
    })

    it('throws when the signer cannot propose', async () => {
      // Mask 2 is vote-only: a member, but without the permission to initiate.
      const { account, sendTransaction } = await proposingAccount({ mask: 2 })

      await expect(account.propose(TX)).rejects.toThrow(AccountNotOwnerError)
      await expect(account.propose(TX)).rejects.toThrow(/does not hold the permission/)
      expect(sendTransaction).not.toHaveBeenCalled()
    })

    it('throws when the signer is not a member', async () => {
      const { account } = await proposingAccount({ isMember: false })

      await expect(account.propose(TX)).rejects.toThrow(/not a member/)
    })

    it('throws when the multisig does not exist', async () => {
      const { account } = await proposingAccount({ deployed: false })

      await expect(account.propose(TX)).rejects.toThrow(/does not exist/)
    })

    describe('autoExecute', () => {
      it('approves and executes in the same transaction', async () => {
        const { account, sendTransaction } = await proposingAccount({ threshold: 1 })

        const result = await account.propose(TX, { autoExecute: true })
        const [{ instructions }] = sendTransaction.mock.calls[0]

        expect(sendTransaction).toHaveBeenCalledTimes(1)
        expect(instructions).toHaveLength(4)
        expect(Array.from(instructions[2].data.slice(0, 8)))
          .toEqual([144, 37, 164, 136, 188, 216, 42, 248])
        expect(Array.from(instructions[3].data))
          .toEqual([194, 8, 161, 87, 153, 164, 25, 171])
        expect(result).toEqual({
          proposalId: '1',
          confirmations: 1,
          pendingConfirmations: 0,
          threshold: 1,
          status: 'executed',
          transaction: { hash: DUMMY_PROPOSE_HASH, fee: 4480280n }
        })
      })

      it('appends the message accounts to the execute instruction', async () => {
        const { account, sendTransaction } = await proposingAccount({ threshold: 1 })

        await account.propose(TX, { autoExecute: true })

        const [{ instructions }] = sendTransaction.mock.calls[0]
        const remaining = instructions[3].accounts.slice(4)

        // The vault is writable but never a signer: the program signs for it.
        expect(remaining.map((a) => a.address)).toContain(TEST_VAULT_PDA)
        expect(remaining.find((a) => a.address === TEST_VAULT_PDA).role).toBe(1)
      })

      it('needs no extra RPC call', async () => {
        const { account, rpc } = await proposingAccount({ threshold: 1 })

        await account.propose(TX, { autoExecute: true })

        expect(rpcRequests(rpc, 'getAccountInfo')).toEqual([[TEST_MULTISIG_PDA, { commitment: 'confirmed', encoding: 'base64' }]])
      })

      it.each([
        ['the threshold is above 1', { threshold: 2 }],
        ['a time lock is set', { threshold: 1, timeLock: 60 }],
        ['the signer cannot vote', { threshold: 1, mask: 5 }],
        ['the signer cannot execute', { threshold: 1, mask: 3 }]
      ])('ignores the flag when %s', async (_label, options) => {
        const { account, sendTransaction } = await proposingAccount(options)

        const result = await account.propose(TX, { autoExecute: true })
        const [{ instructions }] = sendTransaction.mock.calls[0]

        // A request, not an assertion: propose only, and say so. The threshold is the one the
        // case configured, since the result reports the multisig's own.
        expect(instructions).toHaveLength(2)
        expect(result).toEqual({
          proposalId: '1',
          confirmations: 0,
          pendingConfirmations: 0,
          threshold: options.threshold,
          status: 'pending',
          transaction: { hash: DUMMY_PROPOSE_HASH, fee: 4480280n }
        })
      })

      it('proposes only when the flag is absent', async () => {
        const { account, sendTransaction } = await proposingAccount({ threshold: 1 })

        const result = await account.propose(TX)

        expect(sendTransaction.mock.calls[0][0].instructions).toHaveLength(2)
        expect(result).toEqual({
          proposalId: '1',
          confirmations: 0,
          pendingConfirmations: 0,
          threshold: 1,
          status: 'pending',
          transaction: { hash: DUMMY_PROPOSE_HASH, fee: 4480280n }
        })
      })
    })
  })

  describe('approveProposal', () => {
    it('sends a single proposalApprove instruction', async () => {
      const { account, sendTransaction } = await votingAccount()

      await account.approveProposal(3)

      const [{ instructions }] = sendTransaction.mock.calls[0]

      expect(instructions).toHaveLength(1)
      expect(Array.from(instructions[0].data))
        .toEqual([144, 37, 164, 136, 188, 216, 42, 248, 0])
      expect(instructions[0].accounts).toEqual(VOTE_ACCOUNTS)
    })

    it('addresses the proposal at the given index', async () => {
      const { account, sendTransaction, rpc } = await votingAccount()

      await account.approveProposal(3)

      const [[queried]] = rpcRequests(rpc, 'getMultipleAccounts')[0]
      const [{ instructions }] = sendTransaction.mock.calls[0]

      expect(queried).toBe(TEST_MULTISIG_PDA)
      expect(instructions[0].accounts[2].address).toBe(TEST_PROPOSAL_PDA_3)
    })

    it('carries a memo when one is given', async () => {
      const { account, sendTransaction } = await votingAccount()

      await account.approveProposal(3, { memo: 'ok' })

      const [{ instructions }] = sendTransaction.mock.calls[0]

      expect(Array.from(instructions[0].data.slice(8)))
        .toEqual([1, 2, 0, 0, 0, 111, 107])
    })

    it('counts the approval it is about to add', async () => {
      const { account } = await votingAccount({ proposal: { approved: [OTHER_MEMBER] } })

      expect(await account.approveProposal(3)).toEqual({
        proposalId: '3',
        confirmations: 2,
        pendingConfirmations: 0,
        threshold: 2,
        status: 'pending',
        transaction: { hash: DUMMY_VOTE_HASH, fee: DUMMY_FEE }
      })
    })

    it('reads the multisig and the proposal in one request', async () => {
      const { account, rpc } = await votingAccount()

      await account.approveProposal(3)

      expect(rpcRequests(rpc, 'getMultipleAccounts'))
        .toEqual([[[TEST_MULTISIG_PDA, TEST_PROPOSAL_PDA_3], { commitment: 'confirmed', encoding: 'base64' }]])
    })

    it('lets a member switch a rejection to an approval', async () => {
      const { account, sendTransaction } = await votingAccount({
        proposal: { rejected: [TEST_SIGNER] }
      })

      await expect(account.approveProposal(3)).resolves.toEqual({
        proposalId: '3',
        confirmations: 1,
        pendingConfirmations: 0,
        threshold: 2,
        status: 'pending',
        transaction: { hash: DUMMY_VOTE_HASH, fee: DUMMY_FEE }
      })
      expect(sendTransaction).toHaveBeenCalledTimes(1)
    })

    it('refuses a second approval from the same member', async () => {
      const { account, sendTransaction } = await votingAccount({
        proposal: { approved: [TEST_SIGNER] }
      })

      await expect(account.approveProposal(3)).rejects.toThrow(/already approved/)
      expect(sendTransaction).not.toHaveBeenCalled()
    })

    it('throws when the signer cannot vote', async () => {
      // Mask 5 is propose plus execute: a member, but unable to vote.
      const { account, sendTransaction } = await votingAccount({ mask: 5 })

      await expect(account.approveProposal(3)).rejects.toThrow(/does not hold the permission/)
      expect(sendTransaction).not.toHaveBeenCalled()
    })

    it('throws when the signer is not a member', async () => {
      const { account } = await votingAccount({ isMember: false })

      await expect(account.approveProposal(3)).rejects.toThrow(/not a member/)
    })

    it('throws when the multisig does not exist', async () => {
      const { account } = await votingAccount({ deployed: false })

      await expect(account.approveProposal(3)).rejects.toThrow(/does not exist/)
    })

    it('throws when the proposal does not exist', async () => {
      const { account } = await votingAccount({ proposal: null })

      await expect(account.approveProposal(3)).rejects.toThrow(/no proposal at index 3/)
    })

    it.each([
      ['a draft', 0, /is a draft/],
      ['rejected', 2, /is rejected/],
      ['approved', 3, /is approved/],
      ['executing', 4, /is executing/],
      ['executed', 5, /is executed/],
      ['cancelled', 6, /is cancelled/]
    ])('names the status when the proposal is %s', async (_label, status, message) => {
      const { account, sendTransaction } = await votingAccount({ proposal: { status } })

      await expect(account.approveProposal(3)).rejects.toThrow(message)
      expect(sendTransaction).not.toHaveBeenCalled()
    })

    it('throws when the proposal has gone stale', async () => {
      const { account, sendTransaction } = await votingAccount({ staleTransactionIndex: 3n })

      await expect(account.approveProposal(3)).rejects.toThrow(/invalidated/)
      expect(sendTransaction).not.toHaveBeenCalled()
    })

    it('throws on an invalid proposal id before any RPC call', async () => {
      const { account, rpc } = await votingAccount()

      await expect(account.approveProposal(-1)).rejects.toThrow(/Invalid proposal id/)
      expect(rpcRequests(rpc, 'getMultipleAccounts')).toHaveLength(0)
    })

    it('throws on a non-string memo', async () => {
      const { account, sendTransaction } = await votingAccount()

      await expect(account.approveProposal(3, { memo: 42 })).rejects.toThrow(/must be a string/)
      expect(sendTransaction).not.toHaveBeenCalled()
    })

    describe('autoExecute', () => {
      const TEST_TRANSACTION_PDA_3 = '5PzeP4ZwkPPmZiYC98mZFzWnfcNxSCEudToHCzB9kXDG'
      const CLOCK_SYSVAR = 'SysvarC1ock11111111111111111111111111111111'
      const VAULT_EXECUTE_DISCRIMINATOR = [194, 8, 161, 87, 153, 164, 25, 171]
      const CONFIG_EXECUTE_DISCRIMINATOR = [114, 146, 244, 189, 252, 140, 36, 40]

      /**
       * Builds a voting account whose one read also serves the transaction and the clock.
       *
       * @param {Object} [options] - The scenario.
       * @param {number} [options.mask=7] - The signer's permission mask.
       * @param {number} [options.threshold=2] - The multisig's threshold.
       * @param {string[]} [options.approved] - The members that have already approved.
       * @param {number} [options.timeLock=0] - The multisig's time lock, in seconds.
       * @param {Object} [options.transaction] - The backing transaction account.
       * @returns {Promise<{ account: Object, sendTransaction: Function, rpc: Object }>}
       */
      async function autoExecutingAccount ({
        mask = 7,
        threshold = 2,
        approved = [OTHER_MEMBER],
        timeLock = 0,
        transaction = vaultTransactionAccountValue()
      } = {}) {
        const wallet = new WalletManagerMultisigSquads(TEST_SEED_PHRASE, {
          provider: TEST_RPC_URL,
          multisigPdaOrCreateKey: TEST_MULTISIG_PDA
        })
        const account = await wallet.getAccount(0)
        const members = [{ address: TEST_SIGNER, mask }, { address: OTHER_MEMBER, mask: 7 }]

        const rpc = stubSolanaRpc({
          getMultipleAccounts: () => ({
            context: { slot: 1 },
            value: [
              multisigAccountValue(members, { threshold, transactionIndex: 7n, timeLock }),
              proposalAccountValue({ approved }),
              transaction,
              clockAccountValue(0n)
            ]
          })
        })
        const sendTransaction = jest.fn(async () => ({ hash: DUMMY_VOTE_HASH, fee: DUMMY_FEE }))

        account._signerAccount.sendTransaction = sendTransaction

        return { account, sendTransaction, rpc }
      }

      it('approves and executes in one transaction when the vote reaches the threshold', async () => {
        const { account, sendTransaction } = await autoExecutingAccount()

        const result = await account.approveProposal(3, { autoExecute: true })
        const [{ instructions }] = sendTransaction.mock.calls[0]

        expect(sendTransaction).toHaveBeenCalledTimes(1)
        expect(instructions).toHaveLength(2)
        expect(Array.from(instructions[1].data)).toEqual(VAULT_EXECUTE_DISCRIMINATOR)
        expect(result).toEqual({
          proposalId: '3',
          confirmations: 2,
          pendingConfirmations: 0,
          threshold: 2,
          status: 'executed',
          transaction: { hash: DUMMY_VOTE_HASH, fee: DUMMY_FEE }
        })
      })

      it('executes a config transaction the same way', async () => {
        const { account, sendTransaction } = await autoExecutingAccount({
          transaction: configTransactionAccountValue(['ChangeThreshold'])
        })

        const result = await account.approveProposal(3, { autoExecute: true })
        const [{ instructions }] = sendTransaction.mock.calls[0]

        expect(Array.from(instructions[1].data)).toEqual(CONFIG_EXECUTE_DISCRIMINATOR)
        expect(result.status).toBe('executed')
      })

      it('reads the transaction and the clock alongside the proposal', async () => {
        const { account, rpc } = await autoExecutingAccount()

        await account.approveProposal(3, { autoExecute: true })

        expect(rpcRequests(rpc, 'getMultipleAccounts')).toEqual([[
          [TEST_MULTISIG_PDA, TEST_PROPOSAL_PDA_3, TEST_TRANSACTION_PDA_3, CLOCK_SYSVAR],
          { commitment: 'confirmed', encoding: 'base64' }
        ]])
      })

      it('goes inert when the vote does not reach the threshold', async () => {
        const { account, sendTransaction } = await autoExecutingAccount({
          threshold: 3,
          approved: []
        })

        const result = await account.approveProposal(3, { autoExecute: true })
        const [{ instructions }] = sendTransaction.mock.calls[0]

        expect(instructions).toHaveLength(1)
        expect(result.status).toBe('pending')
        expect(result.confirmations).toBe(1)
      })

      it('goes inert under a time lock', async () => {
        const { account, sendTransaction } = await autoExecutingAccount({ timeLock: 60 })

        const result = await account.approveProposal(3, { autoExecute: true })
        const [{ instructions }] = sendTransaction.mock.calls[0]

        expect(instructions).toHaveLength(1)
        expect(result.status).toBe('pending')
      })

      it('goes inert when the transaction account has been closed', async () => {
        const { account, sendTransaction } = await autoExecutingAccount({ transaction: null })

        const result = await account.approveProposal(3, { autoExecute: true })
        const [{ instructions }] = sendTransaction.mock.calls[0]

        expect(instructions).toHaveLength(1)
        expect(result.status).toBe('pending')
      })

      it('goes inert when the signer holds no execute permission', async () => {
        const { account, sendTransaction } = await autoExecutingAccount({ mask: 3 })

        const result = await account.approveProposal(3, { autoExecute: true })
        const [{ instructions }] = sendTransaction.mock.calls[0]

        expect(instructions).toHaveLength(1)
        expect(result.status).toBe('pending')
      })

      it('surfaces a dead address lookup table rather than going inert', async () => {
        const TABLE = '7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2'
        const wallet = new WalletManagerMultisigSquads(TEST_SEED_PHRASE, {
          provider: TEST_RPC_URL,
          multisigPdaOrCreateKey: TEST_MULTISIG_PDA
        })
        const account = await wallet.getAccount(0)

        stubSolanaRpc({
          // The proposal's read serves four accounts; the lookup table's serves one.
          getMultipleAccounts: ([keys]) => ({
            context: { slot: 1 },
            value: keys.length === 1
              ? [null]
              : [
                  multisigAccountValue([
                    { address: TEST_SIGNER, mask: 7 }, { address: OTHER_MEMBER, mask: 7 }
                  ], { threshold: 2, transactionIndex: 7n }),
                  proposalAccountValue({ approved: [OTHER_MEMBER] }),
                  vaultTransactionAccountValue({ lookupTable: TABLE }),
                  clockAccountValue(0n)
                ]
          })
        })

        account._signerAccount.sendTransaction = jest.fn(
          async () => ({ hash: DUMMY_VOTE_HASH, fee: DUMMY_FEE })
        )

        await expect(account.approveProposal(3, { autoExecute: true }))
          .rejects.toThrow(/does not exist, so the transaction.s accounts cannot be resolved/)
        // The same approval without the flag never reads the table, so it goes through.
        await expect(account.approveProposal(3)).resolves.toMatchObject({ status: 'pending' })
      })

      it('carries the memo of the vote it executes', async () => {
        const { account, sendTransaction } = await autoExecutingAccount()

        await account.approveProposal(3, { autoExecute: true, memo: 'ok' })

        const [{ instructions }] = sendTransaction.mock.calls[0]

        expect(Array.from(instructions[0].data.slice(8))).toEqual([1, 2, 0, 0, 0, 111, 107])
        expect(instructions).toHaveLength(2)
      })
    })
  })

  describe('rejectProposal', () => {
    it('sends a single proposalReject instruction', async () => {
      const { account, sendTransaction } = await votingAccount()

      await account.rejectProposal(3)

      const [{ instructions }] = sendTransaction.mock.calls[0]

      expect(instructions).toHaveLength(1)
      expect(Array.from(instructions[0].data))
        .toEqual([243, 62, 134, 156, 230, 106, 246, 135, 0])
    })

    it('sends the vote over the multisig, the member and the proposal', async () => {
      const { account, sendTransaction } = await votingAccount()

      await account.rejectProposal(3)

      const [{ instructions }] = sendTransaction.mock.calls[0]

      // The same three accounts an approval carries, in the same roles.
      expect(instructions[0].accounts).toEqual(VOTE_ACCOUNTS)
    })

    it('carries a memo when one is given', async () => {
      const { account, sendTransaction } = await votingAccount()

      await account.rejectProposal(3, { memo: 'ok' })

      const [{ instructions }] = sendTransaction.mock.calls[0]

      expect(Array.from(instructions[0].data.slice(8)))
        .toEqual([1, 2, 0, 0, 0, 111, 107])
    })

    it('leaves confirmations alone when the signer had not voted', async () => {
      const { account } = await votingAccount({ proposal: { approved: [OTHER_MEMBER] } })

      expect(await account.rejectProposal(3)).toEqual({
        proposalId: '3',
        confirmations: 1,
        pendingConfirmations: 0,
        threshold: 2,
        status: 'pending',
        transaction: { hash: DUMMY_VOTE_HASH, fee: DUMMY_FEE }
      })
    })

    it('decrements confirmations when the signer had approved', async () => {
      // The rejection withdraws the prior approval, so the count goes down, not up.
      const { account } = await votingAccount({
        proposal: { approved: [TEST_SIGNER, OTHER_MEMBER] }
      })

      await expect(account.rejectProposal(3)).resolves.toEqual({
        proposalId: '3',
        confirmations: 1,
        pendingConfirmations: 0,
        threshold: 2,
        status: 'pending',
        transaction: { hash: DUMMY_VOTE_HASH, fee: DUMMY_FEE }
      })
    })

    it('reports no confirmations when the signer was the only approver', async () => {
      const { account } = await votingAccount({ proposal: { approved: [TEST_SIGNER] } })

      await expect(account.rejectProposal(3)).resolves.toEqual({
        proposalId: '3',
        confirmations: 0,
        pendingConfirmations: 0,
        threshold: 2,
        status: 'pending',
        transaction: { hash: DUMMY_VOTE_HASH, fee: DUMMY_FEE }
      })
    })

    it('lets a member switch an approval to a rejection', async () => {
      const { account, sendTransaction } = await votingAccount({
        proposal: { approved: [TEST_SIGNER] }
      })

      await expect(account.rejectProposal(3)).resolves.toEqual({
        proposalId: '3',
        confirmations: 0,
        pendingConfirmations: 0,
        threshold: 2,
        status: 'pending',
        transaction: { hash: DUMMY_VOTE_HASH, fee: DUMMY_FEE }
      })
      expect(sendTransaction).toHaveBeenCalledTimes(1)
    })

    it('refuses a second rejection from the same member', async () => {
      const { account, sendTransaction } = await votingAccount({
        proposal: { rejected: [TEST_SIGNER] }
      })

      await expect(account.rejectProposal(3)).rejects.toThrow(/already rejected/)
      expect(sendTransaction).not.toHaveBeenCalled()
    })

    it('reads the multisig and the proposal in one request', async () => {
      const { account, rpc } = await votingAccount()

      await account.rejectProposal(3)

      expect(rpcRequests(rpc, 'getMultipleAccounts'))
        .toEqual([[[TEST_MULTISIG_PDA, TEST_PROPOSAL_PDA_3], { commitment: 'confirmed', encoding: 'base64' }]])
    })

    it('throws when the signer cannot vote', async () => {
      const { account, sendTransaction } = await votingAccount({ mask: 5 })

      await expect(account.rejectProposal(3)).rejects.toThrow(/does not hold the permission/)
      expect(sendTransaction).not.toHaveBeenCalled()
    })

    it('throws when the signer is not a member', async () => {
      const { account } = await votingAccount({ isMember: false })

      await expect(account.rejectProposal(3)).rejects.toThrow(/not a member/)
    })

    it('throws when the multisig does not exist', async () => {
      const { account } = await votingAccount({ deployed: false })

      await expect(account.rejectProposal(3)).rejects.toThrow(/does not exist/)
    })

    it('throws when the proposal does not exist', async () => {
      const { account } = await votingAccount({ proposal: null })

      await expect(account.rejectProposal(3)).rejects.toThrow(/no proposal at index 3/)
    })

    it.each([
      ['a draft', 0],
      ['approved', 3],
      ['executed', 5],
      ['cancelled', 6]
    ])('throws when the proposal is %s', async (_label, status) => {
      const { account, sendTransaction } = await votingAccount({ proposal: { status } })

      await expect(account.rejectProposal(3)).rejects.toThrow(/rather than open for voting/)
      expect(sendTransaction).not.toHaveBeenCalled()
    })

    it('throws when the proposal has gone stale', async () => {
      const { account, sendTransaction } = await votingAccount({ staleTransactionIndex: 3n })

      await expect(account.rejectProposal(3)).rejects.toThrow(/invalidated/)
      expect(sendTransaction).not.toHaveBeenCalled()
    })

    it('throws on an invalid proposal id before any RPC call', async () => {
      const { account, rpc } = await votingAccount()

      await expect(account.rejectProposal(-1)).rejects.toThrow(/Invalid proposal id/)
      expect(rpcRequests(rpc, 'getMultipleAccounts')).toHaveLength(0)
    })

    it('throws on a non-string memo', async () => {
      const { account, sendTransaction } = await votingAccount()

      await expect(account.rejectProposal(3, { memo: 42 })).rejects.toThrow(/must be a string/)
      expect(sendTransaction).not.toHaveBeenCalled()
    })

    it('ignores autoExecute, since a rejection executes nothing', async () => {
      const { account, sendTransaction, rpc } = await votingAccount()

      const result = await account.rejectProposal(3, { autoExecute: true })
      const [{ instructions }] = sendTransaction.mock.calls[0]

      expect(instructions).toHaveLength(1)
      expect(result.status).toBe('pending')
      // No transaction account and no clock: the reject path reads what it always reads.
      expect(rpcRequests(rpc, 'getMultipleAccounts')[0][0])
        .toEqual([TEST_MULTISIG_PDA, TEST_PROPOSAL_PDA_3])
    })
  })

  describe('addOwner', () => {
    it('creates the config transaction and its proposal in one transaction', async () => {
      const { account, sendTransaction } = await configuringAccount()

      await account.addOwner(OTHER_MEMBER)

      const [{ instructions }] = sendTransaction.mock.calls[0]

      expect(sendTransaction).toHaveBeenCalledTimes(1)
      expect(instructions).toHaveLength(2)
      expect(Array.from(instructions[0].data.slice(0, 8)))
        .toEqual([155, 236, 87, 228, 137, 75, 81, 39])
      expect(Array.from(instructions[1].data.slice(0, 8)))
        .toEqual([220, 60, 73, 224, 30, 108, 79, 159])
    })

    it('sends one AddMember action with full permissions', async () => {
      const { account, sendTransaction } = await configuringAccount()

      await account.addOwner(OTHER_MEMBER)

      const { data } = sendTransaction.mock.calls[0][0].instructions[0]

      expect(data).toHaveLength(47)
      expect(new DataView(data.buffer).getUint32(8, true)).toBe(1)
      expect(data[12]).toBe(0)
      expect(getBase58Decoder().decode(data.subarray(13, 45))).toBe(OTHER_MEMBER)
      expect(data[45]).toBe(7)
    })

    it.each([
      ['propose only', PERMISSION.initiate, 1],
      ['vote only', PERMISSION.vote, 2],
      ['execute only', PERMISSION.execute, 4],
      ['propose and vote', PERMISSION.initiate | PERMISSION.vote, 3],
      ['everything but the vote', PERMISSION.initiate | PERMISSION.execute, 5]
    ])('encodes a mask granting %s', async (_label, mask, encoded) => {
      const { account, sendTransaction } = await configuringAccount()

      await account.addOwner(OTHER_MEMBER, { mask })

      const { data } = sendTransaction.mock.calls[0][0].instructions[0]

      expect(data).toHaveLength(47)
      expect(getBase58Decoder().decode(data.subarray(13, 45))).toBe(OTHER_MEMBER)
      expect(data[45]).toBe(encoded)
    })

    it('adds a member holding a partial mask alongside a threshold change', async () => {
      const { account, sendTransaction } = await configuringAccount({
        members: [{ address: TEST_SIGNER, mask: 7 }, { address: OTHER_MEMBER, mask: 7 }],
        threshold: 1
      })

      await account.addOwner(THIRD_MEMBER, { mask: PERMISSION.vote, threshold: 3 })

      const { data } = sendTransaction.mock.calls[0][0].instructions[0]

      expect(data).toHaveLength(50)
      expect(new DataView(data.buffer).getUint32(8, true)).toBe(2)
      expect(data[45]).toBe(2)
      expect(new DataView(data.buffer).getUint16(47, true)).toBe(3)
    })

    it('counts a new voter towards the threshold ceiling', async () => {
      const { account } = await configuringAccount()

      await expect(account.addOwner(OTHER_MEMBER, { mask: PERMISSION.vote, threshold: 2 }))
        .resolves.toEqual({
          proposalId: '5',
          // DUMMY_FEE + rent for a 122 B config transaction (two actions) and a 166 B proposal.
          confirmations: 0,
          pendingConfirmations: 0,
          threshold: 1,
          status: 'pending',
          transaction: { hash: DUMMY_CONFIG_HASH, fee: 3791240n }
        })
    })

    it('refuses a threshold the granted mask cannot reach', async () => {
      // Adding a non-voter leaves one voter, so a threshold of 2 is impossible. It would be
      // reachable if the mask were ignored and full permissions granted instead.
      const { account, sendTransaction } = await configuringAccount()

      await expect(account.addOwner(OTHER_MEMBER, { mask: PERMISSION.initiate, threshold: 2 }))
        .rejects.toThrow(/number of owners able to vote \(1\)/)
      expect(sendTransaction).not.toHaveBeenCalled()
    })

    it.each([[0], [8], [-1], [1.5], ['7']])('refuses a mask of %s before any RPC call', async (mask) => {
      const { account, sendTransaction, rpc } = await configuringAccount()

      await expect(account.addOwner(OTHER_MEMBER, { mask })).rejects.toThrow(
        `Invalid permission mask ${mask}. It must be an integer between 1 and 7, a bitwise OR of initiate (1), vote (2) and execute (4).`
      )
      expect(rpcRequests(rpc, 'getAccountInfo')).toHaveLength(0)
      expect(sendTransaction).not.toHaveBeenCalled()
    })

    it('proposes at the next transaction index', async () => {
      const { account, sendTransaction } = await configuringAccount()

      const result = await account.addOwner(OTHER_MEMBER)
      const { data } = sendTransaction.mock.calls[0][0].instructions[1]

      expect(result.proposalId).toBe('5')
      expect(new DataView(data.buffer).getBigUint64(8, true)).toBe(5n)
    })

    it('adds a ChangeThreshold action in the same proposal', async () => {
      const { account, sendTransaction } = await configuringAccount()

      await account.addOwner(OTHER_MEMBER, { threshold: 2 })

      const [{ instructions }] = sendTransaction.mock.calls[0]
      const { data } = instructions[0]

      // Still one proposal, but two actions.
      expect(sendTransaction).toHaveBeenCalledTimes(1)
      expect(instructions).toHaveLength(2)
      expect(new DataView(data.buffer).getUint32(8, true)).toBe(2)
      expect(data).toHaveLength(50)
      expect(data[46]).toBe(2)
      expect(new DataView(data.buffer).getUint16(47, true)).toBe(2)
    })

    it('returns the proposal with no confirmations of its own', async () => {
      const { account } = await configuringAccount({ threshold: 1 })

      expect(await account.addOwner(OTHER_MEMBER)).toEqual({
        proposalId: '5',
        // DUMMY_FEE + rent for a 119 B config transaction and a 166 B proposal.
        confirmations: 0,
        pendingConfirmations: 0,
        threshold: 1,
        status: 'pending',
        transaction: { hash: DUMMY_CONFIG_HASH, fee: 3770360n }
      })
    })

    it('accepts a threshold equal to the member count after the addition', async () => {
      const { account, sendTransaction } = await configuringAccount()

      await expect(account.addOwner(OTHER_MEMBER, { threshold: 2 })).resolves.toEqual({
        proposalId: '5',
        confirmations: 0,
        pendingConfirmations: 0,
        threshold: 1,
        status: 'pending',
        transaction: { hash: DUMMY_CONFIG_HASH, fee: 3791240n }
      })
      expect(sendTransaction).toHaveBeenCalledTimes(1)
    })

    it('refuses a threshold above the member count after the addition', async () => {
      const { account, sendTransaction } = await configuringAccount()

      await expect(account.addOwner(OTHER_MEMBER, { threshold: 3 })).rejects.toThrow(/Invalid threshold/)
      expect(sendTransaction).not.toHaveBeenCalled()
    })

    it.each([[0], [-1], [1.5]])('refuses a threshold of %s', async (threshold) => {
      const { account, sendTransaction } = await configuringAccount()

      await expect(account.addOwner(OTHER_MEMBER, { threshold })).rejects.toThrow(/Invalid threshold/)
      expect(sendTransaction).not.toHaveBeenCalled()
    })

    it('refuses an address that is already a member', async () => {
      const { account, sendTransaction } = await configuringAccount({
        members: [{ address: TEST_SIGNER, mask: 7 }, { address: OTHER_MEMBER, mask: 7 }]
      })

      await expect(account.addOwner(OTHER_MEMBER)).rejects.toThrow(/already a member/)
      expect(sendTransaction).not.toHaveBeenCalled()
    })

    it('refuses a controlled multisig', async () => {
      const { account, sendTransaction } = await configuringAccount({ configAuthority: THIRD_MEMBER })

      await expect(account.addOwner(OTHER_MEMBER)).rejects.toThrow(/controlled by the configuration authority/)
      expect(sendTransaction).not.toHaveBeenCalled()
    })

    it('treats the all-zero authority as autonomous', async () => {
      const { account, sendTransaction } = await configuringAccount({ configAuthority: SYSTEM_PROGRAM })

      await expect(account.addOwner(OTHER_MEMBER)).resolves.toEqual({
        proposalId: '5',
        confirmations: 0,
        pendingConfirmations: 0,
        threshold: 1,
        status: 'pending',
        transaction: { hash: DUMMY_CONFIG_HASH, fee: 3770360n }
      })
      expect(sendTransaction).toHaveBeenCalledTimes(1)
    })

    it('throws when the signer cannot propose', async () => {
      const { account, sendTransaction } = await configuringAccount({
        members: [{ address: TEST_SIGNER, mask: 2 }]
      })

      await expect(account.addOwner(OTHER_MEMBER)).rejects.toThrow(/does not hold the permission/)
      expect(sendTransaction).not.toHaveBeenCalled()
    })

    it('throws when the signer is not a member', async () => {
      const { account } = await configuringAccount({
        members: [{ address: OTHER_MEMBER, mask: 7 }]
      })

      await expect(account.addOwner(THIRD_MEMBER)).rejects.toThrow(/not a member/)
    })

    it('throws when the multisig does not exist', async () => {
      const { account } = await configuringAccount({ deployed: false })

      await expect(account.addOwner(OTHER_MEMBER)).rejects.toThrow(/does not exist/)
    })

    it('throws on a malformed address before any RPC call', async () => {
      const { account, sendTransaction } = await configuringAccount()

      await expect(account.addOwner('nope')).rejects.toThrow(/Expected base58-encoded address string of length in the range \[32, 44\]/)
      expect(sendTransaction).not.toHaveBeenCalled()
    })
  })

  describe('removeOwner', () => {
    const THREE_OWNERS = [
      { address: TEST_SIGNER, mask: 7 },
      { address: OTHER_MEMBER, mask: 7 },
      { address: THIRD_MEMBER, mask: 7 }
    ]

    it('sends one RemoveMember action', async () => {
      const { account, sendTransaction } = await configuringAccount({ members: THREE_OWNERS })

      await account.removeOwner(OTHER_MEMBER)

      const [{ instructions }] = sendTransaction.mock.calls[0]
      const { data } = instructions[0]

      expect(instructions).toHaveLength(2)
      expect(Array.from(data.slice(0, 8))).toEqual([155, 236, 87, 228, 137, 75, 81, 39])
      expect(data).toHaveLength(46)
      expect(new DataView(data.buffer).getUint32(8, true)).toBe(1)
      expect(data[12]).toBe(1)
      expect(getBase58Decoder().decode(data.subarray(13, 45))).toBe(OTHER_MEMBER)
    })

    it('adds a ChangeThreshold action in the same proposal', async () => {
      const { account, sendTransaction } = await configuringAccount({
        members: [{ address: TEST_SIGNER, mask: 7 }, { address: OTHER_MEMBER, mask: 7 }],
        threshold: 2
      })

      await account.removeOwner(OTHER_MEMBER, { threshold: 1 })

      const [{ instructions }] = sendTransaction.mock.calls[0]
      const { data } = instructions[0]

      expect(sendTransaction).toHaveBeenCalledTimes(1)
      expect(new DataView(data.buffer).getUint32(8, true)).toBe(2)
      expect(data).toHaveLength(49)
      expect(data[45]).toBe(2)
      expect(new DataView(data.buffer).getUint16(46, true)).toBe(1)
    })

    it('returns the proposal at the next index with no confirmations', async () => {
      const { account } = await configuringAccount({ members: THREE_OWNERS })

      expect(await account.removeOwner(OTHER_MEMBER)).toEqual({
        proposalId: '5',
        // DUMMY_FEE + rent for a 118 B config transaction and a 358 B proposal.
        confirmations: 0,
        pendingConfirmations: 0,
        threshold: 1,
        status: 'pending',
        transaction: { hash: DUMMY_CONFIG_HASH, fee: 5099720n }
      })
    })

    it('refuses removing a voter from a multisig at its threshold', async () => {
      // The common case: 52% of real multisigs have threshold === voter count.
      const { account, sendTransaction } = await configuringAccount({
        members: [{ address: TEST_SIGNER, mask: 7 }, { address: OTHER_MEMBER, mask: 7 }],
        threshold: 2
      })

      await expect(account.removeOwner(OTHER_MEMBER)).rejects.toThrow(/Invalid threshold 2/)
      expect(sendTransaction).not.toHaveBeenCalled()
    })

    it('names the voter count rather than the member count', async () => {
      // Two members remain, but only one can vote.
      const { account } = await configuringAccount({
        members: [
          { address: TEST_SIGNER, mask: 7 },
          { address: OTHER_MEMBER, mask: 5 },
          { address: THIRD_MEMBER, mask: 7 }
        ],
        threshold: 2
      })

      await expect(account.removeOwner(THIRD_MEMBER))
        .rejects.toThrow(/number of owners able to vote \(1\)/)
    })

    it('refuses removing the only member', async () => {
      const { account, sendTransaction } = await configuringAccount()

      await expect(account.removeOwner(TEST_SIGNER)).rejects.toThrow(/no members/)
      expect(sendTransaction).not.toHaveBeenCalled()
    })

    it.each([
      ['vote on proposals', 2],
      ['propose transactions', 1],
      ['execute proposals', 4]
    ])('refuses removing the last member able to %s', async (permission, bit) => {
      // The signer is almighty; the other member holds everything except this permission.
      const { account, sendTransaction } = await configuringAccount({
        members: [{ address: TEST_SIGNER, mask: 7 }, { address: OTHER_MEMBER, mask: 7 & ~bit }]
      })

      await expect(account.removeOwner(TEST_SIGNER))
        .rejects.toThrow(new RegExp(`no member able to ${permission}`))
      expect(sendTransaction).not.toHaveBeenCalled()
    })

    it('refuses an address that is not a member', async () => {
      const { account, sendTransaction } = await configuringAccount({ members: THREE_OWNERS })

      await expect(account.removeOwner('CfGcujEkPVDx7yGyn1PUjxn2e353MXbLk8ixzwuJUktK'))
        .rejects.toThrow(/is not a member/)
      expect(sendTransaction).not.toHaveBeenCalled()
    })

    it('lets a member propose their own removal', async () => {
      const { account, sendTransaction } = await configuringAccount({ members: THREE_OWNERS })

      await expect(account.removeOwner(TEST_SIGNER)).resolves.toEqual({
        proposalId: '5',
        confirmations: 0,
        pendingConfirmations: 0,
        threshold: 1,
        status: 'pending',
        transaction: { hash: DUMMY_CONFIG_HASH, fee: 5099720n }
      })
      expect(sendTransaction).toHaveBeenCalledTimes(1)
    })

    it('refuses a controlled multisig', async () => {
      const { account, sendTransaction } = await configuringAccount({
        members: THREE_OWNERS,
        configAuthority: THIRD_MEMBER
      })

      await expect(account.removeOwner(OTHER_MEMBER))
        .rejects.toThrow(/controlled by the configuration authority/)
      expect(sendTransaction).not.toHaveBeenCalled()
    })

    it('throws when the signer cannot propose', async () => {
      const { account, sendTransaction } = await configuringAccount({
        members: [{ address: TEST_SIGNER, mask: 6 }, { address: OTHER_MEMBER, mask: 7 }]
      })

      await expect(account.removeOwner(OTHER_MEMBER)).rejects.toThrow(/does not hold the permission/)
      expect(sendTransaction).not.toHaveBeenCalled()
    })

    it('throws when the multisig does not exist', async () => {
      const { account } = await configuringAccount({ deployed: false })

      await expect(account.removeOwner(OTHER_MEMBER)).rejects.toThrow(/does not exist/)
    })

    it('throws on a malformed address before any RPC call', async () => {
      const { account, sendTransaction } = await configuringAccount({ members: THREE_OWNERS })

      await expect(account.removeOwner('nope')).rejects.toThrow(/Expected base58-encoded address string of length in the range \[32, 44\]/)
      expect(sendTransaction).not.toHaveBeenCalled()
    })
  })

  describe('addOwner threshold bound', () => {
    it('counts voters, not members', async () => {
      // Masks 7, 5, 5: one voter. Adding an almighty member makes two, so 3 is invalid even
      // though four members would exist.
      const { account, sendTransaction } = await configuringAccount({
        members: [
          { address: TEST_SIGNER, mask: 7 },
          { address: OTHER_MEMBER, mask: 5 },
          { address: THIRD_MEMBER, mask: 5 }
        ]
      })

      await expect(account.addOwner('CfGcujEkPVDx7yGyn1PUjxn2e353MXbLk8ixzwuJUktK', { threshold: 3 }))
        .rejects.toThrow(/number of owners able to vote \(2\)/)
      expect(sendTransaction).not.toHaveBeenCalled()
    })

    it('accepts a threshold equal to the resulting voter count', async () => {
      const { account } = await configuringAccount({
        members: [
          { address: TEST_SIGNER, mask: 7 },
          { address: OTHER_MEMBER, mask: 5 },
          { address: THIRD_MEMBER, mask: 5 }
        ]
      })

      await expect(account.addOwner('CfGcujEkPVDx7yGyn1PUjxn2e353MXbLk8ixzwuJUktK', { threshold: 2 }))
        .resolves.toEqual({
        proposalId: '5',
        // DUMMY_FEE + rent for a 122 B config transaction and a 358 B proposal.
        confirmations: 0,
        pendingConfirmations: 0,
        threshold: 1,
        status: 'pending',
        transaction: { hash: DUMMY_CONFIG_HASH, fee: 5127560n }
      })
    })
  })

  describe('swapOwner', () => {
    const NEW_OWNER = 'CfGcujEkPVDx7yGyn1PUjxn2e353MXbLk8ixzwuJUktK'
    const TWO_OWNERS = [
      { address: TEST_SIGNER, mask: 7 },
      { address: OTHER_MEMBER, mask: 7 }
    ]

    it('sends RemoveMember then AddMember in one proposal', async () => {
      const { account, sendTransaction } = await configuringAccount({ members: TWO_OWNERS })

      await account.swapOwner(OTHER_MEMBER, NEW_OWNER)

      const [{ instructions }] = sendTransaction.mock.calls[0]
      const { data } = instructions[0]

      expect(sendTransaction).toHaveBeenCalledTimes(1)
      expect(instructions).toHaveLength(2)
      expect(data).toHaveLength(80)
      expect(new DataView(data.buffer).getUint32(8, true)).toBe(2)
      expect(data[12]).toBe(1)
      expect(getBase58Decoder().decode(data.subarray(13, 45))).toBe(OTHER_MEMBER)
      expect(data[45]).toBe(0)
      expect(getBase58Decoder().decode(data.subarray(46, 78))).toBe(NEW_OWNER)
    })

    it('gives the replacement the mask of the member it replaces', async () => {
      // Mask 5 is Initiate|Execute: the replacement must not gain the vote.
      const { account, sendTransaction } = await configuringAccount({
        members: [{ address: TEST_SIGNER, mask: 7 }, { address: OTHER_MEMBER, mask: 5 }]
      })

      await account.swapOwner(OTHER_MEMBER, NEW_OWNER)

      const { data } = sendTransaction.mock.calls[0][0].instructions[0]

      expect(data[78]).toBe(5)
    })

    it('inherits a full mask when that is what the member held', async () => {
      const { account, sendTransaction } = await configuringAccount({ members: TWO_OWNERS })

      await account.swapOwner(OTHER_MEMBER, NEW_OWNER)

      expect(sendTransaction.mock.calls[0][0].instructions[0].data[78]).toBe(7)
    })

    it('adds a ChangeThreshold action when asked', async () => {
      const { account, sendTransaction } = await configuringAccount({ members: TWO_OWNERS })

      await account.swapOwner(OTHER_MEMBER, NEW_OWNER, { threshold: 2 })

      const { data } = sendTransaction.mock.calls[0][0].instructions[0]

      expect(data).toHaveLength(83)
      expect(new DataView(data.buffer).getUint32(8, true)).toBe(3)
      expect(data[79]).toBe(2)
      expect(new DataView(data.buffer).getUint16(80, true)).toBe(2)
    })

    it('returns the proposal at the next index with no confirmations', async () => {
      const { account } = await configuringAccount({ members: TWO_OWNERS })

      expect(await account.swapOwner(OTHER_MEMBER, NEW_OWNER)).toEqual({
        proposalId: '5',
        // DUMMY_FEE + rent for a 152 B config transaction and a 262 B proposal.
        confirmations: 0,
        pendingConfirmations: 0,
        threshold: 1,
        status: 'pending',
        transaction: { hash: DUMMY_CONFIG_HASH, fee: 4668200n }
      })
    })

    it('replaces the sole member of a 1-of-1', async () => {
      // Two proposals cannot do this in one round; the atomic form can.
      const { account, sendTransaction } = await configuringAccount()

      await expect(account.swapOwner(TEST_SIGNER, NEW_OWNER)).resolves.toEqual({
        proposalId: '5',
        // DUMMY_FEE + rent for a 152 B config transaction and a 166 B proposal.
        confirmations: 0,
        pendingConfirmations: 0,
        threshold: 1,
        status: 'pending',
        transaction: { hash: DUMMY_CONFIG_HASH, fee: 4000040n }
      })
      expect(sendTransaction).toHaveBeenCalledTimes(1)
    })

    it('refuses swapping a member for itself', async () => {
      const { account, sendTransaction } = await configuringAccount({ members: TWO_OWNERS })

      await expect(account.swapOwner(OTHER_MEMBER, OTHER_MEMBER)).rejects.toThrow(/for itself/)
      expect(sendTransaction).not.toHaveBeenCalled()
    })

    it('reports a self-swap as such rather than as a duplicate', async () => {
      const { account } = await configuringAccount({ members: TWO_OWNERS })

      await expect(account.swapOwner(OTHER_MEMBER, OTHER_MEMBER))
        .rejects.not.toThrow(/already a member/)
    })

    it('refuses a self-swap without reading the multisig', async () => {
      const { account, rpc } = await configuringAccount({ members: TWO_OWNERS })

      await expect(account.swapOwner(OTHER_MEMBER, OTHER_MEMBER))
        .rejects.toThrow(`Cannot swap the member ${OTHER_MEMBER} of the multisig for itself.`)
      expect(rpcRequests(rpc, 'getAccountInfo')).toHaveLength(0)
    })

    it('refuses when the old address is not a member', async () => {
      const { account, sendTransaction } = await configuringAccount({ members: TWO_OWNERS })

      await expect(account.swapOwner(THIRD_MEMBER, NEW_OWNER)).rejects.toThrow(/is not a member/)
      expect(sendTransaction).not.toHaveBeenCalled()
    })

    it('refuses when the new address is already a member', async () => {
      const { account, sendTransaction } = await configuringAccount({ members: TWO_OWNERS })

      await expect(account.swapOwner(OTHER_MEMBER, TEST_SIGNER)).rejects.toThrow(/already a member/)
      expect(sendTransaction).not.toHaveBeenCalled()
    })

    it('bounds the threshold by the inherited mask, not a granted one', async () => {
      // Swapping out a non-voter leaves one voter, so a threshold of 2 is impossible. It
      // would be possible if the replacement were granted the vote instead of inheriting.
      const { account, sendTransaction } = await configuringAccount({
        members: [{ address: TEST_SIGNER, mask: 7 }, { address: OTHER_MEMBER, mask: 5 }]
      })

      await expect(account.swapOwner(OTHER_MEMBER, NEW_OWNER, { threshold: 2 }))
        .rejects.toThrow(/number of owners able to vote \(1\)/)
      expect(sendTransaction).not.toHaveBeenCalled()
    })

    it('refuses a threshold above the resulting voter count', async () => {
      // Swapping is voter-neutral, so the ceiling stays at the current voter count.
      const { account, sendTransaction } = await configuringAccount({ members: TWO_OWNERS })

      await expect(account.swapOwner(OTHER_MEMBER, NEW_OWNER, { threshold: 3 }))
        .rejects.toThrow(/Invalid threshold/)
      expect(sendTransaction).not.toHaveBeenCalled()
    })

    it('refuses a controlled multisig', async () => {
      const { account, sendTransaction } = await configuringAccount({
        members: TWO_OWNERS,
        configAuthority: THIRD_MEMBER
      })

      await expect(account.swapOwner(OTHER_MEMBER, NEW_OWNER))
        .rejects.toThrow(/controlled by the configuration authority/)
      expect(sendTransaction).not.toHaveBeenCalled()
    })

    it('throws when the signer cannot propose', async () => {
      const { account, sendTransaction } = await configuringAccount({
        members: [{ address: TEST_SIGNER, mask: 6 }, { address: OTHER_MEMBER, mask: 7 }]
      })

      await expect(account.swapOwner(OTHER_MEMBER, NEW_OWNER)).rejects.toThrow(/does not hold the permission/)
      expect(sendTransaction).not.toHaveBeenCalled()
    })

    it('throws when the multisig does not exist', async () => {
      const { account } = await configuringAccount({ deployed: false })

      await expect(account.swapOwner(TEST_SIGNER, NEW_OWNER)).rejects.toThrow(/does not exist/)
    })

    it.each([
      ['the old address', 'nope', NEW_OWNER],
      ['the new address', TEST_SIGNER, 'nope']
    ])('throws on a malformed %s before any RPC call', async (_label, oldOwner, newOwner) => {
      const { account, sendTransaction } = await configuringAccount({ members: TWO_OWNERS })

      await expect(account.swapOwner(oldOwner, newOwner)).rejects.toThrow(/Expected base58-encoded address string of length in the range \[32, 44\]/)
      expect(sendTransaction).not.toHaveBeenCalled()
    })
  })

  describe('changeThreshold', () => {
    const TWO_OWNERS = [
      { address: TEST_SIGNER, mask: 7 },
      { address: OTHER_MEMBER, mask: 7 }
    ]

    it('sends one ChangeThreshold action', async () => {
      const { account, sendTransaction } = await configuringAccount({ members: TWO_OWNERS })

      await account.changeThreshold(2)

      const [{ instructions }] = sendTransaction.mock.calls[0]
      const { data } = instructions[0]

      expect(instructions).toHaveLength(2)
      expect(data).toHaveLength(16)
      expect(Array.from(data.slice(0, 8))).toEqual([155, 236, 87, 228, 137, 75, 81, 39])
      expect(new DataView(data.buffer).getUint32(8, true)).toBe(1)
      expect(data[12]).toBe(2)
      expect(new DataView(data.buffer).getUint16(13, true)).toBe(2)
    })

    it('returns the proposal at the next index with no confirmations', async () => {
      const { account } = await configuringAccount({ members: TWO_OWNERS })

      expect(await account.changeThreshold(2)).toEqual({
        proposalId: '5',
        // DUMMY_FEE + rent for an 88 B config transaction and a 262 B proposal.
        confirmations: 0,
        pendingConfirmations: 0,
        threshold: 1,
        status: 'pending',
        transaction: { hash: DUMMY_CONFIG_HASH, fee: 4222760n }
      })
    })

    it('refuses the threshold already in force', async () => {
      // A no-op that would still invalidate every pending proposal.
      const { account, sendTransaction } = await configuringAccount({
        members: TWO_OWNERS,
        threshold: 2
      })

      await expect(account.changeThreshold(2)).rejects.toThrow(/already requires 2 approvals/)
      expect(sendTransaction).not.toHaveBeenCalled()
    })

    it('bounds the threshold by voters, not owners', async () => {
      // Three owners, one voter: a threshold of 2 is impossible.
      const { account, sendTransaction } = await configuringAccount({
        members: [
          { address: TEST_SIGNER, mask: 7 },
          { address: OTHER_MEMBER, mask: 5 },
          { address: THIRD_MEMBER, mask: 5 }
        ]
      })

      await expect(account.changeThreshold(2))
        .rejects.toThrow(/number of owners able to vote \(1\)/)
      expect(sendTransaction).not.toHaveBeenCalled()
    })

    it('accepts a threshold equal to the voter count', async () => {
      const { account, sendTransaction } = await configuringAccount({ members: TWO_OWNERS })

      await expect(account.changeThreshold(2)).resolves.toEqual({
        proposalId: '5',
        confirmations: 0,
        pendingConfirmations: 0,
        threshold: 1,
        status: 'pending',
        transaction: { hash: DUMMY_CONFIG_HASH, fee: 4222760n }
      })
      expect(sendTransaction).toHaveBeenCalledTimes(1)
    })

    it.each([[0], [-1], [1.5], [3]])('refuses a threshold of %s', async (threshold) => {
      const { account, sendTransaction } = await configuringAccount({ members: TWO_OWNERS })

      await expect(account.changeThreshold(threshold)).rejects.toThrow(/Invalid threshold/)
      expect(sendTransaction).not.toHaveBeenCalled()
    })

    it('refuses a controlled multisig', async () => {
      const { account, sendTransaction } = await configuringAccount({
        members: TWO_OWNERS,
        configAuthority: THIRD_MEMBER
      })

      await expect(account.changeThreshold(2))
        .rejects.toThrow(/controlled by the configuration authority/)
      expect(sendTransaction).not.toHaveBeenCalled()
    })

    it('throws when the signer cannot propose, before the no-op check', async () => {
      const { account, sendTransaction } = await configuringAccount({
        members: [{ address: TEST_SIGNER, mask: 6 }, { address: OTHER_MEMBER, mask: 7 }],
        threshold: 1
      })

      // Threshold 1 is also the current value, so the ordering decides which error surfaces.
      await expect(account.changeThreshold(1)).rejects.toThrow(/does not hold the permission/)
      expect(sendTransaction).not.toHaveBeenCalled()
    })

    it('throws when the multisig does not exist', async () => {
      const { account } = await configuringAccount({ deployed: false })

      await expect(account.changeThreshold(2)).rejects.toThrow(/does not exist/)
    })
  })

  describe('executeProposal', () => {
    // The other three accounts the execute path reads alongside the multisig, and the spending
    // limit one config action names. All program-derived from TEST_MULTISIG_PDA.
    const TEST_TRANSACTION_PDA_3 = '5PzeP4ZwkPPmZiYC98mZFzWnfcNxSCEudToHCzB9kXDG'
    const TEST_SPENDING_LIMIT_PDA = '65Du8F3pZott4itHLd1LU2MtnaFaogmdQ4Gvnz9b4EUR'
    const CLOCK_SYSVAR = 'SysvarC1ock11111111111111111111111111111111'

    /**
     * Builds an executing account with a stubbed RPC and send.
     *
     * @param {Object} [options] - The scenario.
     * @param {number} [options.mask=7] - The signer's permission mask.
     * @param {Object|null} [options.proposal] - The proposal state, or null for absent.
     * @param {Object|null} [options.transaction] - The backing transaction account.
     * @param {bigint} [options.staleTransactionIndex=0n] - The multisig's stale index.
     * @param {number} [options.timeLock=0] - The multisig's time lock, in seconds.
     * @param {bigint} [options.now=0n] - The cluster's current timestamp.
     * @param {boolean} [options.deployed=true] - Whether the multisig exists.
     * @returns {Promise<{ account: Object, sendTransaction: Function, rpc: Object }>}
     */
    async function executingAccount ({
      mask = 7,
      proposal = { status: 3 },
      transaction = vaultTransactionAccountValue(),
      staleTransactionIndex = 0n,
      timeLock = 0,
      now = 0n,
      deployed = true
    } = {}) {
      const wallet = new WalletManagerMultisigSquads(TEST_SEED_PHRASE, {
        provider: TEST_RPC_URL,
        multisigPdaOrCreateKey: TEST_MULTISIG_PDA
      })
      const account = await wallet.getAccount(0)

      const rpc = stubSolanaRpc({
        getMultipleAccounts: () => ({
          context: { slot: 1 },
          value: [
            deployed
              ? multisigAccountValue([{ address: TEST_SIGNER, mask }], {
                threshold: 1, transactionIndex: 7n, staleTransactionIndex, timeLock
              })
              : null,
            proposal && proposalAccountValue(proposal),
            transaction,
            clockAccountValue(now)
          ]
        })
      })
      const sendTransaction = jest.fn(async () => ({ hash: DUMMY_EXECUTE_HASH, fee: DUMMY_FEE }))

      account._signerAccount.sendTransaction = sendTransaction

      return { account, sendTransaction, rpc }
    }

    it('sends a single vaultTransactionExecute instruction', async () => {
      const { account, sendTransaction } = await executingAccount()

      await account.executeProposal(3)

      const [{ instructions }] = sendTransaction.mock.calls[0]

      expect(instructions).toHaveLength(1)
      expect(Array.from(instructions[0].data))
        .toEqual([194, 8, 161, 87, 153, 164, 25, 171])
    })

    it('puts the four fixed accounts first, with the multisig read-only', async () => {
      const { account, sendTransaction } = await executingAccount()

      await account.executeProposal(3)

      const [{ instructions }] = sendTransaction.mock.calls[0]
      const roles = instructions[0].accounts.slice(0, 4).map((a) => a.role)

      // multisig readonly, proposal writable, transaction readonly, member readonly signer.
      expect(roles).toEqual([0, 1, 0, 2])
      expect(instructions[0].accounts[0].address).toBe(TEST_MULTISIG_PDA)
    })

    it('appends the message accounts and de-signs the vault', async () => {
      const { account, sendTransaction } = await executingAccount({
        transaction: vaultTransactionAccountValue({
          accountKeys: [TEST_SIGNER, OTHER_MEMBER, SYSTEM_PROGRAM]
        })
      })

      await account.executeProposal(3)

      const [{ instructions }] = sendTransaction.mock.calls[0]
      const remaining = instructions[0].accounts.slice(4)

      // The first key is the message's writable signer, and it is not TEST_SIGNER's vault,
      // so it keeps its signer flag; the second is a writable non-signer; the third readonly.
      expect(remaining.map((a) => a.address)).toEqual([TEST_SIGNER, OTHER_MEMBER, SYSTEM_PROGRAM])
      expect(remaining.map((a) => a.role)).toEqual([3, 1, 0])
    })

    it('strips the signer flag from the vault itself', async () => {
      const { account, sendTransaction } = await executingAccount({
        transaction: vaultTransactionAccountValue({
          accountKeys: [TEST_VAULT_PDA, OTHER_MEMBER, SYSTEM_PROGRAM]
        })
      })

      await account.executeProposal(3)

      const [{ instructions }] = sendTransaction.mock.calls[0]
      const vaultMeta = instructions[0].accounts.slice(4)[0]

      expect(vaultMeta.address).toBe(TEST_VAULT_PDA)
      // Writable, but not a signer: the program signs for it.
      expect(vaultMeta.role).toBe(1)
    })

    it('returns only the hash and the fee', async () => {
      const { account } = await executingAccount()

      expect(await account.executeProposal(3)).toEqual({ hash: DUMMY_EXECUTE_HASH, fee: DUMMY_FEE })
    })

    it('reads the multisig, proposal, transaction and clock in one request', async () => {
      const { account, rpc } = await executingAccount()

      await account.executeProposal(3)

      expect(rpcRequests(rpc, 'getMultipleAccounts')).toEqual([
        [[TEST_MULTISIG_PDA, TEST_PROPOSAL_PDA_3, TEST_TRANSACTION_PDA_3, CLOCK_SYSVAR], { commitment: 'confirmed', encoding: 'base64' }]
      ])
    })

    it('executes a stale but approved vault proposal', async () => {
      const { account, sendTransaction } = await executingAccount({ staleTransactionIndex: 5n })

      await expect(account.executeProposal(3)).resolves.toEqual({ hash: DUMMY_EXECUTE_HASH, fee: DUMMY_FEE })
      expect(sendTransaction).toHaveBeenCalledTimes(1)
    })

    it('throws when the signer cannot execute', async () => {
      // Mask 3 is propose plus vote: a member, but unable to execute.
      const { account, sendTransaction } = await executingAccount({ mask: 3 })

      await expect(account.executeProposal(3)).rejects.toThrow(/does not hold the permission/)
      expect(sendTransaction).not.toHaveBeenCalled()
    })

    it.each([
      ['a draft', 0],
      ['rejected', 2],
      ['executed', 5]
    ])('throws when the proposal is %s', async (_label, status) => {
      const { account, sendTransaction } = await executingAccount({ proposal: { status } })

      await expect(account.executeProposal(3)).rejects.toThrow(/rather than approved/)
      expect(sendTransaction).not.toHaveBeenCalled()
    })

    it('throws a threshold not met error when the proposal is still open for voting', async () => {
      const { account, sendTransaction } = await executingAccount({ proposal: { status: 1 } })

      await expect(account.executeProposal(3)).rejects.toThrow(ThresholdNotMetError)
      await expect(account.executeProposal(3)).rejects.toThrow(
        'The proposal 3 holds 0 of the 1 approvals it needs to execute.'
      )
      expect(sendTransaction).not.toHaveBeenCalled()
    })

    it('throws while the time lock has not elapsed', async () => {
      const { account, sendTransaction } = await executingAccount({
        timeLock: 3600,
        proposal: { status: 3, timestamp: 1000n },
        now: 2800n
      })

      await expect(account.executeProposal(3)).rejects.toThrow(/time lock for another 1800 seconds/)
      expect(sendTransaction).not.toHaveBeenCalled()
    })

    it('executes once the time lock has elapsed', async () => {
      const { account } = await executingAccount({
        timeLock: 3600,
        proposal: { status: 3, timestamp: 1000n },
        now: 4600n
      })

      await expect(account.executeProposal(3)).resolves.toEqual({ hash: DUMMY_EXECUTE_HASH, fee: DUMMY_FEE })
    })

    it('throws when the proposal does not exist', async () => {
      const { account } = await executingAccount({ proposal: null })

      await expect(account.executeProposal(3)).rejects.toThrow(/no proposal at index 3/)
    })

    it('throws when the multisig does not exist', async () => {
      const { account } = await executingAccount({ deployed: false })

      await expect(account.executeProposal(3)).rejects.toThrow(/does not exist/)
    })

    it('de-signs the ephemeral signers a message declares', async () => {
      const wallet = new WalletManagerMultisigSquads(TEST_SEED_PHRASE, {
        provider: TEST_RPC_URL, multisigPdaOrCreateKey: TEST_MULTISIG_PDA
      })
      const probe = await wallet.getAccount(0)
      const transactionPda = await probe._getTransactionPda(TEST_MULTISIG_PDA, 3n)
      const [ephemeral] = await probe._getEphemeralSignerPdas(transactionPda, 1)

      // The message marks the ephemeral signer as a writable signer; the program signs for it.
      const { account, sendTransaction } = await executingAccount({
        transaction: vaultTransactionAccountValue({
          accountKeys: [ephemeral, OTHER_MEMBER, SYSTEM_PROGRAM],
          ephemeralSignerCount: 1
        })
      })

      await account.executeProposal(3)

      const remaining = sendTransaction.mock.calls[0][0].instructions[0].accounts.slice(4)

      expect(remaining[0].address).toBe(ephemeral)
      // Writable, not a signer.
      expect(remaining[0].role).toBe(1)
    })

    it('refuses a batch', async () => {
      const BATCH_DISCRIMINATOR = [156, 194, 70, 44, 22, 88, 137, 44]
      const data = new Uint8Array(100)

      data.set(BATCH_DISCRIMINATOR, 0)

      const { account, sendTransaction } = await executingAccount({ transaction: accountValue(data) })

      await expect(account.executeProposal(3)).rejects.toThrow(/batch/)
      expect(sendTransaction).not.toHaveBeenCalled()
    })

    it('refuses a proposal whose transaction account has been closed', async () => {
      // Squads closes the transaction account after execution or once stale, so an approved
      // proposal can outlive it. The account is gone, which is not the same as an unknown kind.
      const { account, sendTransaction } = await executingAccount({ transaction: null })

      const error = await account.executeProposal(3).catch((thrown) => thrown)

      // ValueError, not NoSuchElementError: the id named a real proposal, its state is the problem.
      expect(error).toBeInstanceOf(ValueError)
      expect(error).not.toBeInstanceOf(NoSuchElementError)
      expect(error.message)
        .toBe(`The transaction account ${TEST_TRANSACTION_PDA_3} behind proposal 3 has been closed.`)
      expect(sendTransaction).not.toHaveBeenCalled()
    })

    it('refuses an unrecognized transaction account', async () => {
      const { account, sendTransaction } = await executingAccount({
        transaction: accountValue(new Uint8Array(100))
      })

      await expect(account.executeProposal(3)).rejects.toThrow(/unrecognized kind/)
      expect(sendTransaction).not.toHaveBeenCalled()
    })

    it('throws on an invalid proposal id before any RPC call', async () => {
      const { account, rpc } = await executingAccount()

      await expect(account.executeProposal(-1)).rejects.toThrow(/Invalid proposal id/)
      expect(rpcRequests(rpc, 'getMultipleAccounts')).toHaveLength(0)
    })

    describe('config proposals', () => {
      it('sends configTransactionExecute with the multisig writable', async () => {
        const { account, sendTransaction } = await executingAccount({
          transaction: configTransactionAccountValue(['ChangeThreshold'])
        })

        await account.executeProposal(3)

        const [{ instructions }] = sendTransaction.mock.calls[0]

        expect(Array.from(instructions[0].data))
          .toEqual([114, 146, 244, 189, 252, 140, 36, 40])
        // multisig writable, member readonly signer, proposal writable, transaction
        // readonly, rent payer writable signer, system program readonly.
        expect(instructions[0].accounts.map((a) => a.role)).toEqual([1, 2, 1, 0, 3, 0])
      })

      it('pays rent from the executing member', async () => {
        const { account, sendTransaction } = await executingAccount({
          transaction: configTransactionAccountValue(['AddMember'])
        })

        await account.executeProposal(3)

        const [{ instructions }] = sendTransaction.mock.calls[0]
        const { accounts } = instructions[0]

        expect(accounts[4].address).toBe(TEST_SIGNER)
        expect(accounts[5].address).toBe(SYSTEM_PROGRAM)
      })

      it('refuses a stale config proposal even when approved', async () => {
        const { account, sendTransaction } = await executingAccount({
          transaction: configTransactionAccountValue(['AddMember']),
          staleTransactionIndex: 5n
        })

        await expect(account.executeProposal(3)).rejects.toThrow(/invalidated/)
        expect(sendTransaction).not.toHaveBeenCalled()
      })

      it('appends the derived account for AddSpendingLimit', async () => {
        const { account, sendTransaction } = await executingAccount({
          transaction: configTransactionAccountValue([
            'AddMember',
            { kind: 'AddSpendingLimit', key: THIRD_MEMBER }
          ])
        })

        await account.executeProposal(3)

        const [{ instructions }] = sendTransaction.mock.calls[0]
        const { accounts } = instructions[0]

        // Six fixed accounts, then the spending limit, writable.
        expect(accounts).toHaveLength(7)
        expect(accounts[6]).toEqual({ address: TEST_SPENDING_LIMIT_PDA, role: 1 })
      })

      it('appends the named account for RemoveSpendingLimit', async () => {
        const { account, sendTransaction } = await executingAccount({
          transaction: configTransactionAccountValue([
            { kind: 'RemoveSpendingLimit', key: THIRD_MEMBER }
          ])
        })

        await account.executeProposal(3)

        const { accounts } = sendTransaction.mock.calls[0][0].instructions[0]

        // Given outright by the action, not derived.
        expect(accounts).toHaveLength(7)
        expect(accounts[6]).toEqual({ address: THIRD_MEMBER, role: 1 })
      })

      it('appends one account per spending-limit action', async () => {
        const { account, sendTransaction } = await executingAccount({
          transaction: configTransactionAccountValue([
            { kind: 'RemoveSpendingLimit', key: THIRD_MEMBER },
            { kind: 'RemoveSpendingLimit', key: OTHER_MEMBER }
          ])
        })

        await account.executeProposal(3)

        const { accounts } = sendTransaction.mock.calls[0][0].instructions[0]

        expect(accounts.slice(6).map((a) => a.address)).toEqual([THIRD_MEMBER, OTHER_MEMBER])
      })

      it('adds no remaining accounts when no action needs one', async () => {
        const { account, sendTransaction } = await executingAccount({
          transaction: configTransactionAccountValue(['AddMember', 'ChangeThreshold'])
        })

        await account.executeProposal(3)

        expect(sendTransaction.mock.calls[0][0].instructions[0].accounts).toHaveLength(6)
      })

      it('walks past every action body to find a later one', async () => {
        const { account, sendTransaction } = await executingAccount({
          transaction: configTransactionAccountValue([
            'AddMember', 'RemoveMember', 'ChangeThreshold', 'SetTimeLock',
            'SetRentCollector', 'SetRentCollectorSome',
            { kind: 'RemoveSpendingLimit', key: THIRD_MEMBER }
          ])
        })

        await account.executeProposal(3)

        // The spending-limit action is last, so resolving its address proves every prior
        // body was sized correctly.
        const { accounts } = sendTransaction.mock.calls[0][0].instructions[0]

        expect(accounts[6].address).toBe(THIRD_MEMBER)
      })

      it('throws on an unknown action tag rather than skipping it', async () => {
        const data = new Uint8Array(100)
        data.set(CONFIG_TRANSACTION_DISCRIMINATOR, 0)
        new DataView(data.buffer).setUint32(81, 1, true)
        data[85] = 99

        const { account } = await executingAccount({ transaction: accountValue(data) })

        await expect(account.executeProposal(3)).rejects.toThrow(AssertionError)
        await expect(account.executeProposal(3)).rejects.toThrow(/Unknown Squads config action 99/)
      })
    })
  })

  describe('proposeTransfer', () => {
    const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
    const OPTIONS = { token: MINT, recipient: OTHER_MEMBER, amount: 1000n }
    const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'

    /**
     * Builds a transferring account with a stubbed RPC and send.
     *
     * @param {Object} [options] - The scenario.
     * @param {boolean} [options.recipientHasAta=true] - Whether the recipient holds the token.
     * @param {Object} [options.config] - Extra configuration.
     * @returns {Promise<{ account: Object, sendTransaction: Function, rpc: Object }>}
     */
    async function transferringAccount ({ recipientHasAta = true, config = {} } = {}) {
      const wallet = new WalletManagerMultisigSquads(TEST_SEED_PHRASE, {
        provider: TEST_RPC_URL,
        multisigPdaOrCreateKey: TEST_MULTISIG_PDA,
        ...config
      })
      const account = await wallet.getAccount(0)

      const tokenAccount = {
        owner: TOKEN_PROGRAM,
        data: ['', 'base64'],
        executable: false,
        lamports: 2039280,
        space: 165
      }

      const rpc = stubSolanaRpc({
        getAccountInfo: () => serveValue(
          multisigAccountValue([{ address: TEST_SIGNER }], { threshold: 1 })
        ),
        // The mint, whose existence decides whether the transfer can be built, and the
        // recipient's token account, whose existence decides whether it has to be created.
        getMultipleAccounts: () => ({
          context: { slot: 1 },
          value: [tokenAccount, recipientHasAta ? tokenAccount : null]
        }),
        getMinimumBalanceForRentExemption: () => 2039280
      })

      const sendTransaction = jest.fn(async () => ({ hash: DUMMY_TRANSFER_HASH, fee: DUMMY_FEE }))
      account._signerAccount.sendTransaction = sendTransaction

      return { account, sendTransaction, rpc }
    }

    it('proposes a token transfer', async () => {
      const { account } = await transferringAccount()

      expect(await account.proposeTransfer(OPTIONS)).toEqual({
        proposalId: '1',
        // DUMMY_FEE + the harness rent of 2039280 for each of the two accounts.
        confirmations: 0,
        pendingConfirmations: 0,
        threshold: 1,
        status: 'pending',
        transaction: { hash: DUMMY_TRANSFER_HASH, fee: 4083560n }
      })
    })

    it('includes an ATA creation only when the recipient lacks one', async () => {
      // The inner message is the third field of vaultTransactionCreate's data, after the
      // discriminator, vault index and ephemeral signer count.
      const messageLength = (mock) => {
        const data = mock.mock.calls[0][0].instructions[0].data
        return new DataView(data.buffer).getUint32(10, true)
      }

      const { account: withAta, sendTransaction: a } = await transferringAccount()

      await withAta.proposeTransfer(OPTIONS)

      expect(messageLength(a)).toBe(150)

      const { account: without, sendTransaction: b } = await transferringAccount({
        recipientHasAta: false
      })

      await without.proposeTransfer(OPTIONS)

      expect(messageLength(b)).toBe(289)
    })

    it('spends from the vault the options name', async () => {
      const { account, sendTransaction } = await transferringAccount()

      await account.proposeTransfer(OPTIONS, { vaultIndex: 3 })

      // Byte 8 of vaultTransactionCreate, after the discriminator: the index the program
      // derives the signing vault from when the proposal executes.
      expect(sendTransaction.mock.calls[0][0].instructions[0].data[8]).toBe(3)
    })

    it('refuses a vault index above the u8 the seed encodes', async () => {
      const { account, sendTransaction } = await transferringAccount()

      await expect(account.proposeTransfer(OPTIONS, { vaultIndex: 256 }))
        .rejects.toThrow('Invalid vault index 256. It must be an integer between 0 and 255.')
      expect(sendTransaction).not.toHaveBeenCalled()
    })

    it('reads the multisig once and the recipient ATA once', async () => {
      const { account, rpc } = await transferringAccount()

      await account.proposeTransfer(OPTIONS)

      // One getAccountInfo for the multisig, one getMultipleAccounts for the mint and the ATA,
      // and one rent lookup per created account. The quote and the charge share all four.
      expect(rpcRequests(rpc, 'getAccountInfo')).toHaveLength(1)
      expect(rpcRequests(rpc, 'getMultipleAccounts')).toHaveLength(1)
      expect(rpcRequests(rpc, 'getMinimumBalanceForRentExemption')).toHaveLength(2)
    })

    it('refuses when the quote exceeds transferMaxFee', async () => {
      const { account, sendTransaction } = await transferringAccount({
        config: { transferMaxFee: 1000n }
      })

      await expect(account.proposeTransfer(OPTIONS)).rejects.toThrow(MaximumFeeExceededError)
      await expect(account.proposeTransfer(OPTIONS)).rejects.toThrow(/maximum fee/)
      expect(sendTransaction).not.toHaveBeenCalled()
    })

    it('accepts a quote exactly equal to transferMaxFee', async () => {
      // The cap is a maximum, so the boundary itself is allowed.
      const { account: quoting } = await transferringAccount()
      const { fee } = await quoting.quoteTransfer(OPTIONS)

      const { account, sendTransaction } = await transferringAccount({
        config: { transferMaxFee: fee }
      })

      await account.proposeTransfer(OPTIONS)

      expect(sendTransaction).toHaveBeenCalledTimes(1)
    })

    it('throws on a malformed mint before any RPC call', async () => {
      const { account, sendTransaction } = await transferringAccount()

      await expect(account.proposeTransfer({ ...OPTIONS, token: 'nope' })).rejects.toThrow(/Expected base58-encoded address string of length in the range \[32, 44\]/)
      expect(sendTransaction).not.toHaveBeenCalled()
    })

    it.each([
      ['the recipient holds the token', true],
      ['the recipient account must be created', false]
    ])('auto-executes when %s', async (_label, recipientHasAta) => {
      const { account, sendTransaction } = await transferringAccount({ recipientHasAta })

      const result = await account.proposeTransfer(OPTIONS, { autoExecute: true })
      const [{ instructions }] = sendTransaction.mock.calls[0]

      expect(instructions).toHaveLength(4)
      expect(result).toEqual({
        proposalId: '1',
        confirmations: 1,
        pendingConfirmations: 0,
        threshold: 1,
        status: 'executed',
        transaction: { hash: DUMMY_TRANSFER_HASH, fee: 4083560n }
      })
    })
  })

  describe('coordinator', () => {
    /**
     * Builds a coordinator that records what it was asked to send, and the account that uses it.
     *
     * @returns {Promise<{ account: Object, coordinator: Object, signerAccount: Object }>}
     */
    async function accountWithCoordinator (extraConfig = {}) {
      const confirmed = []
      let coordinatorConfig = null

      const coordinator = {
        getProposal: jest.fn(async () => null),
        confirmProposal: jest.fn(async (proposalId, signature) => {
          confirmed.push([proposalId, signature])
        })
      }

      const wallet = new WalletManagerMultisigSquads(TEST_SEED_PHRASE, {
        provider: TEST_RPC_URL,
        multisigPdaOrCreateKey: TEST_MULTISIG_PDA,
        coordinator: (config) => {
          coordinatorConfig = config

          return coordinator
        },
        ...extraConfig
      })
      const account = await wallet.getAccount(0)

      return {
        account,
        coordinator,
        confirmed,
        get coordinatorConfig () { return coordinatorConfig }
      }
    }

    it('names the member it derived to the coordinator, and nothing else', async () => {
      const { account, coordinator, coordinatorConfig } = await accountWithCoordinator()

      expect(account._coordinator).toBe(coordinator)
      expect(coordinatorConfig).toEqual({ signerAddress: TEST_SIGNER })
    })

    it('has no coordinator when the configuration names none', async () => {
      const wallet = new WalletManagerMultisigSquads(TEST_SEED_PHRASE, {
        provider: TEST_RPC_URL,
        multisigPdaOrCreateKey: TEST_MULTISIG_PDA
      })
      const account = await wallet.getAccount(0)

      expect(account._coordinator).toBeUndefined()
      expect(await account.getSignerAddress()).toBe(TEST_SIGNER)
    })

    it('votes as the member it derived, whatever the coordinator is', async () => {
      const { account } = await accountWithCoordinator()

      expect(await account.getSignerAddress()).toBe(TEST_SIGNER)
    })

    it('leaves a proposal to the signer account', async () => {
      const { account, coordinator } = await accountWithCoordinator()

      stubSolanaRpc({
        getAccountInfo: () => serveValue(
          multisigAccountValue([{ address: TEST_SIGNER, mask: 7 }], { threshold: 2, transactionIndex: 4n })
        ),
        getMinimumBalanceForRentExemption: ([size]) => (128n + BigInt(size)) * 6960n
      })

      const sendTransaction = jest.fn(async () => ({ hash: DUMMY_PROPOSE_HASH, fee: DUMMY_FEE }))

      account._signerAccount.sendTransaction = sendTransaction

      const result = await account.propose({ to: OTHER_MEMBER, value: 1n })

      expect(coordinator.confirmProposal).not.toHaveBeenCalled()
      expect(sendTransaction.mock.calls[0][0].instructions).toHaveLength(2)
      expect(result).toEqual({
        proposalId: '5',
        confirmations: 0,
        pendingConfirmations: 0,
        threshold: 2,
        status: 'pending',
        // DUMMY_FEE + rent for a 221 B vault transaction and a 166 B proposal.
        transaction: { hash: DUMMY_PROPOSE_HASH, fee: 4480280n }
      })
    })

    it('hands its signature back when it does not complete the bundle', async () => {
      const { account, coordinator, confirmed } = await accountWithCoordinator()
      const bundle = bundleOf([approvalOf(TEST_SIGNER), approvalOf(OTHER_MEMBER)])

      coordinator.getProposal.mockResolvedValue(bundle)

      const rpc = stubSolanaRpc({
        getMultipleAccounts: () => serveValue([
          multisigAccountValue(
            [{ address: TEST_SIGNER, mask: 7 }, { address: OTHER_MEMBER, mask: 7 }],
            { threshold: 2, transactionIndex: 7n }
          ),
          proposalAccountValue({})
        ])
      })

      const result = await account.approveProposal(3)
      const [[proposalId, signature]] = confirmed

      expect(coordinator.getProposal).toHaveBeenCalledWith('3')
      expect(proposalId).toBe('3')
      // The bundle itself never goes back, only this member's signature over its bytes.
      expect(getBase58Encoder().encode(signature)).toHaveLength(64)
      expect(await verifySignature(TEST_SIGNER, signature, bundle.messageBytes)).toBe(true)
      expect(rpcRequests(rpc, 'sendTransaction')).toEqual([])
      // One of the bundle's two approvals is signed, and the other member's slot is still empty, so
      // nothing has reached the chain and the vote counts as pending rather than confirmed.
      expect(result).toEqual({
        proposalId: '3',
        confirmations: 0,
        pendingConfirmations: 1,
        threshold: 2,
        status: 'pending',
        transaction: undefined
      })
    })

    it('keeps what a bundle has gathered out of the on-chain count', async () => {
      const { account, coordinator } = await accountWithCoordinator()

      // Three approvals for a threshold of two, which a coordinator may collect for redundancy. One
      // is already on chain and this member signs another, and the two are reported apart, so the
      // threshold cannot read as met while the third member's slot keeps the bundle where it is.
      coordinator.getProposal.mockResolvedValue(bundleOf([
        approvalOf(TEST_SIGNER),
        approvalOf(OTHER_MEMBER),
        approvalOf(THIRD_MEMBER)
      ]))

      const rpc = stubSolanaRpc({
        getMultipleAccounts: () => serveValue([
          multisigAccountValue(
            [
              { address: TEST_SIGNER, mask: 7 },
              { address: OTHER_MEMBER, mask: 7 },
              { address: THIRD_MEMBER, mask: 7 }
            ],
            { threshold: 2, transactionIndex: 7n }
          ),
          proposalAccountValue({ approved: [OTHER_MEMBER] })
        ])
      })

      const result = await account.approveProposal(3)

      expect(rpcRequests(rpc, 'sendTransaction')).toEqual([])
      expect(result.confirmations).toBe(1)
      expect(result.pendingConfirmations).toBe(1)
      expect(result.threshold).toBe(2)
      expect(result.status).toBe('pending')
      expect(result.transaction).toBeUndefined()
    })

    it('sends the bundle its signature completes, as the bytes it already is', async () => {
      const { account, coordinator } = await accountWithCoordinator()

      // The threshold is two: what decides the route is the bundle being signed, not the count.
      const bundle = bundleOf([approvalOf(TEST_SIGNER)])

      coordinator.getProposal.mockResolvedValue(bundle)

      const rpc = stubSolanaRpc({
        getMultipleAccounts: () => serveValue([
          multisigAccountValue(
            [{ address: TEST_SIGNER, mask: 7 }, { address: OTHER_MEMBER, mask: 7 }],
            { threshold: 2, transactionIndex: 7n }
          ),
          proposalAccountValue({})
        ]),
        getFeeForMessage: () => serveValue(BUNDLE_FEE),
        sendTransaction: () => DUMMY_VOTE_HASH
      })

      const result = await account.approveProposal(3)
      const [[wire, options]] = rpcRequests(rpc, 'sendTransaction')
      const broadcast = getTransactionDecoder().decode(getBase64Encoder().encode(wire))

      // The signature goes back either way; what makes this the completing vote is the send.
      expect(coordinator.confirmProposal).toHaveBeenCalledWith('3', expect.any(String))
      expect(rpcRequests(rpc, 'sendTransaction')).toHaveLength(1)
      // `preflightCommitment` is the client's default rather than anything the account sets,
      // which is how `@tetherto/wdk-wallet-solana` sends too.
      expect(options).toEqual({ encoding: 'base64', preflightCommitment: 'confirmed' })
      // The bytes are the bundle's own, with this member's slot filled and nothing else touched.
      // A recompile would change them, so this comparison is what rules it out.
      expect(broadcast.messageBytes).toEqual(bundle.messageBytes)
      expect(broadcast.signatures[TEST_SIGNER]).toHaveLength(64)
      expect(isFullySignedTransaction(broadcast)).toBe(true)
      expect(result).toEqual({
        proposalId: '3',
        confirmations: 1,
        pendingConfirmations: 0,
        threshold: 2,
        status: 'pending',
        transaction: { hash: DUMMY_VOTE_HASH, fee: BUNDLE_FEE }
      })
    })

    it('reads the approvals and the execution out of the bundle it is handed', async () => {
      const { account, coordinator } = await accountWithCoordinator()

      // A durable nonce's advance, this member's own approval, and an execution riding along.
      coordinator.getProposal.mockResolvedValue(bundleOf([
        advanceNonceAccount(),
        approvalOf(TEST_SIGNER),
        executionOf()
      ]))

      stubSolanaRpc({
        getMultipleAccounts: () => serveValue([
          multisigAccountValue(
            [{ address: TEST_SIGNER, mask: 7 }, { address: OTHER_MEMBER, mask: 7 }],
            { threshold: 1, transactionIndex: 7n }
          ),
          proposalAccountValue({})
        ]),
        getFeeForMessage: () => serveValue(BUNDLE_FEE),
        sendTransaction: () => DUMMY_EXECUTE_HASH
      })

      const result = await account.approveProposal(3)

      expect(result).toEqual({
        proposalId: '3',
        confirmations: 1,
        pendingConfirmations: 0,
        threshold: 1,
        status: 'executed',
        transaction: { hash: DUMMY_EXECUTE_HASH, fee: BUNDLE_FEE }
      })
      expect(coordinator.confirmProposal).toHaveBeenCalledWith('3', expect.any(String))
    })

    it('refuses a bundle carrying a vote on another proposal', async () => {
      const { account, coordinator } = await accountWithCoordinator()

      // The member's own approval is in it, so every other check passes. Signing would put its
      // signature on the second approval too, since a signature covers the whole message.
      coordinator.getProposal.mockResolvedValue(bundleOf([
        approvalOf(TEST_SIGNER),
        approvalOf(TEST_SIGNER, TEST_PROPOSAL_PDA_4)
      ]))

      stubSolanaRpc({
        getMultipleAccounts: () => serveValue([
          multisigAccountValue(
            [{ address: TEST_SIGNER, mask: 7 }, { address: OTHER_MEMBER, mask: 7 }],
            { threshold: 2, transactionIndex: 7n }
          ),
          proposalAccountValue({})
        ])
      })

      await expect(account.approveProposal(3)).rejects.toThrow(
        new ValueError(
          `The bundle the coordinator holds for the proposal ${TEST_PROPOSAL_PDA_3} carries a Squads instruction that neither approves nor executes it on the multisig ${TEST_MULTISIG_PDA}, and a member signs every instruction in it.`
        )
      )
      expect(coordinator.confirmProposal).not.toHaveBeenCalled()
    })

    it('refuses a bundle carrying an instruction for a program it does not allow', async () => {
      const { account, coordinator } = await accountWithCoordinator()

      // A plain transfer out of the member's own account, which its signature would authorise.
      coordinator.getProposal.mockResolvedValue(bundleOf([
        approvalOf(TEST_SIGNER),
        {
          programAddress: SYSTEM_PROGRAM,
          accounts: [
            { address: TEST_SIGNER, role: AccountRole.WRITABLE_SIGNER },
            { address: OTHER_MEMBER, role: AccountRole.WRITABLE }
          ],
          data: new Uint8Array([2, 0, 0, 0, 0, 202, 154, 59, 0, 0, 0, 0])
        }
      ]))

      stubSolanaRpc({
        getMultipleAccounts: () => serveValue([
          multisigAccountValue(
            [{ address: TEST_SIGNER, mask: 7 }, { address: OTHER_MEMBER, mask: 7 }],
            { threshold: 2, transactionIndex: 7n }
          ),
          proposalAccountValue({})
        ])
      })

      await expect(account.approveProposal(3)).rejects.toThrow(
        new ValueError(
          `The bundle the coordinator holds for the proposal ${TEST_PROPOSAL_PDA_3} carries an instruction for the program ${SYSTEM_PROGRAM}, and a member signs every instruction in it. Only Squads votes on that proposal ride along, beside a compute budget, a memo and a nonce advance.`
        )
      )
      expect(coordinator.confirmProposal).not.toHaveBeenCalled()
    })

    it('refuses a bundle quoting above the fee ceiling, before it signs', async () => {
      const { account, coordinator } = await accountWithCoordinator({ approveMaxFee: BUNDLE_FEE - 1n })

      // A compute budget rider is allowed through the whitelist, and it is what sets the priority
      // fee the quote reflects, so the ceiling is the only thing standing between the member and it.
      coordinator.getProposal.mockResolvedValue(bundleOf([
        computeUnitPrice(1_000_000_000n),
        approvalOf(TEST_SIGNER)
      ]))

      const rpc = stubSolanaRpc({
        getMultipleAccounts: () => serveValue([
          multisigAccountValue(
            [{ address: TEST_SIGNER, mask: 7 }, { address: OTHER_MEMBER, mask: 7 }],
            { threshold: 2, transactionIndex: 7n }
          ),
          proposalAccountValue({})
        ]),
        getFeeForMessage: () => serveValue(BUNDLE_FEE)
      })

      await expect(account.approveProposal(3)).rejects.toThrow(
        new MaximumFeeExceededError('Exceeded maximum fee cost for the approve operation.')
      )
      expect(coordinator.confirmProposal).not.toHaveBeenCalled()
      expect(rpcRequests(rpc, 'sendTransaction')).toEqual([])
    })

    it('takes a bundle quoting within the fee ceiling', async () => {
      const { account, coordinator } = await accountWithCoordinator({ approveMaxFee: BUNDLE_FEE })

      coordinator.getProposal.mockResolvedValue(bundleOf([
        computeUnitPrice(1n),
        approvalOf(TEST_SIGNER)
      ]))

      stubSolanaRpc({
        getMultipleAccounts: () => serveValue([
          multisigAccountValue(
            [{ address: TEST_SIGNER, mask: 7 }, { address: OTHER_MEMBER, mask: 7 }],
            { threshold: 2, transactionIndex: 7n }
          ),
          proposalAccountValue({})
        ]),
        getFeeForMessage: () => serveValue(BUNDLE_FEE),
        sendTransaction: () => DUMMY_VOTE_HASH
      })

      const result = await account.approveProposal(3)

      // One quote serves both the ceiling and the reported fee.
      expect(coordinator.confirmProposal).toHaveBeenCalledWith('3', expect.any(String))
      expect(result.transaction).toEqual({ hash: DUMMY_VOTE_HASH, fee: BUNDLE_FEE })
    })

    it('resolves a bundle compressed with an address lookup table', async () => {
      const { account, coordinator } = await accountWithCoordinator()

      // The multisig and the proposal are borrowed from the table, so neither is a static account
      // any more. Only the member has to stay static, because a signer cannot be borrowed.
      const borrowed = [TEST_PROPOSAL_PDA_3, TEST_MULTISIG_PDA]

      coordinator.getProposal.mockResolvedValue(
        compressedBundleOf([approvalOf(TEST_SIGNER)], borrowed)
      )

      stubSolanaRpc({
        getMultipleAccounts: ([addresses]) => addresses.includes(TEST_LOOKUP_TABLE)
          ? serveValue([lookupTableAccount(
            ADDRESS_LOOKUP_TABLE_PROGRAM,
            borrowed.map((entry) => getBase58Encoder().encode(entry))
          )])
          : serveValue([
            multisigAccountValue(
              [{ address: TEST_SIGNER, mask: 7 }, { address: OTHER_MEMBER, mask: 7 }],
              { threshold: 2, transactionIndex: 7n }
            ),
            proposalAccountValue({})
          ]),
        getFeeForMessage: () => serveValue(BUNDLE_FEE),
        sendTransaction: () => DUMMY_VOTE_HASH
      })

      const result = await account.approveProposal(3)

      expect(result).toEqual({
        proposalId: '3',
        confirmations: 1,
        pendingConfirmations: 0,
        threshold: 2,
        status: 'pending',
        transaction: { hash: DUMMY_VOTE_HASH, fee: BUNDLE_FEE }
      })
    })

    it('refuses a bundle whose lookup table cannot be read', async () => {
      const { account, coordinator } = await accountWithCoordinator()

      coordinator.getProposal.mockResolvedValue(
        compressedBundleOf([approvalOf(TEST_SIGNER)], [TEST_PROPOSAL_PDA_3, TEST_MULTISIG_PDA])
      )

      stubSolanaRpc({
        getMultipleAccounts: ([addresses]) => addresses.includes(TEST_LOOKUP_TABLE)
          ? serveValue([null])
          : serveValue([
            multisigAccountValue(
              [{ address: TEST_SIGNER, mask: 7 }, { address: OTHER_MEMBER, mask: 7 }],
              { threshold: 2, transactionIndex: 7n }
            ),
            proposalAccountValue({})
          ])
      })

      await expect(account.approveProposal(3)).rejects.toThrow(
        new NoSuchElementError(
          `The address lookup table ${TEST_LOOKUP_TABLE} does not exist, so the transaction's accounts cannot be resolved.`
        )
      )
    })

    it('counts the approvals the cluster holds alongside the bundle', async () => {
      const { account, coordinator } = await accountWithCoordinator()

      // Another member voted alone before the coordinator was involved, which is what a null
      // `getProposal` tells a member to do, so its approval is on chain and not in the bundle.
      coordinator.getProposal.mockResolvedValue(bundleOf([approvalOf(TEST_SIGNER)]))

      stubSolanaRpc({
        getMultipleAccounts: () => serveValue([
          multisigAccountValue([
            { address: TEST_SIGNER, mask: 7 },
            { address: OTHER_MEMBER, mask: 7 },
            { address: THIRD_MEMBER, mask: 7 }
          ], { threshold: 2, transactionIndex: 7n }),
          proposalAccountValue({ approved: [OTHER_MEMBER] })
        ]),
        getFeeForMessage: () => serveValue(BUNDLE_FEE),
        sendTransaction: () => DUMMY_VOTE_HASH
      })

      const result = await account.approveProposal(3)

      // One on chain plus one in the bundle is the two the threshold wants, so the number the
      // caller compares against `threshold` has to say so.
      expect(result).toEqual({
        proposalId: '3',
        confirmations: 2,
        pendingConfirmations: 0,
        threshold: 2,
        status: 'pending',
        transaction: { hash: DUMMY_VOTE_HASH, fee: BUNDLE_FEE }
      })
      expect(result.confirmations >= result.threshold).toBe(true)
    })

    it('falls back to the base fee when the cluster cannot price the bundle', async () => {
      const { account, coordinator } = await accountWithCoordinator()

      coordinator.getProposal.mockResolvedValue(bundleOf([approvalOf(TEST_SIGNER)]))

      stubSolanaRpc({
        getMultipleAccounts: () => serveValue([
          multisigAccountValue(
            [{ address: TEST_SIGNER, mask: 7 }, { address: OTHER_MEMBER, mask: 7 }],
            { threshold: 2, transactionIndex: 7n }
          ),
          proposalAccountValue({})
        ]),
        // What a node answers for a message it cannot find a blockhash for, which is the durable
        // nonce case the whole bundle design leans on.
        getFeeForMessage: () => serveValue(null),
        sendTransaction: () => DUMMY_VOTE_HASH
      })

      const result = await account.approveProposal(3)

      expect(result).toEqual({
        proposalId: '3',
        confirmations: 1,
        pendingConfirmations: 0,
        threshold: 2,
        status: 'pending',
        transaction: { hash: DUMMY_VOTE_HASH, fee: SIGNATURE_FEE }
      })
    })

    it('refuses a bundle that carries one member twice', async () => {
      const { account, coordinator } = await accountWithCoordinator()

      // Squads rejects the second, and a Solana transaction is atomic, so the batch reverts. It
      // needs only the one signature, so nothing else would stop the account broadcasting it.
      coordinator.getProposal.mockResolvedValue(
        bundleOf([approvalOf(TEST_SIGNER), approvalOf(TEST_SIGNER)])
      )

      stubSolanaRpc({
        getMultipleAccounts: () => serveValue([
          multisigAccountValue(
            [{ address: TEST_SIGNER, mask: 7 }, { address: OTHER_MEMBER, mask: 7 }],
            { threshold: 2, transactionIndex: 7n }
          ),
          proposalAccountValue({})
        ])
      })

      await expect(account.approveProposal(3)).rejects.toThrow(
        new ValueError(
          `The bundle the coordinator holds for the proposal 3 carries more than one approval by the member ${TEST_SIGNER}, which Squads rejects, so it can never land.`
        )
      )
      expect(coordinator.confirmProposal).not.toHaveBeenCalled()
    })

    it('refuses a bundle that does not carry its own approval', async () => {
      const { account, coordinator } = await accountWithCoordinator()

      // The member is a signer of these bytes, as their fee payer, but it is not approving in
      // them. Signing would put its signature on a transaction it is not voting in.
      coordinator.getProposal.mockResolvedValue(bundleOf([approvalOf(OTHER_MEMBER)]))

      stubSolanaRpc({
        getMultipleAccounts: () => serveValue([
          multisigAccountValue(
            [{ address: TEST_SIGNER, mask: 7 }, { address: OTHER_MEMBER, mask: 7 }],
            { threshold: 2, transactionIndex: 7n }
          ),
          proposalAccountValue({})
        ])
      })

      await expect(account.approveProposal(3)).rejects.toThrow(
        new ValueError(
          `The bundle the coordinator holds for the proposal 3 does not carry an approval by the signer ${TEST_SIGNER}.`
        )
      )
      expect(coordinator.confirmProposal).not.toHaveBeenCalled()
    })

    it('leaves a rejection to the signer account', async () => {
      const { account, coordinator } = await accountWithCoordinator()
      const sendTransaction = jest.fn(async () => ({ hash: DUMMY_VOTE_HASH, fee: DUMMY_FEE }))

      stubSolanaRpc({
        getMultipleAccounts: () => serveValue([
          multisigAccountValue(
            [{ address: TEST_SIGNER, mask: 7 }, { address: OTHER_MEMBER, mask: 7 }],
            { threshold: 2, transactionIndex: 7n }
          ),
          proposalAccountValue({})
        ])
      })

      account._signerAccount.sendTransaction = sendTransaction

      const result = await account.rejectProposal(3)

      expect(coordinator.confirmProposal).not.toHaveBeenCalled()
      expect(sendTransaction.mock.calls[0][0].instructions).toHaveLength(1)
      expect(result).toEqual({
        proposalId: '3',
        confirmations: 0,
        pendingConfirmations: 0,
        threshold: 2,
        status: 'pending',
        transaction: { hash: DUMMY_VOTE_HASH, fee: DUMMY_FEE }
      })
    })

    it('leaves the execution to the signer account', async () => {
      const { account, coordinator } = await accountWithCoordinator()

      stubSolanaRpc({
        getMultipleAccounts: () => serveValue([
          multisigAccountValue([{ address: TEST_SIGNER, mask: 7 }], { threshold: 1, transactionIndex: 7n }),
          proposalAccountValue({ status: 3, approved: [TEST_SIGNER] }),
          vaultTransactionAccountValue({}),
          clockAccountValue(0n)
        ])
      })

      const sendTransaction = jest.fn(async () => ({ hash: DUMMY_EXECUTE_HASH, fee: DUMMY_FEE }))

      account._signerAccount.sendTransaction = sendTransaction

      const result = await account.executeProposal(3)

      expect(coordinator.confirmProposal).not.toHaveBeenCalled()
      expect(sendTransaction.mock.calls[0][0].instructions).toHaveLength(1)
      expect(result).toEqual({ hash: DUMMY_EXECUTE_HASH, fee: DUMMY_FEE })
    })

    it('erases the key it derived, whatever the coordinator is', async () => {
      const { account } = await accountWithCoordinator()

      account.dispose()

      await expect(account.sign('hello')).rejects.toThrow('The wallet account has been disposed.')
    })
  })

  describe('quotes under a config override', () => {
    const TX = { to: OTHER_MEMBER, value: 1000000n }
    const OPTIONS = { token: THIRD_MEMBER, recipient: OTHER_MEMBER, amount: 1000n }

    /**
     * Builds an account that only knows its create key secret, as a deploying wallet does,
     * and serves the multisig at the address that secret derives.
     *
     * @param {Object} [config] - Configuration replacing the create key secret.
     * @returns {Promise<{ account: Object, rpc: Object }>}
     */
    async function quotingAccount (config = { createKeySecret: CREATE_KEY_SECRET }) {
      const wallet = new WalletManagerMultisigSquads(TEST_SEED_PHRASE, {
        provider: TEST_RPC_URL,
        commitment: 'confirmed',
        ...config
      })
      const account = await wallet.getAccount(0)

      const rpc = stubSolanaRpc({
        getAccountInfo: ([queried]) => serveValue(
          queried === DERIVED_MULTISIG_PDA
            ? multisigAccountValue([{ address: TEST_SIGNER }], { threshold: 1 })
            : null
        ),
        // The mint exists and the recipient holds no token account, so the quoted message
        // carries the creation as well as the transfer.
        getMultipleAccounts: () => ({
          context: { slot: 1 },
          value: [
            { owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', data: ['', 'base64'], executable: false, lamports: 2039280, space: 165 },
            null
          ]
        }),
        // The real rent formula: (128 + size) * 6960 lamports.
        getMinimumBalanceForRentExemption: ([size]) => (128n + BigInt(size)) * 6960n
      })

      return { account, rpc }
    }

    it('reads the multisig the create key derives, under the overridden commitment', async () => {
      const { account, rpc } = await quotingAccount()

      // 221 B tx rent + 166 B proposal rent + 5000
      expect(await account.quotePropose(TX, { commitment: 'processed' }))
        .toEqual({ fee: 4480280n })
      expect(rpcRequests(rpc, 'getAccountInfo')[0])
        .toEqual([DERIVED_MULTISIG_PDA, { commitment: 'processed', encoding: 'base64' }])
    })

    it('quotes a transfer the same way', async () => {
      const { account, rpc } = await quotingAccount()

      // 395 B tx rent + 166 B proposal rent + 5000
      expect(await account.quoteTransfer(OPTIONS, { commitment: 'processed' }))
        .toEqual({ fee: 5691320n })
      expect(rpcRequests(rpc, 'getAccountInfo')[0])
        .toEqual([DERIVED_MULTISIG_PDA, { commitment: 'processed', encoding: 'base64' }])
    })

    it('lets the override name a different multisig', async () => {
      const { account, rpc } = await quotingAccount()

      // The named multisig is absent, so the quote refuses rather than quoting the derived one.
      await expect(account.quotePropose(TX, { multisigPdaOrCreateKey: TEST_MULTISIG_PDA }))
        .rejects.toThrow(`The multisig account ${TEST_MULTISIG_PDA} does not exist.`)
      expect(rpcRequests(rpc, 'getAccountInfo')[0][0]).toBe(TEST_MULTISIG_PDA)
    })

    it('lets an override name a create key over the configured address', async () => {
      const { account, rpc } = await quotingAccount({ multisigPdaOrCreateKey: TEST_MULTISIG_PDA })

      expect(await account.quotePropose(TX, { multisigPdaOrCreateKey: CREATE_KEY }))
        .toEqual({ fee: 4480280n })
      expect(rpcRequests(rpc, 'getAccountInfo')[0][0]).toBe(DERIVED_MULTISIG_PDA)
    })

    it('keeps the configured address for the account the override was taken from', async () => {
      const { account } = await quotingAccount({ multisigPdaOrCreateKey: TEST_MULTISIG_PDA })

      await account.quotePropose(TX, { multisigPdaOrCreateKey: CREATE_KEY })

      expect(await account.getAddress()).toBe(TEST_MULTISIG_PDA)
    })

    it('resolves the create key without an override too', async () => {
      const { account } = await quotingAccount()

      expect(await account.getAddress()).toBe(DERIVED_MULTISIG_PDA)
      expect(await account.quotePropose(TX)).toEqual({ fee: 4480280n })
    })
  })
})
