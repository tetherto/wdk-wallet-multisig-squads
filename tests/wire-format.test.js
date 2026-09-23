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

// Everything this package puts on the wire, checked two ways. `instruction data` and the
// blocks around it diff the schemas in `src/helpers/layouts.js` against @sqds/multisig, which defines the
// format; the `instruction assembly` block drives the public API and reads the submitted
// transaction back, so a byte-perfect schema called with the wrong arguments still fails. The SDK
// is a dev-time reference only; it is never imported by src.

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals'

import * as multisig from '@sqds/multisig'
import { generated, utils } from '@sqds/multisig'
import { PublicKey, TransactionInstruction, TransactionMessage, SystemProgram } from '@solana/web3.js'
import { getBase58Decoder, getBase58Encoder, getU64Encoder } from '@solana/codecs'

import { address, getProgramDerivedAddress } from '@solana/addresses'
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getTransferInstruction,
  TOKEN_PROGRAM_ADDRESS
} from '@solana-program/token'

import WalletManagerMultisigSquads, {
  SQUADS_PROGRAM_ADDRESS
} from '@tetherto/wdk-wallet-multisig-squads'

import { CONFIG_ACTION, CONFIG_ACTION_ENCODER, INSTRUCTION } from '../src/helpers/layouts.js'

import {
  createProgramDerivedAddressSync,
  getProgramDerivedAddressSync
} from '../src/helpers/program-derived-address.js'

import { lookupTableAccount, multipleAccounts, stubSolanaRpc } from './helpers/rpc.js'
import { instructionShape, submittedInstructions } from './helpers/transaction.js'

const TEST_SEED_PHRASE =
  'test walk nut penalty hip pave soap entry language right filter choice'

const TEST_MULTISIG = '11111111111111111111111111111111'

// The multisig and vault the `beforeEach` account resolves to, derived from its
// `createKeySecret` (32 bytes of 9) with the SDK's `getMultisigPda` / `getVaultPda` rather
// than with the code under test. The `address derivation` block is what ties them back to it,
// so the 11 message tests can use the constant and still fail if the derivation breaks.
const TEST_OWN_MULTISIG = '7jmBsJmAV5aAwEQkw3AybYgTMHVUzbWgWMGvyMjhSEDQ'
const TEST_OWN_VAULT = '46t5cnapyYC1RNVCgezqxNssv65qnF3FgddyG86egHL1'
// The same multisig's vault 3, from the SDK's `getVaultPda`, for the vault-index tests.
const TEST_OWN_VAULT_3 = '4FhYxVueD2w9aFH3dW2n5ksUwusxi3m3zSGufzNLvdQz'
const TEST_OWN_CREATE_KEY = 'J2xccRtuG43drESLYznHhLhQkLTdfepcKYbiQ9BsJVaf'

const ADDRESS_LOOKUP_TABLE_PROGRAM = 'AddressLookupTab1e1111111111111111111111111'

const OWNERS = [
  '3uXqWpwgqKVdiHAwF6Vmu4G4vdQzpR66xjPkz1G7zMKE',
  '2JvLzXomThTBMSj2YQY3wE21kiaSpwGyJ17nm9xiLMsE',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
]

// The first owner is the account's own signer; the other two stand in for a co-owner and a
// transfer target.
const SIGNER = OWNERS[0]
const SECOND_OWNER = OWNERS[1]
const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'
const PAYEE = OWNERS[2]

const SYSTEM_PROGRAM = '11111111111111111111111111111111'
const CLOCK_SYSVAR = 'SysvarC1ock11111111111111111111111111111111'

const DUMMY_BLOCKHASH = 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N'
const DUMMY_SIGNATURE = '4'.repeat(87)

// PDAs from the SDK, so a wrong derivation in this package fails rather than cancels out.
const ownMultisigKey = new PublicKey(TEST_OWN_MULTISIG)
const NEXT_TRANSACTION =
  multisig.getTransactionPda({ multisigPda: ownMultisigKey, index: 1n })[0].toBase58()
const NEXT_PROPOSAL =
  multisig.getProposalPda({ multisigPda: ownMultisigKey, transactionIndex: 1n })[0].toBase58()

const TEST_TRANSACTION =
  multisig.getTransactionPda({ multisigPda: ownMultisigKey, index: 7n })[0].toBase58()

const CREATE_KEY = 'J2xccRtuG43drESLYznHhLhQkLTdfepcKYbiQ9BsJVaf'
const PROGRAM_CONFIG = 'BSTq9w3kZwNwpBXJEvTZz2G9ZTNyKBvoSeXMvwb4cNZr'
const TREASURY = 'AXTwLwzYaRVKymrgpXQpgz4L9tazBjuQqJRQqZgLKKfC'

const MULTISIG_DISCRIMINATOR = [224, 116, 121, 186, 68, 161, 79, 236]
const PROPOSAL_DISCRIMINATOR = [26, 94, 189, 187, 116, 136, 53, 33]
const PROGRAM_CONFIG_DISCRIMINATOR = [196, 210, 90, 231, 144, 149, 140, 63]

const ALMIGHTY = 7
const PROPOSAL_STATUS_ACTIVE = 1

/**
 * Wraps account data the way a Solana RPC serves it.
 *
 * @param {Buffer} data - The account's data.
 * @param {string} [owner] - The owning program.
 * @returns {Object} The account.
 */
function rpcAccount (data, owner = SQUADS_PROGRAM_ADDRESS) {
  return {
    owner,
    data: [data.toString('base64'), 'base64'],
    executable: false,
    lamports: 2039280,
    rentEpoch: 0,
    space: data.length
  }
}

/**
 * Builds a Squads multisig account.
 *
 * @param {Object} [options] - `owners`, `threshold`, `timeLock` and `transactionIndex`.
 * @returns {Object} The account, as the RPC serves it.
 */
function multisigAccount ({ owners = [SIGNER], threshold = 1, timeLock = 0, transactionIndex = 0n } = {}) {
  const header = Buffer.alloc(96)
  const members = Buffer.concat(owners.map((owner) => Buffer.concat([
    Buffer.from(getBase58Encoder().encode(owner)),
    Buffer.from([ALMIGHTY])
  ])))

  Buffer.from(MULTISIG_DISCRIMINATOR).copy(header, 0)
  header.writeUInt16LE(threshold, 72)
  header.writeUInt32LE(timeLock, 74)
  header.writeBigUInt64LE(transactionIndex, 78)
  header.writeBigUInt64LE(0n, 86)
  header.writeUInt8(0, 94) // rent_collector: None
  header.writeUInt8(254, 95) // bump

  const count = Buffer.alloc(4)
  count.writeUInt32LE(owners.length)

  return rpcAccount(Buffer.concat([header, count, members]))
}

/**
 * Builds a Squads proposal account.
 *
 * @param {Object} [options] - `status` and `approved`.
 * @returns {Object} The account, as the RPC serves it.
 */
function proposalAccount ({ status = PROPOSAL_STATUS_ACTIVE, approved = [] } = {}) {
  const head = Buffer.alloc(58)

  Buffer.from(PROPOSAL_DISCRIMINATOR).copy(head, 0)
  head.writeBigUInt64LE(1n, 40) // transaction_index
  head.writeUInt8(status, 48)
  head.writeBigInt64LE(0n, 49) // status timestamp
  head.writeUInt8(254, 57) // bump

  const votes = Buffer.alloc(4)
  votes.writeUInt32LE(approved.length)

  return rpcAccount(Buffer.concat([
    head,
    votes,
    ...approved.map((voter) => Buffer.from(getBase58Encoder().encode(voter))),
    Buffer.alloc(8) // empty rejected and cancelled vectors
  ]))
}

/**
 * Builds the Squads program config account, holding the creation fee and the treasury.
 *
 * @returns {Object} The account, as the RPC serves it.
 */
function programConfigAccount () {
  const data = Buffer.alloc(80)

  Buffer.from(PROGRAM_CONFIG_DISCRIMINATOR).copy(data, 0)
  data.writeBigUInt64LE(1000n, 40) // creation fee
  Buffer.from(getBase58Encoder().encode(TREASURY)).copy(data, 48)

  return rpcAccount(data)
}

/**
 * Converts a kit instruction to the web3.js shape the SDK helpers expect.
 *
 * @param {Object} instruction - The kit instruction.
 * @returns {Object} The web3.js instruction.
 */
function toWeb3 (instruction) {
  return {
    programId: new PublicKey(instruction.programAddress),
    keys: instruction.accounts.map((account) => ({
      pubkey: new PublicKey(account.address),
      isSigner: account.role === 2 || account.role === 3,
      isWritable: account.role === 1 || account.role === 3
    })),
    data: Buffer.from(instruction.data)
  }
}

/**
 * Converts a web3.js instruction into the kit shape `propose` takes, so one instruction can drive
 * both this package and the SDK reference.
 *
 * @param {Object} instruction - A web3.js `TransactionInstruction`.
 * @returns {Object} The instruction in kit's shape.
 */
function toKitInstruction ({ programId, keys, data }) {
  return {
    programAddress: programId.toBase58(),
    accounts: keys.map(({ pubkey, isSigner, isWritable }) => ({
      address: pubkey.toBase58(),
      role: (isSigner ? 2 : 0) | (isWritable ? 1 : 0)
    })),
    data: new Uint8Array(data)
  }
}

/**
 * Reads the stored message out of a `vaultTransactionCreate` instruction's data: discriminator(8),
 * vaultIndex(1), ephemeralSigners(1), then the message behind a u32 length.
 *
 * @param {Uint8Array} data - The instruction's data.
 * @returns {number[]} The message bytes.
 */
function proposedMessageBytes (data) {
  const bytes = Uint8Array.from(data)
  const length = new DataView(bytes.buffer).getUint32(10, true)

  return Array.from(bytes.slice(14, 14 + length))
}

describe('wire format', () => {
  let account

  beforeEach(async () => {
    const wallet = new WalletManagerMultisigSquads(TEST_SEED_PHRASE, {
      provider: 'https://dummy-url.com',
      createKeySecret: getBase58Decoder().decode(new Uint8Array(32).fill(9))
    })
    account = await wallet.getAccount(0)
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  // The only place the account's own derivation is checked. Every other test in this file
  // takes the vault as a given, so without these two a wrong PDA would cancel out: the
  // message and the SDK's reference message would both be built for the same wrong address.
  describe('address derivation', () => {
    it('derives the multisig address the SDK derives from the same create key', async () => {
      expect(await account.getAddress()).toBe(TEST_OWN_MULTISIG)
    })

    it('derives the vault address the SDK derives from that multisig', async () => {
      expect(await account.getVaultAddress()).toBe(TEST_OWN_VAULT)
    })
  })

  // The derivation itself, checked against both oracles: @solana/addresses for the algorithm and
  // the bump it settles on, @sqds/multisig for the seeds Squads actually uses. Everything else in
  // this file consumes these addresses, so a wrong bump loop would cancel out.
  describe('synchronous program-derived addresses', () => {
    const SEEDS = [
      ['multisig', 'multisig', getBase58Encoder().encode(TEST_OWN_CREATE_KEY)],
      ['multisig', getBase58Encoder().encode(TEST_OWN_MULTISIG), 'vault', Uint8Array.of(0)],
      ['multisig', getBase58Encoder().encode(TEST_OWN_MULTISIG), 'transaction', getU64Encoder().encode(1n)],
      ['multisig', 'program_config']
    ]

    it.each(SEEDS.map((seeds, index) => [index, seeds]))(
      'agrees with @solana/addresses on seed set %i, bump included',
      async (_index, seeds) => {
        const expected = await getProgramDerivedAddress({
          programAddress: SQUADS_PROGRAM_ADDRESS,
          seeds
        })

        expect(getProgramDerivedAddressSync({ programAddress: SQUADS_PROGRAM_ADDRESS, seeds }))
          .toEqual(expected)
      }
    )

    it('derives the multisig address the SDK derives, with the SDK bump', async () => {
      const [expected, bump] = multisig.getMultisigPda({
        createKey: new PublicKey(TEST_OWN_CREATE_KEY)
      })

      expect(getProgramDerivedAddressSync({
        programAddress: SQUADS_PROGRAM_ADDRESS,
        seeds: ['multisig', 'multisig', getBase58Encoder().encode(TEST_OWN_CREATE_KEY)]
      })).toEqual([expected.toBase58(), bump])
    })

    it('rejects a bumpless derivation that lands on the curve', () => {
      // 'multisig' + this create key hashes onto the curve at bump 255, which is why the
      // canonical address above sits at 252.
      expect(() => createProgramDerivedAddressSync({
        programAddress: SQUADS_PROGRAM_ADDRESS,
        seeds: ['multisig', 'multisig', getBase58Encoder().encode(TEST_OWN_CREATE_KEY), Uint8Array.of(253)]
      })).toThrow('lies on the ed25519 curve.')
    })

    // The bump counts toward the runtime's limit of 16, so 16 caller seeds already overflow.
    // @solana/addresses reports the same counts, 17 and 18, for these two inputs.
    it.each([[16, 17], [17, 18]])('refuses %i seeds, the bump making %i', (given, counted) => {
      expect(() => getProgramDerivedAddressSync({
        programAddress: SQUADS_PROGRAM_ADDRESS,
        seeds: Array.from({ length: given }, () => 'multisig')
      })).toThrow(`Expected at most 16 seeds, got ${counted}.`)
    })

    it('derives 15 seeds, one below the overflow', async () => {
      const seeds = Array.from({ length: 15 }, () => 'multisig')

      expect(getProgramDerivedAddressSync({ programAddress: SQUADS_PROGRAM_ADDRESS, seeds }))
        .toEqual(await getProgramDerivedAddress({ programAddress: SQUADS_PROGRAM_ADDRESS, seeds }))
    })

    it('refuses a seed above 32 bytes', () => {
      expect(() => getProgramDerivedAddressSync({
        programAddress: SQUADS_PROGRAM_ADDRESS,
        seeds: ['multisig', new Uint8Array(33)]
      })).toThrow('The seed at index 1 is 33 bytes, above the maximum of 32.')
    })
  })

  describe('spending limit address', () => {
    // executeProposal derives this to pass through as a remaining account, so a wrong seed fails
    // only on chain. The SDK is the oracle.
    it.each([
      ['11111111111111111111111111111111', '2JvLzXomThTBMSj2YQY3wE21kiaSpwGyJ17nm9xiLMsE'],
      ['11111111111111111111111111111111', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'],
      ['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', '3uXqWpwgqKVdiHAwF6Vmu4G4vdQzpR66xjPkz1G7zMKE']
    ])('matches the SDK for multisig %s and create key %s', async (multisigPda, createKey) => {
      const [expected] = multisig.getSpendingLimitPda({
        multisigPda: new PublicKey(multisigPda),
        createKey: new PublicKey(createKey)
      })

      expect(await account._getSpendingLimitPda(multisigPda, createKey)).toBe(expected.toBase58())
    })
  })

  describe('configTransactionCreate instruction data', () => {
    const NEW_OWNER = '2JvLzXomThTBMSj2YQY3wE21kiaSpwGyJ17nm9xiLMsE'

    /**
     * Serializes the create args with the Squads SDK.
     *
     * @param {Object[]} actions - The SDK-shaped config actions.
     * @returns {number[]} The reference bytes.
     */
    function reference (actions) {
      const [bytes] = generated.configTransactionCreateStruct.serialize({
        instructionDiscriminator: generated.configTransactionCreateInstructionDiscriminator,
        args: { actions, memo: null }
      })

      return Array.from(bytes)
    }

    /**
     * Encodes a `configTransactionCreate` over the given actions.
     *
     * @param {Object[]} actions - The config actions.
     * @returns {Uint8Array} The instruction data.
     */
    function encode (actions) {
      return INSTRUCTION.configTransactionCreate.encode({ actions, memo: null })
    }

    it('matches the SDK for a lone AddMember', () => {
      const mine = encode([CONFIG_ACTION.addMember(address(NEW_OWNER), 7)])

      expect(mine).toHaveLength(47)
      expect(Array.from(mine)).toEqual(reference([
        { __kind: 'AddMember', newMember: { key: new PublicKey(NEW_OWNER), permissions: { mask: 7 } } }
      ]))
    })

    it('matches the SDK for a lone RemoveMember', () => {
      const mine = encode([CONFIG_ACTION.removeMember(address(NEW_OWNER))])

      // One byte shorter than AddMember, which also carries a permissions mask.
      expect(mine).toHaveLength(46)
      expect(Array.from(mine)).toEqual(reference([
        { __kind: 'RemoveMember', oldMember: new PublicKey(NEW_OWNER) }
      ]))
    })

    it('matches the SDK for RemoveMember plus ChangeThreshold', () => {
      const mine = encode([
        CONFIG_ACTION.removeMember(address(NEW_OWNER)),
        CONFIG_ACTION.changeThreshold(1)
      ])

      expect(mine).toHaveLength(49)
      expect(Array.from(mine)).toEqual(reference([
        { __kind: 'RemoveMember', oldMember: new PublicKey(NEW_OWNER) },
        { __kind: 'ChangeThreshold', newThreshold: 1 }
      ]))
    })

    it('matches the SDK for AddMember plus ChangeThreshold', () => {
      const mine = encode([
        CONFIG_ACTION.addMember(address(NEW_OWNER), 7),
        CONFIG_ACTION.changeThreshold(2)
      ])

      expect(mine).toHaveLength(50)
      expect(Array.from(mine)).toEqual(reference([
        { __kind: 'AddMember', newMember: { key: new PublicKey(NEW_OWNER), permissions: { mask: 7 } } },
        { __kind: 'ChangeThreshold', newThreshold: 2 }
      ]))
    })

    it.each([
      ['inheriting a full mask', 7, 80],
      ['inheriting a limited mask', 5, 80]
    ])('matches the SDK for a swap %s', (_label, mask, size) => {
      const OLD = OWNERS[0]
      const mine = encode([
        CONFIG_ACTION.removeMember(address(OLD)),
        CONFIG_ACTION.addMember(address(NEW_OWNER), mask)
      ])

      expect(mine).toHaveLength(size)
      expect(Array.from(mine)).toEqual(reference([
        { __kind: 'RemoveMember', oldMember: new PublicKey(OLD) },
        { __kind: 'AddMember', newMember: { key: new PublicKey(NEW_OWNER), permissions: { mask } } }
      ]))
    })

    it('matches the SDK for a swap plus ChangeThreshold', () => {
      const OLD = OWNERS[0]
      const mine = encode([
        CONFIG_ACTION.removeMember(address(OLD)),
        CONFIG_ACTION.addMember(address(NEW_OWNER), 7),
        CONFIG_ACTION.changeThreshold(2)
      ])

      expect(mine).toHaveLength(83)
      expect(Array.from(mine)).toEqual(reference([
        { __kind: 'RemoveMember', oldMember: new PublicKey(OLD) },
        { __kind: 'AddMember', newMember: { key: new PublicKey(NEW_OWNER), permissions: { mask: 7 } } },
        { __kind: 'ChangeThreshold', newThreshold: 2 }
      ]))
    })

    it.each([
      [1], [2], [255], [256], [65535]
    ])('encodes a threshold of %i as a u16', (threshold) => {
      const mine = encode([CONFIG_ACTION.changeThreshold(threshold)])

      expect(Array.from(mine)).toEqual(reference([
        { __kind: 'ChangeThreshold', newThreshold: threshold }
      ]))
    })

    it('matches the SDK for a lone ChangeThreshold', () => {
      const mine = encode([CONFIG_ACTION.changeThreshold(2)])

      // The smallest config transaction this package can build.
      expect(mine).toHaveLength(16)
      expect(Array.from(mine)).toEqual(reference([{ __kind: 'ChangeThreshold', newThreshold: 2 }]))
    })

    it('agrees with the SDK on the discriminator and the action tags', () => {
      expect(Array.from(generated.configTransactionCreateInstructionDiscriminator))
        .toEqual([155, 236, 87, 228, 137, 75, 81, 39])
      // Tag 0 is AddMember, 1 RemoveMember, 2 ChangeThreshold.
      expect(CONFIG_ACTION_ENCODER.encode(CONFIG_ACTION.addMember(address(NEW_OWNER), 7))[0]).toBe(0)
      expect(CONFIG_ACTION_ENCODER.encode(CONFIG_ACTION.removeMember(address(NEW_OWNER)))[0]).toBe(1)
      expect(CONFIG_ACTION_ENCODER.encode(CONFIG_ACTION.changeThreshold(1))[0]).toBe(2)
    })
  })

  describe('proposal vote instruction data', () => {
    // Approve and reject share `ProposalVoteArgs`, so one encoder serves both and the diff
    // has to cover both discriminators.
    const VOTES = [
      ['proposalApprove', 'proposalApproveStruct', 'proposalApproveInstructionDiscriminator'],
      ['proposalReject', 'proposalRejectStruct', 'proposalRejectInstructionDiscriminator']
    ]
    const MEMOS = [
      ['no memo', undefined, 9],
      ['an empty memo', '', 13],
      ['a short memo', 'ok', 15],
      ['a longer memo', 'looks good to me', 29],
      ['a multi-byte memo', 'schön 👍', 24]
    ]

    const CASES = VOTES.flatMap(([name, struct, tag]) =>
      MEMOS.map(([label, memo, size]) => [name, label, struct, tag, memo, size])
    )

    it.each(CASES)('matches the SDK for %s with %s', (name, _label, struct, tag, memo, size) => {
      const [bytes] = generated[struct].serialize({
        instructionDiscriminator: generated[tag],
        args: { memo: memo ?? null }
      })

      const mine = INSTRUCTION[name].encode({ memo: memo ?? null })

      expect(mine).toHaveLength(size)
      expect(Array.from(mine)).toEqual(Array.from(bytes))
    })

    it('agrees with the SDK on both discriminators', () => {
      expect(Array.from(generated.proposalApproveInstructionDiscriminator))
        .toEqual([144, 37, 164, 136, 188, 216, 42, 248])
      expect(Array.from(generated.proposalRejectInstructionDiscriminator))
        .toEqual([243, 62, 134, 156, 230, 106, 246, 135])
    })
  })

  describe('multisigCreateV2 instruction data', () => {
    /**
     * Serializes the create args with the Squads SDK.
     *
     * @param {string[]} owners - The member addresses.
     * @param {number} threshold - The approval threshold.
     * @returns {number[]} The reference bytes.
     */
    function reference (owners, threshold) {
      const [bytes] = generated.multisigCreateV2Struct.serialize({
        instructionDiscriminator: generated.multisigCreateV2InstructionDiscriminator,
        args: {
          configAuthority: null,
          threshold,
          members: owners.map((owner) => ({ key: new PublicKey(owner), permissions: { mask: 7 } })),
          timeLock: 0,
          rentCollector: null,
          memo: null
        }
      })

      return Array.from(bytes)
    }

    /**
     * Encodes a `multisigCreateV2` over the given owners, each almighty, as `deploy` does.
     *
     * @param {string[]} owners - The member addresses.
     * @param {number} threshold - The approval threshold.
     * @returns {Uint8Array} The instruction data.
     */
    function encode (owners, threshold) {
      return INSTRUCTION.multisigCreateV2.encode({
        configAuthority: null,
        threshold,
        members: owners.map((owner) => ({ address: address(owner), mask: ALMIGHTY })),
        timeLock: 0,
        rentCollector: null,
        memo: null
      })
    }

    it.each([
      [1, 1],
      [2, 2],
      [3, 2]
    ])('matches the SDK for %i owner(s) at threshold %i', (count, threshold) => {
      const owners = OWNERS.slice(0, count)

      expect(Array.from(encode(owners, threshold))).toEqual(reference(owners, threshold))
    })

    it('is 21 bytes plus 33 per owner', () => {
      expect(encode(OWNERS.slice(0, 1), 1)).toHaveLength(54)
      expect(encode(OWNERS.slice(0, 2), 2)).toHaveLength(87)
      expect(encode(OWNERS, 2)).toHaveLength(120)
    })
  })

  describe('vault transaction execution accounts', () => {
    // The program checks `remaining_accounts` positionally and by flag, so the only
    // meaningful guard is a diff against the SDK's own resolver. The stored account is
    // built with the SDK, decoded by this package, then resolved — which exercises the
    // decoder and the resolver together.
    const RECIPIENT = '2JvLzXomThTBMSj2YQY3wE21kiaSpwGyJ17nm9xiLMsE'
    const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

    /**
     * Serializes a stored `VaultTransaction` holding the given message.
     *
     * @param {Object} message - A web3.js `TransactionMessage`.
     * @param {string} vault - The vault address.
     * @param {Object[]} [lookups] - Address table lookups to attach.
     * @returns {{ account: Object, message: Object }} The account value and the stored message.
     */
    function storedTransaction (message, vault, lookups = [], ephemeralSignerBumps = []) {
      const compiled = message.compileToV0Message(lookups.map((l) => l.account))
      const { header, staticAccountKeys } = compiled

      const stored = {
        numSigners: header.numRequiredSignatures,
        numWritableSigners: header.numRequiredSignatures - header.numReadonlySignedAccounts,
        numWritableNonSigners:
          staticAccountKeys.length - header.numRequiredSignatures - header.numReadonlyUnsignedAccounts,
        accountKeys: staticAccountKeys,
        instructions: compiled.compiledInstructions.map((ix) => ({
          programIdIndex: ix.programIdIndex,
          accountIndexes: Uint8Array.from(ix.accountKeyIndexes),
          data: Uint8Array.from(ix.data)
        })),
        addressTableLookups: compiled.addressTableLookups.map((l) => ({
          accountKey: l.accountKey,
          writableIndexes: Uint8Array.from(l.writableIndexes),
          readonlyIndexes: Uint8Array.from(l.readonlyIndexes)
        }))
      }

      const data = generated.VaultTransaction.fromArgs({
        multisig: new PublicKey(TEST_MULTISIG),
        creator: new PublicKey(OWNERS[0]),
        index: 1,
        bump: 255,
        vaultIndex: 0,
        vaultBump: 255,
        ephemeralSignerBumps: Uint8Array.from(ephemeralSignerBumps),
        message: stored
      }).serialize()[0]

      return {
        account: {
          owner: SQUADS_PROGRAM_ADDRESS,
          data: [data.toString('base64'), 'base64'],
          executable: false,
          lamports: 2039280n,
          space: BigInt(data.length)
        },
        message: stored
      }
    }

    /**
     * Builds a web3.js message carrying an SPL transfer out of the vault.
     *
     * @param {string} vault - The vault address.
     * @param {boolean} createAta - Whether to prepend an ATA creation.
     * @returns {Promise<Object>} The web3.js TransactionMessage.
     */
    async function splMessage (vault, createAta) {
      const mint = address(MINT)
      const [source] = await findAssociatedTokenPda({ mint, owner: address(vault), tokenProgram: TOKEN_PROGRAM_ADDRESS })
      const [destination] = await findAssociatedTokenPda({ mint, owner: address(RECIPIENT), tokenProgram: TOKEN_PROGRAM_ADDRESS })

      const instructions = []

      if (createAta) {
        instructions.push(getCreateAssociatedTokenIdempotentInstruction({
          ata: destination, mint, owner: address(RECIPIENT), payer: address(vault)
        }))
      }

      instructions.push(getTransferInstruction({
        source, destination, authority: address(vault), amount: 1000n
      }))

      return new TransactionMessage({
        payerKey: new PublicKey(vault),
        recentBlockhash: '11111111111111111111111111111111',
        instructions: instructions.map(toWeb3)
      })
    }

    /**
     * Resolves the SDK's reference account metas for a stored message.
     *
     * @param {Object} stored - The stored message.
     * @param {string} vault - The vault address.
     * @param {Object[]} lookups - The lookup table accounts, if any.
     * @returns {Promise<Array>} The reference metas.
     */
    async function reference (stored, vault, lookups, ephemeralSignerBumps = []) {
      const { accountMetas } = await utils.accountsForTransactionExecute({
        connection: null,
        transactionPda: new PublicKey(TEST_TRANSACTION),
        vaultPda: new PublicKey(vault),
        message: stored,
        ephemeralSignerBumps,
        addressLookupTableAccounts: lookups.map((l) => l.account)
      })

      return accountMetas.map((m) => ({
        address: m.pubkey.toBase58(),
        signer: m.isSigner,
        writable: m.isWritable
      }))
    }

    /**
     * Flattens this package's roles into the SDK's flag shape.
     *
     * @param {Array} accounts - The kit account metas.
     * @returns {Array} The comparable shape.
     */
    function flatten (accounts) {
      return accounts.map(({ address: a, role }) => ({
        address: a,
        signer: role === 2 || role === 3,
        writable: role === 1 || role === 3
      }))
    }

    it.each([
      ['a SOL transfer', null],
      ['an SPL transfer', false],
      ['an SPL transfer creating the recipient account', true]
    ])('matches the SDK for %s', async (_label, createAta) => {
      const vault = TEST_OWN_VAULT
      const message = createAta === null
        ? new TransactionMessage({
          payerKey: new PublicKey(vault),
          recentBlockhash: '11111111111111111111111111111111',
          instructions: [SystemProgram.transfer({
            fromPubkey: new PublicKey(vault),
            toPubkey: new PublicKey(RECIPIENT),
            lamports: 1000
          })]
        })
        : await splMessage(vault, createAta)

      const { account: stored, message: storedMessage } = storedTransaction(message, vault)
      const decoded = account._decodeTransactionAccount(TEST_TRANSACTION, stored)

      expect(decoded.kind).toBe('vault')
      expect(decoded.vaultIndex).toBe(0)
      expect(decoded.ephemeralSignerCount).toBe(0)

      const mine = flatten(await account._resolveExecutionAccounts(decoded, vault))

      expect(mine).toEqual(await reference(storedMessage, vault, []))
    })

    it('marks the vault writable but not a signer', async () => {
      const vault = TEST_OWN_VAULT
      const message = new TransactionMessage({
        payerKey: new PublicKey(vault),
        recentBlockhash: '11111111111111111111111111111111',
        instructions: [SystemProgram.transfer({
          fromPubkey: new PublicKey(vault),
          toPubkey: new PublicKey(RECIPIENT),
          lamports: 1000
        })]
      })
      const { account: stored } = storedTransaction(message, vault)
      const decoded = account._decodeTransactionAccount(TEST_TRANSACTION, stored)
      const resolved = await account._resolveExecutionAccounts(decoded, vault)
      const vaultMeta = resolved.find((a) => a.address === vault)

      // Role 1 is writable non-signer. The program signs for the vault itself.
      expect(vaultMeta.role).toBe(1)
    })

    it('decodes the message account keys the SDK stored', async () => {
      const vault = TEST_OWN_VAULT
      const message = await splMessage(vault, true)
      const { account: stored, message: storedMessage } = storedTransaction(message, vault)
      const decoded = account._decodeTransactionAccount(TEST_TRANSACTION, stored)

      expect(decoded.message.accountKeys)
        .toEqual(storedMessage.accountKeys.map((k) => k.toBase58()))
      expect(decoded.message.numSigners).toBe(storedMessage.numSigners)
      expect(decoded.message.numWritableSigners).toBe(storedMessage.numWritableSigners)
      expect(decoded.message.numWritableNonSigners).toBe(storedMessage.numWritableNonSigners)
      expect(decoded.message.addressTableLookups).toEqual([])
    })

    it('matches the SDK when the message uses an address lookup table', async () => {
      const vault = TEST_OWN_VAULT
      const extra = OWNERS.map((o) => new PublicKey(o))
      const tableKey = new PublicKey('7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2')
      const table = {
        key: tableKey,
        state: {
          deactivationSlot: 2n ** 64n - 1n,
          lastExtendedSlot: 0,
          lastExtendedSlotStartIndex: 0,
          addresses: extra
        },
        isActive: () => true
      }

      // The transfer recipient lives only in the table, so it must be resolved from it.
      const message = new TransactionMessage({
        payerKey: new PublicKey(vault),
        recentBlockhash: '11111111111111111111111111111111',
        instructions: [SystemProgram.transfer({
          fromPubkey: new PublicKey(vault),
          toPubkey: extra[1],
          lamports: 1000
        })]
      })

      const { account: stored, message: storedMessage } =
        storedTransaction(message, vault, [{ account: table }])
      const decoded = account._decodeTransactionAccount(TEST_TRANSACTION, stored)

      expect(decoded.message.addressTableLookups).toHaveLength(1)
      expect(decoded.message.addressTableLookups[0].accountKey).toBe(tableKey.toBase58())

      const fetchMock = stubSolanaRpc({
        getMultipleAccounts: () => multipleAccounts([
          lookupTableAccount(ADDRESS_LOOKUP_TABLE_PROGRAM, extra.map((key) => key.toBytes()))
        ])
      })

      const mine = flatten(await account._resolveExecutionAccounts(decoded, vault))

      // The table was read by address, and read once.
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(JSON.parse(fetchMock.mock.calls[0][1].body).params[0])
        .toEqual([tableKey.toBase58()])

      expect(mine).toEqual(await reference(storedMessage, vault, [{ account: table }]))

      // Group 1 first, group 3 last.
      expect(mine[0].address).toBe(tableKey.toBase58())
      expect(mine[mine.length - 1].address).toBe(extra[1].toBase58())
    })

    it('matches the SDK when the message needs ephemeral signers', async () => {
      const vault = TEST_OWN_VAULT
      const [ephemeral] = multisig.getEphemeralSignerPda({
        transactionPda: new PublicKey(TEST_TRANSACTION),
        ephemeralSignerIndex: 0
      })

      // A transfer *from* the ephemeral signer, so the message marks it a writable signer.
      const message = new TransactionMessage({
        payerKey: new PublicKey(vault),
        recentBlockhash: '11111111111111111111111111111111',
        instructions: [SystemProgram.transfer({
          fromPubkey: ephemeral,
          toPubkey: new PublicKey(RECIPIENT),
          lamports: 1000
        })]
      })

      const { account: stored, message: storedMessage } =
        storedTransaction(message, vault, [], [255])
      const decoded = account._decodeTransactionAccount(TEST_TRANSACTION, stored)

      expect(decoded.ephemeralSignerCount).toBe(1)
      expect(decoded.address).toBe(TEST_TRANSACTION)

      const mine = flatten(await account._resolveExecutionAccounts(decoded, vault))

      expect(mine).toEqual(await reference(storedMessage, vault, [], [255]))
      expect(mine.find((a) => a.address === ephemeral.toBase58()))
        .toEqual({ address: ephemeral.toBase58(), signer: false, writable: true })
    })

    it('derives ephemeral signer addresses the SDK agrees with', async () => {
      const mine = await account._getEphemeralSignerPdas(TEST_TRANSACTION, 3)

      expect(mine).toEqual([0, 1, 2].map((i) => multisig.getEphemeralSignerPda({
        transactionPda: new PublicKey(TEST_TRANSACTION),
        ephemeralSignerIndex: i
      })[0].toBase58()))
    })

    it('refuses a lookup table that no longer exists', async () => {
      const vault = TEST_OWN_VAULT
      const extra = OWNERS.map((o) => new PublicKey(o))
      const table = {
        key: new PublicKey('7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2'),
        state: { deactivationSlot: 2n ** 64n - 1n, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses: extra },
        isActive: () => true
      }
      const message = new TransactionMessage({
        payerKey: new PublicKey(vault),
        recentBlockhash: '11111111111111111111111111111111',
        instructions: [SystemProgram.transfer({
          fromPubkey: new PublicKey(vault), toPubkey: extra[1], lamports: 1000
        })]
      })
      const { account: stored } = storedTransaction(message, vault, [{ account: table }])
      const decoded = account._decodeTransactionAccount(TEST_TRANSACTION, stored)

      stubSolanaRpc({ getMultipleAccounts: () => multipleAccounts([null]) })

      await expect(account._resolveExecutionAccounts(decoded, vault))
        .rejects.toThrow(/does not exist, so the transaction.s accounts cannot be resolved/)
    })

    it('refuses an account at the lookup table address that is not a lookup table', async () => {
      const vault = TEST_OWN_VAULT
      const extra = OWNERS.map((o) => new PublicKey(o))
      const table = {
        key: new PublicKey('7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2'),
        state: { deactivationSlot: 2n ** 64n - 1n, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses: extra },
        isActive: () => true
      }
      const message = new TransactionMessage({
        payerKey: new PublicKey(vault),
        recentBlockhash: '11111111111111111111111111111111',
        instructions: [SystemProgram.transfer({
          fromPubkey: new PublicKey(vault), toPubkey: extra[1], lamports: 1000
        })]
      })
      const { account: stored } = storedTransaction(message, vault, [{ account: table }])
      const decoded = account._decodeTransactionAccount(TEST_TRANSACTION, stored)

      stubSolanaRpc({
        getMultipleAccounts: () => multipleAccounts([
          lookupTableAccount(SQUADS_PROGRAM_ADDRESS, extra.map((key) => key.toBytes()))
        ])
      })

      await expect(account._resolveExecutionAccounts(decoded, vault))
        .rejects.toThrow(/does not exist/)
    })

  })

  describe('vault transaction message', () => {
    // The instruction argument uses one-byte length prefixes; the message the program
    // stores from it uses four-byte ones. Getting the two confused yields an unparseable
    // message, so this diff is the guard.
    const RECIPIENT = '2JvLzXomThTBMSj2YQY3wE21kiaSpwGyJ17nm9xiLMsE'

    /**
     * Builds the reference message with the Squads SDK.
     *
     * @param {string} vault - The vault address.
     * @param {bigint} value - The lamports to transfer.
     * @returns {number[]} The reference bytes.
     */
    function reference (vault, value) {
      const message = new TransactionMessage({
        payerKey: new PublicKey(vault),
        recentBlockhash: '11111111111111111111111111111111',
        instructions: [
          SystemProgram.transfer({
            fromPubkey: new PublicKey(vault),
            toPubkey: new PublicKey(RECIPIENT),
            lamports: value
          })
        ]
      })

      return Array.from(
        utils.transactionMessageToMultisigTransactionMessageBytes({
          message,
          vaultPda: new PublicKey(vault)
        })
      )
    }

    /**
     * Proposes a transfer and returns the message `vaultTransactionCreate` carries, which is the
     * one the program stores. Driving `propose` rather than the compiler keeps the account roles
     * and the transfer instruction inside what is being diffed.
     *
     * @param {bigint} value - The lamports to transfer.
     * @returns {Promise<number[]>} The message bytes.
     */
    async function proposedMessage (value) {
      stubSolanaRpc({
        getAccountInfo: () => ({ context: { slot: 1 }, value: multisigAccount() }),
        getMinimumBalanceForRentExemption: () => 1000000
      })

      const sendTransaction = jest.fn(async () => ({ hash: DUMMY_SIGNATURE, fee: 5000n }))

      account._signerAccount.sendTransaction = sendTransaction

      await account.propose({ to: RECIPIENT, value })

      // vaultTransactionCreate: discriminator(8), vaultIndex(1), ephemeralSigners(1), then the
      // message behind a u32 length.
      const { data } = sendTransaction.mock.calls[0][0].instructions[0]
      const length = new DataView(data.buffer, data.byteOffset).getUint32(10, true)

      return Array.from(data.slice(14, 14 + length))
    }

    it.each([1n, 1000000n, 18446744073709551615n])(
      'matches the SDK for a transfer of %s lamports',
      async (value) => {
        expect(await proposedMessage(value)).toEqual(reference(TEST_OWN_VAULT, value))
      }
    )

    it('is 120 bytes for a native transfer', async () => {
      expect(await proposedMessage(1n)).toHaveLength(120)
    })

    /**
     * Proposes a transfer from the given vault and returns the whole instruction data, so the
     * stored vault index and the stored message can be read from the same bytes.
     *
     * @param {number} [vaultIndex] - The vault to spend from.
     * @returns {Promise<Uint8Array>} The `vaultTransactionCreate` data.
     */
    async function proposedData (vaultIndex) {
      stubSolanaRpc({
        getAccountInfo: () => ({ context: { slot: 1 }, value: multisigAccount() }),
        getMinimumBalanceForRentExemption: () => 1000000
      })

      const sendTransaction = jest.fn(async () => ({ hash: DUMMY_SIGNATURE, fee: 5000n }))

      account._signerAccount.sendTransaction = sendTransaction

      await account.propose({ to: RECIPIENT, value: 1n }, { vaultIndex })

      return sendTransaction.mock.calls[0][0].instructions[0].data
    }

    // The one pairing that cannot be checked from either half alone: the program derives the
    // signing vault from the stored index, so a message compiled for a different vault would
    // create a proposal that only fails at execution.
    it('stores the index of the vault the message was compiled for', async () => {
      const data = await proposedData(3)
      const length = new DataView(data.buffer, data.byteOffset).getUint32(10, true)

      expect(data[8]).toBe(3)
      expect(Array.from(data.slice(14, 14 + length))).toEqual(reference(TEST_OWN_VAULT_3, 1n))
    })

    it('stores vault 0 when the options name none', async () => {
      const data = await proposedData()
      const length = new DataView(data.buffer, data.byteOffset).getUint32(10, true)

      expect(data[8]).toBe(0)
      expect(Array.from(data.slice(14, 14 + length))).toEqual(reference(TEST_OWN_VAULT, 1n))
    })

  })

  describe('spl transfer message', () => {
    const RECIPIENT = '2JvLzXomThTBMSj2YQY3wE21kiaSpwGyJ17nm9xiLMsE'
    const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

    /**
     * Builds the transfer instructions, optionally preceded by an ATA creation.
     *
     * @param {string} vault - The vault address.
     * @param {boolean} createAta - Whether to include the creation instruction.
     * @returns {Promise<Object[]>} The kit instructions.
     */
    async function buildInstructions (vault, createAta) {
      const mint = address(MINT)
      const [source] = await findAssociatedTokenPda({ mint, owner: address(vault), tokenProgram: TOKEN_PROGRAM_ADDRESS })
      const [destination] = await findAssociatedTokenPda({ mint, owner: address(RECIPIENT), tokenProgram: TOKEN_PROGRAM_ADDRESS })

      const instructions = []

      if (createAta) {
        instructions.push(getCreateAssociatedTokenIdempotentInstruction({
          ata: destination,
          mint,
          owner: address(RECIPIENT),
          payer: address(vault)
        }))
      }

      instructions.push(getTransferInstruction({
        source,
        destination,
        authority: address(vault),
        amount: 1000000n
      }))

      return instructions
    }

    it.each([
      ['the recipient already holds the token', false, 150],
      ['the recipient token account must be created', true, 289]
    ])('matches the SDK when %s', async (_label, createAta, size) => {
      const vault = TEST_OWN_VAULT
      const instructions = await buildInstructions(vault, createAta)

      const mine = account._compileTransactionMessage(address(vault), instructions).bytes
      const reference = utils.transactionMessageToMultisigTransactionMessageBytes({
        message: new TransactionMessage({
          payerKey: new PublicKey(vault),
          recentBlockhash: '11111111111111111111111111111111',
          instructions: instructions.map(toWeb3)
        }),
        vaultPda: new PublicKey(vault)
      })

      expect(mine).toHaveLength(size)
      expect(Array.from(mine)).toEqual(Array.from(reference))
    })
  })

  // The other half of the same subject: the encoders above are diffed against the SDK, and
    // these assert that the public methods actually call them — with which arguments, in which
    // order, over which accounts. An encoder can be byte-perfect and still be wired up wrong.
  describe('instruction assembly', () => {
      let sent

      beforeEach(() => {
        sent = []
      })

    /**
     * Serves the reads a write path makes and records what it submits.
     *
     * @param {Object} [accounts] - The account each address resolves to, keyed by address.
     * @returns {Object} The `fetch` mock.
     */
    function serve (accounts = {}) {
      return stubSolanaRpc({
        getAccountInfo: ([address]) => ({ context: { slot: 1 }, value: accounts[address] ?? null }),
        getMultipleAccounts: ([addresses]) => ({
          context: { slot: 1 },
          value: addresses.map((address) => accounts[address] ?? null)
        }),
        getMinimumBalanceForRentExemption: () => 1000000,
        getLatestBlockhash: () => ({
          context: { slot: 1 },
          value: { blockhash: DUMMY_BLOCKHASH, lastValidBlockHeight: 100 }
        }),
        getFeeForMessage: () => ({ context: { slot: 1 }, value: 5000 }),
        sendTransaction: ([transaction]) => {
          sent.push(transaction)

          return DUMMY_SIGNATURE
        }
      })
    }

    /**
     * Returns the instructions of the single transaction submitted so far.
     *
     * @returns {Object[]} The decoded instructions.
     */
    function submitted () {
      expect(sent).toHaveLength(1)

      return submittedInstructions(sent[0])
    }

    /**
     * Returns the shape of the single transaction's instructions.
     *
     * @returns {Object[]} Each instruction's program, discriminator and accounts.
     */
    function submittedShapes () {
      return submitted().map(instructionShape)
    }

    /**
     * Names an account the way the decoded instructions report it.
     *
     * @param {string} address - The account's address.
     * @param {Object} [roles] - `signer` and `writable`.
     * @returns {Object} The expected account.
     */
    function role (address, { signer = false, writable = false } = {}) {
      return { address, signer, writable }
    }

    describe('deploy', () => {
      it('submits one multisigCreateV2 over the program config, treasury, multisig, create key and creator', async () => {
        serve({ [PROGRAM_CONFIG]: programConfigAccount() })

        await account.deploy([SIGNER], 1)

        const [instruction, ...rest] = submittedShapes()

        expect(rest).toEqual([])
        expect(instruction.programAddress).toBe(SQUADS_PROGRAM_ADDRESS)
        expect(instruction.discriminator)
          .toEqual([...generated.multisigCreateV2InstructionDiscriminator])
        expect(instruction.accounts.map(({ address }) => address)).toEqual([
          PROGRAM_CONFIG,
          TREASURY,
          TEST_OWN_MULTISIG,
          CREATE_KEY,
          SIGNER,
          SYSTEM_PROGRAM
        ])
        expect(instruction.accounts.filter(({ signer }) => signer).map(({ address }) => address))
          .toEqual([CREATE_KEY, SIGNER])
      })
    })

    describe('propose', () => {
      it('submits vaultTransactionCreate then proposalCreate at the next index', async () => {
        serve({ [TEST_OWN_MULTISIG]: multisigAccount() })

        await account.propose({ to: PAYEE, value: 1000n })

        const [create, propose, ...rest] = submittedShapes()

        expect(rest).toEqual([])
        expect(create.discriminator)
          .toEqual([...generated.vaultTransactionCreateInstructionDiscriminator])
        expect(create.accounts).toEqual([
          role(TEST_OWN_MULTISIG, { writable: true }),
          role(NEXT_TRANSACTION, { writable: true }),
          role(SIGNER, { signer: true, writable: true }),
          role(SIGNER, { signer: true, writable: true }),
          role(SYSTEM_PROGRAM)
        ])

        expect(propose.discriminator).toEqual([...generated.proposalCreateInstructionDiscriminator])
        expect(propose.accounts).toEqual([
          role(TEST_OWN_MULTISIG, { writable: true }),
          role(NEXT_PROPOSAL, { writable: true }),
          role(SIGNER, { signer: true, writable: true }),
          role(SIGNER, { signer: true, writable: true }),
          role(SYSTEM_PROGRAM)
        ])
      })

      it('submits the vaultTransactionCreate args the SDK builds, in full', async () => {
        serve({ [TEST_OWN_MULTISIG]: multisigAccount() })

        await account.propose({ to: PAYEE, value: 1000n })

        const reference = multisig.instructions.vaultTransactionCreate({
          multisigPda: ownMultisigKey,
          transactionIndex: 1n,
          creator: new PublicKey(SIGNER),
          vaultIndex: 0,
          ephemeralSigners: 0,
          transactionMessage: new TransactionMessage({
            payerKey: new PublicKey(TEST_OWN_VAULT),
            recentBlockhash: DUMMY_BLOCKHASH,
            instructions: [SystemProgram.transfer({
              fromPubkey: new PublicKey(TEST_OWN_VAULT),
              toPubkey: new PublicKey(PAYEE),
              lamports: 1000
            })]
          })
        })

        expect(submitted()[0].data).toEqual(Buffer.from(reference.data))
      })

      it('appends proposalApprove and vaultTransactionExecute when auto-executing', async () => {
        serve({ [TEST_OWN_MULTISIG]: multisigAccount() })

        await account.propose({ to: PAYEE, value: 1000n }, { autoExecute: true })

        const instructions = submittedShapes()

        expect(instructions.map(({ discriminator }) => discriminator)).toEqual([
          [...generated.vaultTransactionCreateInstructionDiscriminator],
          [...generated.proposalCreateInstructionDiscriminator],
          [...generated.proposalApproveInstructionDiscriminator],
          [...generated.vaultTransactionExecuteInstructionDiscriminator]
        ])

        const execute = instructions[3]

        // One role per account per message, unioned across instructions: the multisig and the
        // transaction are writable because the two create instructions ahead of this one need
        // them so, even though execute alone would take both read-only.
        expect(execute.accounts.slice(0, 4)).toEqual([
          role(TEST_OWN_MULTISIG, { writable: true }),
          role(NEXT_PROPOSAL, { writable: true }),
          role(NEXT_TRANSACTION, { writable: true }),
          role(SIGNER, { signer: true, writable: true })
        ])
        expect(execute.accounts.slice(4).map(({ address }) => address))
          .toEqual([TEST_OWN_VAULT, PAYEE, SYSTEM_PROGRAM])
      })

      it('proposes the instructions a message carries, byte-for-byte with the SDK', async () => {
        serve({ [TEST_OWN_MULTISIG]: multisigAccount() })

        const vault = new PublicKey(TEST_OWN_VAULT)
        const transfer = SystemProgram.transfer({
          fromPubkey: vault, toPubkey: new PublicKey(PAYEE), lamports: 1000
        })
        const memo = new TransactionInstruction({
          programId: new PublicKey(MEMO_PROGRAM),
          keys: [{ pubkey: vault, isSigner: true, isWritable: false }],
          data: Buffer.from('hi')
        })

        const expected = Array.from(utils.transactionMessageToMultisigTransactionMessageBytes({
          message: new TransactionMessage({
            payerKey: vault,
            recentBlockhash: '11111111111111111111111111111111',
            instructions: [transfer, memo]
          }),
          vaultPda: vault
        }))

        await account.propose({ instructions: [transfer, memo].map(toKitInstruction) })

        const [create] = submitted()

        expect(proposedMessageBytes(create.data)).toEqual(expected)
      })

      it('refuses an instruction needing a signature the vault cannot give', async () => {
        serve({ [TEST_OWN_MULTISIG]: multisigAccount() })

        const error = await account.propose({
          instructions: [{
            programAddress: MEMO_PROGRAM,
            accounts: [{ address: SIGNER, role: 3 }],
            data: new Uint8Array([1])
          }]
        }).catch((thrown) => thrown)

        expect(error.message)
          .toBe(`The instruction needs ${SIGNER} to sign, which the vault ${TEST_OWN_VAULT} cannot do.`)
      })

      it('refuses a message that pays from somewhere else', async () => {
        serve({ [TEST_OWN_MULTISIG]: multisigAccount() })

        const error = await account.propose({
          feePayer: SIGNER,
          instructions: [{ programAddress: MEMO_PROGRAM, accounts: [], data: new Uint8Array([1]) }]
        }).catch((thrown) => thrown)

        expect(error.message)
          .toBe(`The transaction pays from ${SIGNER}, but a proposal executes from the vault ${TEST_OWN_VAULT}.`)
      })

    it('leaves the flag inert above threshold 1', async () => {
        serve({ [TEST_OWN_MULTISIG]: multisigAccount({ owners: [SIGNER, SECOND_OWNER], threshold: 2 }) })

        await account.propose({ to: PAYEE, value: 1000n }, { autoExecute: true })

        expect(submittedShapes()).toHaveLength(2)
      })
    })

    describe('changeThreshold', () => {
      it('submits configTransactionCreate then proposalCreate', async () => {
        serve({ [TEST_OWN_MULTISIG]: multisigAccount({ owners: [SIGNER, SECOND_OWNER], threshold: 1 }) })

        await account.changeThreshold(2)

        const [create, propose, ...rest] = submittedShapes()

        expect(rest).toEqual([])
        expect(create.discriminator)
          .toEqual([...generated.configTransactionCreateInstructionDiscriminator])
        expect(create.accounts).toEqual([
          role(TEST_OWN_MULTISIG, { writable: true }),
          role(NEXT_TRANSACTION, { writable: true }),
          role(SIGNER, { signer: true, writable: true }),
          role(SIGNER, { signer: true, writable: true }),
          role(SYSTEM_PROGRAM)
        ])
        expect(propose.discriminator).toEqual([...generated.proposalCreateInstructionDiscriminator])
      })
    })

    describe('approveProposal', () => {
      it('submits one proposalApprove over the multisig, member and proposal', async () => {
        serve({ [TEST_OWN_MULTISIG]: multisigAccount(), [NEXT_PROPOSAL]: proposalAccount() })

        await account.approveProposal(1)

        const [instruction, ...rest] = submittedShapes()

        expect(rest).toEqual([])
        expect(instruction.discriminator)
          .toEqual([...generated.proposalApproveInstructionDiscriminator])
        expect(instruction.accounts).toEqual([
          role(TEST_OWN_MULTISIG),
          role(SIGNER, { signer: true, writable: true }),
          role(NEXT_PROPOSAL, { writable: true })
        ])
      })
    })

    describe('rejectProposal', () => {
      it('submits one proposalReject over the same accounts', async () => {
        serve({ [TEST_OWN_MULTISIG]: multisigAccount(), [NEXT_PROPOSAL]: proposalAccount() })

        await account.rejectProposal(1)

        const [instruction, ...rest] = submittedShapes()

        expect(rest).toEqual([])
        expect(instruction.discriminator)
          .toEqual([...generated.proposalRejectInstructionDiscriminator])
        expect(instruction.accounts).toEqual([
          role(TEST_OWN_MULTISIG),
          role(SIGNER, { signer: true, writable: true }),
          role(NEXT_PROPOSAL, { writable: true })
        ])
      })
    })

    it('keeps the clock sysvar out of the instructions it submits', async () => {
      serve({
        [TEST_OWN_MULTISIG]: multisigAccount(),
        [NEXT_PROPOSAL]: proposalAccount(),
        [CLOCK_SYSVAR]: rpcAccount(Buffer.alloc(40), SYSTEM_PROGRAM)
      })

      await account.approveProposal(1)

      for (const instruction of submittedShapes()) {
        expect(instruction.accounts.map(({ address }) => address)).not.toContain(CLOCK_SYSVAR)
      }
    })
  })
})
