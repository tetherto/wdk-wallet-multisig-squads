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

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals'

import { getBase58Decoder, getBase58Encoder, getBase64Decoder, getBase64Encoder } from '@solana/codecs'

import { InvalidTokenError, NoSuchElementError, NotImplementedError, ProviderRequiredError, UnsupportedOperationError, WdkError } from '@tetherto/wdk-wallet'

import { rpcRequests, stubSolanaRpc } from './helpers/rpc.js'

import {
  WalletAccountReadOnlyMultisigSquads,
  SQUADS_PROGRAM_ADDRESS
} from '@tetherto/wdk-wallet-multisig-squads'

const TEST_RPC_URL = 'https://dummy-url.com'
const TEST_MULTISIG_PDA = 'EEPqJbpYrwqisgoPt3Vu74YBqRji8mFrRxQdARVfDuNG'
const SYSTEM_PROGRAM_ADDRESS = '11111111111111111111111111111111'

// The create key and the multisig address it derives to, cross-checked against
// `getMultisigPda` from @sqds/multisig.
const TEST_CREATE_KEY = 'GjwcWFQYzemBtpUoN5fMAP2FZviTtMRWCmrppGuTthJS'
const TEST_DERIVED_PDA = '882sFcorKiAAx51q86HcH2Lr8m1WGmAAuuiRFaNX9PR2'

const toBase64 = (bytes) => getBase64Decoder().decode(Uint8Array.from(bytes))

const MULTISIG_DISCRIMINATOR = [224, 116, 121, 186, 68, 161, 79, 236]
// The discriminator of the Squads `ProgramConfig` account: a real account type
// owned by the same program, so it must not be mistaken for a multisig.
const PROGRAM_CONFIG_DISCRIMINATOR = [196, 210, 90, 231, 144, 149, 140, 63]

// Members are stored sorted by raw pubkey bytes, which is *not* base58-string
// order. These two are deliberately chosen so the two orders disagree: MEMBER_A
// starts with byte 6 and MEMBER_B with byte 19, so this is on-chain order — but
// as strings '2Jv…' sorts before 'QqC…', so a naive sort would swap them.
const MEMBER_A = 'QqCCvshxtqMAL2CVALqiJB7uEeE8mjSPsFUruTpXtRz'
const MEMBER_B = '2JvLzXomThTBMSj2YQY3wE21kiaSpwGyJ17nm9xiLMsE'
const MEMBER_C = 'GjwcWFQYzemBtpUoN5fMAP2FZviTtMRWCmrppGuTthJS'

/**
 * Serializes a `Multisig` account's data.
 *
 * @param {Object} options - The account contents.
 * @param {Array<{ address: string, mask?: number }>} options.members - The members.
 * @param {boolean} [options.rentCollector=false] - Whether `rentCollector` is set.
 * @param {number} [options.threshold=1] - The approval threshold.
 * @param {bigint} [options.transactionIndex=0n] - The index of the latest transaction.
 * @param {number[]} [options.discriminator] - An override for the discriminator.
 * @param {number} [options.slack=0] - Trailing unused bytes, as Squads pre-allocates.
 * @returns {string} The account data, base64-encoded.
 */
function encodeMultisigAccount ({
  members,
  rentCollector = false,
  threshold = 1,
  transactionIndex = 0n,
  timeLock = 0,
  staleTransactionIndex = 0n,
  discriminator = MULTISIG_DISCRIMINATOR,
  slack = 0
}) {
  const size = 95 + (rentCollector ? 32 : 0) + 1 + 4 + members.length * 33 + slack
  const data = new Uint8Array(size)
  const view = new DataView(data.buffer)

  data.set(discriminator, 0)
  view.setUint16(72, threshold, true)
  view.setUint32(74, timeLock, true)
  view.setBigUint64(78, transactionIndex, true)
  view.setBigUint64(86, staleTransactionIndex, true)

  let offset = 94

  // `rentCollector`: a 1-byte Option tag, then the pubkey only when set.
  data[offset] = rentCollector ? 1 : 0
  offset += 1
  if (rentCollector) {
    data.set(getBase58Encoder().encode(MEMBER_C), offset)
    offset += 32
  }

  data[offset] = 255 // bump
  offset += 1

  view.setUint32(offset, members.length, true)
  offset += 4

  for (const { address: memberAddress, mask = 7 } of members) {
    data.set(getBase58Encoder().encode(memberAddress), offset)
    data[offset + 32] = mask
    offset += 33
  }

  return getBase64Decoder().decode(data)
}

/**
 * Builds an RPC `value` for a `Multisig` account owned by the Squads program.
 *
 * @param {Object} options - Passed through to {@link encodeMultisigAccount}.
 * @returns {Object} The `value` field of a `getAccountInfo` response.
 */
function multisigAccountValue (options) {
  return {
    owner: SQUADS_PROGRAM_ADDRESS,
    data: [encodeMultisigAccount(options), 'base64'],
    executable: false,
    lamports: 2039280,
    space: 165
  }
}

/**
 * Builds a read-only account whose RPC returns a fixed `getAccountInfo` result.
 *
 * @param {Object|null} value - The `value` field of the RPC response.
 * @param {Object} [config] - Extra config for the account.
 * @returns {{ account: WalletAccountReadOnlyMultisigSquads, rpc: Object }}
 */
function mockAccount (value, config = { multisigPdaOrCreateKey: TEST_MULTISIG_PDA }) {
  const account = new WalletAccountReadOnlyMultisigSquads({
    provider: TEST_RPC_URL,
    commitment: 'confirmed',
    ...config
  })

  const rpc = stubSolanaRpc({ getAccountInfo: () => ({ context: { slot: 1 }, value }) })

  return { account, rpc }
}

// Vault PDAs for TEST_MULTISIG_PDA, derived independently of the code under test
// and cross-checked against `getVaultPda` from @sqds/multisig.
const TEST_VAULT_0 = '6soQChwEoXXbAo17wNPdfLFaxzrAjiAxPif9nbJkDXCm'
const TEST_VAULT_3 = '9tyW4GZWSMPZj8KSsVKsVjJvnVaE4mJjsg77TznzQfcs'
const TEST_VAULT_255 = '486r7kq6wj3j84WvhD19SZRCNZbaDFXomiawL7yNfN9s'

/**
 * Builds a read-only account whose RPC returns a fixed `getBalance` result.
 *
 * @param {bigint} lamports - The balance to report.
 * @param {Object} [config] - Extra config for the account.
 * @returns {{ account: WalletAccountReadOnlyMultisigSquads, rpc: Object }}
 */
function mockBalanceAccount (lamports, config = { multisigPdaOrCreateKey: TEST_MULTISIG_PDA }) {
  const account = new WalletAccountReadOnlyMultisigSquads({
    provider: TEST_RPC_URL,
    commitment: 'confirmed',
    ...config
  })

  const rpc = stubSolanaRpc({ getBalance: () => ({ context: { slot: 1 }, value: lamports }) })

  return { account, rpc }
}

// Real mint addresses, and the legacy-SPL associated token accounts they derive to
// under TEST_VAULT_0 / TEST_VAULT_3. Derived with `findAssociatedTokenPda`.
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const USDC_ATA_VAULT_0 = 'HjTmApEb1hKe9snNpoqkv8HrXaEDSvhEJbsDVtBwZTsA'
const USDC_ATA_VAULT_3 = 'AAd5adJNrMXHupG13WMvDzenYdVua77LEAbnJ89yRBwS'
const TOKEN_2022_ATA_VAULT_0 = 'mKKRTmYrT4YywefDUvszdEqz7nm1oddDd6QRXn1snfz'
// A real Token-2022 mint. See the @todo on getTokenBalance.
const TOKEN_2022_MINT = '7atgF8KQo4wJrD5ATGX7t1V2zVvykPJbFfNeVf1icFv1'

/**
 * Builds a read-only account whose RPC returns a fixed token account.
 *
 * @param {string|null} amount - The token amount as the RPC reports it, or null for
 *   a non-existent account.
 * @param {Object} [config] - Extra config for the account.
 * @returns {{ account: WalletAccountReadOnlyMultisigSquads, rpc: Object }}
 */
function mockTokenAccount (amount, config = { multisigPdaOrCreateKey: TEST_MULTISIG_PDA }) {
  const account = new WalletAccountReadOnlyMultisigSquads({
    provider: TEST_RPC_URL,
    commitment: 'confirmed',
    ...config
  })

  const value = amount === null
    ? null
    : {
        owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        data: { parsed: { info: { tokenAmount: { amount, decimals: 6 } } }, program: 'spl-token' },
        executable: false,
        lamports: 2039280,
        space: 165
      }

  const rpc = stubSolanaRpc({ getAccountInfo: () => ({ context: { slot: 1 }, value }) })

  return { account, rpc }
}

// Proposal PDAs for TEST_MULTISIG_PDA at transaction indices 1..3, cross-checked
// against `getProposalPda` from @sqds/multisig.
const PROPOSAL_PDA_1 = 'AhijzMHF6KLNfJpPvAwVZFDhY55MqPR3DGv1EMGVuKzF'
const TRANSACTION_PDA_1 = 'F5HSv8x8sVPUuDc9CfG9mm6fFSReXfd5xz6Nage658nb'
const PROPOSAL_PDA_2 = '5cA2xHRERqHDFnrsP6M6Mfx9rZ725o1qcQVjtFSq45mZ'
const PROPOSAL_DISCRIMINATOR = [26, 94, 189, 187, 116, 136, 53, 33]

const PROPOSAL_STATUS = {
  Draft: 0,
  Active: 1,
  Rejected: 2,
  Approved: 3,
  Executing: 4,
  Executed: 5,
  Cancelled: 6
}

/**
 * Serializes a `Proposal` account's data.
 *
 * @param {Object} options - The account contents.
 * @param {number} [options.status=1] - The status discriminant.
 * @param {string[]} [options.approved=[]] - Members that approved.
 * @param {string[]} [options.rejected=[]] - Members that rejected.
 * @param {string[]} [options.cancelled=[]] - Members that cancelled.
 * @param {number[]} [options.discriminator] - An override for the discriminator.
 * @param {number} [options.slack=0] - Trailing unused bytes, as Squads pre-allocates.
 * @returns {string} The account data, base64-encoded.
 */
function encodeProposalAccount ({
  status = PROPOSAL_STATUS.Active,
  statusTimestamp = 0n,
  approved = [],
  rejected = [],
  cancelled = [],
  discriminator = PROPOSAL_DISCRIMINATOR,
  slack = 0
}) {
  // The status is a data enum: every variant carries an i64 timestamp except
  // Executing, which carries nothing and so shifts everything after it by 8.
  const statusSize = status === PROPOSAL_STATUS.Executing ? 1 : 9
  const vecs = [approved, rejected, cancelled]
  const size =
    48 + statusSize + 1 +
    vecs.reduce((total, v) => total + 4 + v.length * 32, 0) +
    slack

  const data = new Uint8Array(size)
  const view = new DataView(data.buffer)

  data.set(discriminator, 0)
  data[48] = status

  if (status !== PROPOSAL_STATUS.Executing) {
    view.setBigInt64(49, statusTimestamp, true)
  }

  let offset = 48 + statusSize
  data[offset] = 255 // bump
  offset += 1

  for (const members of vecs) {
    view.setUint32(offset, members.length, true)
    offset += 4
    for (const member of members) {
      data.set(getBase58Encoder().encode(member), offset)
      offset += 32
    }
  }

  return getBase64Decoder().decode(data)
}

/**
 * Builds an RPC `value` for a `Proposal` account owned by the Squads program.
 *
 * @param {Object} options - Passed through to {@link encodeProposalAccount}.
 * @returns {Object} The `value` field of a `getMultipleAccounts` entry.
 */
function proposalAccountValue (options) {
  return {
    owner: SQUADS_PROGRAM_ADDRESS,
    data: [encodeProposalAccount(options), 'base64'],
    executable: false,
    lamports: 2039280,
    space: 454
  }
}

/**
 * Builds a read-only account whose RPC serves a multisig and a set of proposals.
 *
 * @param {Array<Object|null>} proposals - The `getMultipleAccounts` entries to return,
 *   in order across all chunks.
 * @param {Object} [multisig] - The multisig account, or null to report it missing.
 * @returns {{ account: WalletAccountReadOnlyMultisigSquads, rpc: Object }}
 */
function mockProposals (proposals, multisig = multisigAccountValue({
  members: [{ address: MEMBER_A }, { address: MEMBER_B }],
  threshold: 2
})) {
  const account = new WalletAccountReadOnlyMultisigSquads({
    provider: TEST_RPC_URL,
    commitment: 'confirmed',
    multisigPdaOrCreateKey: TEST_MULTISIG_PDA
  })

  const remaining = [...proposals]
  const rpc = stubSolanaRpc({
    getAccountInfo: () => ({ context: { slot: 1 }, value: multisig }),
    getMultipleAccounts: ([addresses]) => ({
      context: { slot: 1 },
      value: remaining.splice(0, addresses.length)
    })
  })

  return { account, rpc }
}

const VAULT_TRANSACTION_DISCRIMINATOR = [168, 250, 162, 100, 81, 14, 162, 207]
const CONFIG_TRANSACTION_DISCRIMINATOR = [94, 8, 4, 35, 113, 139, 139, 112]
const BATCH_DISCRIMINATOR = [156, 194, 70, 44, 22, 88, 137, 44]
const CLOCK_SYSVAR_ADDRESS = 'SysvarC1ock11111111111111111111111111111111'

/**
 * Builds an RPC `value` for a transaction account. A vault transaction is serialized in full,
 * since the read paths decode it; the other kinds are read for their discriminator alone.
 *
 * @param {number[]} discriminator - The account discriminator.
 * @returns {Object} The `value` field of a `getMultipleAccounts` entry.
 */
function transactionAccountValue (discriminator) {
  const isVault = discriminator === VAULT_TRANSACTION_DISCRIMINATOR
  const isConfig = discriminator === CONFIG_TRANSACTION_DISCRIMINATOR
  const accountKeys = [MEMBER_A, MEMBER_B, SYSTEM_PROGRAM_ADDRESS]
  // A vault transaction: 87 fixed fields, no ephemeral bumps, then the message, 3 header bytes,
  // the key vec, and empty instruction and lookup vecs. A config transaction: 81 fixed fields
  // then an empty action vec. Any other kind is read for its discriminator alone.
  const size = isVault
    ? 87 + 3 + 4 + accountKeys.length * 32 + 4 + 4
    : (isConfig ? 85 : 8)
  const data = new Uint8Array(size)

  data.set(discriminator, 0)

  if (isVault) {
    const view = new DataView(data.buffer)

    data.set([1, 1, 1], 87)
    view.setUint32(90, accountKeys.length, true)

    accountKeys.forEach((key, index) => {
      data.set(getBase58Encoder().encode(key), 94 + index * 32)
    })
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
 * Builds an RPC `value` for the Clock sysvar.
 *
 * @param {bigint} unixTimestamp - The cluster time to report.
 * @returns {Object} The `value` field of a `getMultipleAccounts` entry.
 */
function clockAccountValue (unixTimestamp) {
  const data = new Uint8Array(40)

  new DataView(data.buffer).setBigInt64(32, unixTimestamp, true)

  return {
    owner: 'Sysvar1111111111111111111111111111111111111',
    data: [getBase64Decoder().decode(data), 'base64'],
    executable: false,
    lamports: 1169280,
    space: 40
  }
}

/**
 * Builds a read-only account whose RPC serves the four accounts
 * `isReadyToExecute` reads.
 *
 * @param {Object} options - The scenario.
 * @param {number} [options.status=3] - The proposal status discriminant.
 * @param {bigint} [options.approvedAt=1000n] - The proposal's status timestamp.
 * @param {bigint} [options.now=1000n] - The cluster time.
 * @param {number} [options.timeLock=0] - The multisig's time lock, in seconds.
 * @param {bigint} [options.staleTransactionIndex=0n] - The multisig's stale index.
 * @param {number[]} [options.transactionType] - The transaction account discriminator.
 * @param {boolean} [options.proposalExists=true] - Whether the proposal account exists.
 * @param {boolean} [options.transactionExists=true] - Whether the transaction exists.
 * @returns {{ account: WalletAccountReadOnlyMultisigSquads, rpc: Object }}
 */
function mockExecutable ({
  status = PROPOSAL_STATUS.Approved,
  approvedAt = 1000n,
  now = 1000n,
  timeLock = 0,
  staleTransactionIndex = 0n,
  transactionType = VAULT_TRANSACTION_DISCRIMINATOR,
  proposalExists = true,
  transactionExists = true,
  owner = SQUADS_PROGRAM_ADDRESS
} = {}) {
  const account = new WalletAccountReadOnlyMultisigSquads({
    provider: TEST_RPC_URL,
    commitment: 'confirmed',
    multisigPdaOrCreateKey: TEST_MULTISIG_PDA
  })

  const value = [
    multisigAccountValue({
      members: [{ address: MEMBER_A }, { address: MEMBER_B }],
      threshold: 2,
      timeLock,
      staleTransactionIndex
    }),
    proposalExists
      ? proposalAccountValue({ status, statusTimestamp: approvedAt, approved: [MEMBER_A, MEMBER_B] })
      : null,
    transactionExists ? transactionAccountValue(transactionType) : null,
    clockAccountValue(now)
  ]

  const rpc = stubSolanaRpc({
    getMultipleAccounts: () => ({
      context: { slot: 1 },
      value: value.map((account, index) => account && index < 3 ? { ...account, owner } : account)
    })
  })

  return { account, rpc }
}

/**
 * Builds a read-only account whose RPC serves a program config and a rent quote.
 *
 * @param {Object} [options] - The scenario.
 * @param {bigint} [options.creationFee=0n] - The protocol's multisig creation fee.
 * @param {bigint} [options.rent=2039280n] - The rent-exempt minimum to report.
 * @param {number[]} [options.discriminator] - An override for the account discriminator.
 * @param {boolean} [options.exists=true] - Whether the program config account exists.
 * @returns {{ account: WalletAccountReadOnlyMultisigSquads, rpc: Object }}
 */
function mockDeployQuote ({
  creationFee = 0n,
  rent = 2039280n,
  discriminator = PROGRAM_CONFIG_DISCRIMINATOR,
  exists = true
} = {}) {
  const account = new WalletAccountReadOnlyMultisigSquads({
    provider: TEST_RPC_URL,
    commitment: 'confirmed',
    multisigPdaOrCreateKey: TEST_MULTISIG_PDA
  })

  // ProgramConfig: discriminator(8) authority(32) multisigCreationFee(u64) treasury(32) reserved(64)
  const data = new Uint8Array(144)

  data.set(discriminator, 0)
  new DataView(data.buffer).setBigUint64(40, creationFee, true)

  const value = exists
    ? {
        owner: SQUADS_PROGRAM_ADDRESS,
        data: [getBase64Decoder().decode(data), 'base64'],
        executable: false,
        lamports: 1893120,
        space: 144
      }
    : null

  const rpc = stubSolanaRpc({
    getAccountInfo: () => ({ context: { slot: 1 }, value }),
    getMinimumBalanceForRentExemption: () => rent
  })

  return { account, rpc }
}

/**
 * Builds an account whose RPC rejects.
 *
 * @param {Error} error - The error to reject with.
 * @returns {WalletAccountReadOnlyMultisigSquads}
 */
function mockFailingAccount (error) {
  const account = new WalletAccountReadOnlyMultisigSquads({
    provider: TEST_RPC_URL,
    multisigPdaOrCreateKey: TEST_MULTISIG_PDA
  })

  stubSolanaRpc({ getAccountInfo: () => { throw error } })

  return account
}

describe('WalletAccountReadOnlyMultisigSquads', () => {
  describe('toCreateKeySecretBytes', () => {
    const PRIVATE_KEY = new Uint8Array(32).fill(9)

    it('returns a 32-byte private key unchanged', () => {
      expect(WalletAccountReadOnlyMultisigSquads.toCreateKeySecretBytes(PRIVATE_KEY))
        .toEqual(PRIVATE_KEY)
    })

    it('returns a 64-byte keypair whole', () => {
      const keyPair = new Uint8Array(64).fill(9)

      keyPair.set(getBase58Encoder().encode(TEST_CREATE_KEY), 32)

      expect(WalletAccountReadOnlyMultisigSquads.toCreateKeySecretBytes(keyPair))
        .toEqual(keyPair)
    })

    it('decodes a base58 secret to the same bytes', () => {
      const base58 = getBase58Decoder().decode(PRIVATE_KEY)

      expect(WalletAccountReadOnlyMultisigSquads.toCreateKeySecretBytes(base58))
        .toEqual(PRIVATE_KEY)
    })

    it('refuses a missing secret', () => {
      expect(() => WalletAccountReadOnlyMultisigSquads.toCreateKeySecretBytes(undefined))
        .toThrow('A `createKeySecret` is required to create a multisig. Provide it in the configuration.')
    })

    it('refuses a secret of the wrong length', () => {
      expect(() => WalletAccountReadOnlyMultisigSquads.toCreateKeySecretBytes(new Uint8Array(31)))
        .toThrow('Invalid createKeySecret of 31 bytes. Expected 32 or 64.')
    })
  })

  describe('toMultisigPda', () => {
    it('passes an off-curve address through as the multisig', () => {
      expect(WalletAccountReadOnlyMultisigSquads.toMultisigPda(SQUADS_PROGRAM_ADDRESS, TEST_MULTISIG_PDA))
        .toBe(TEST_MULTISIG_PDA)
    })

    it('derives the PDA of an on-curve create key', () => {
      expect(WalletAccountReadOnlyMultisigSquads.toMultisigPda(SQUADS_PROGRAM_ADDRESS, TEST_CREATE_KEY))
        .toBe(TEST_DERIVED_PDA)
    })

    it('returns nothing when the config names neither', () => {
      expect(WalletAccountReadOnlyMultisigSquads.toMultisigPda(SQUADS_PROGRAM_ADDRESS)).toBeUndefined()
    })

    it('derives under the program it is given', () => {
      expect(WalletAccountReadOnlyMultisigSquads.toMultisigPda(SYSTEM_PROGRAM_ADDRESS, TEST_CREATE_KEY))
        .not.toBe(TEST_DERIVED_PDA)
    })
  })

  describe('createRpc', () => {
    it('builds no client without a provider', () => {
      expect(WalletAccountReadOnlyMultisigSquads.createRpc({})).toBeUndefined()
      expect(WalletAccountReadOnlyMultisigSquads.createRpc()).toBeUndefined()
      expect(WalletAccountReadOnlyMultisigSquads.createRpc({ provider: [] })).toBeUndefined()
    })

    it('sends to the URL it was given', async () => {
      const rpc = WalletAccountReadOnlyMultisigSquads.createRpc({ provider: TEST_RPC_URL })
      const fetchMock = stubSolanaRpc({ getSlot: () => 7 })

      expect(await rpc.getSlot().send()).toBe(7n)
      expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([TEST_RPC_URL])
    })

    it('sends to the first of a list', async () => {
      const rpc = WalletAccountReadOnlyMultisigSquads.createRpc({
        provider: [TEST_RPC_URL, 'https://dummy-fallback.com']
      })
      const fetchMock = stubSolanaRpc({ getSlot: () => 7 })

      expect(await rpc.getSlot().send()).toBe(7n)
      expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([TEST_RPC_URL])
    })
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  describe('isDeployed', () => {
    it('returns true for an existing Multisig account', async () => {
      const { account } = mockAccount({
        owner: SQUADS_PROGRAM_ADDRESS,
        data: [toBase64(MULTISIG_DISCRIMINATOR), 'base64'],
        executable: false,
        lamports: 1893120,
        space: 144
      })

      expect(await account.isDeployed()).toBe(true)
    })

    it('returns false when the account does not exist', async () => {
      const { account } = mockAccount(null)

      expect(await account.isDeployed()).toBe(false)
    })

    it('returns false for an address someone pre-funded with lamports', async () => {
      // A plain transfer to an uncreated address leaves a System-Program-owned
      // account with no data. A bare existence check would report this as
      // deployed.
      const { account } = mockAccount({
        owner: SYSTEM_PROGRAM_ADDRESS,
        data: ['', 'base64'],
        executable: false,
        lamports: 1,
        space: 0
      })

      expect(await account.isDeployed()).toBe(false)
    })

    it('returns false for a different Squads account type at the address', async () => {
      const { account } = mockAccount({
        owner: SQUADS_PROGRAM_ADDRESS,
        data: [toBase64(PROGRAM_CONFIG_DISCRIMINATOR), 'base64'],
        executable: false,
        lamports: 1893120,
        space: 144
      })

      expect(await account.isDeployed()).toBe(false)
    })

    it('returns false when the account is owned by another program', async () => {
      const { account } = mockAccount({
        owner: SYSTEM_PROGRAM_ADDRESS,
        data: [toBase64(MULTISIG_DISCRIMINATOR), 'base64'],
        executable: false,
        lamports: 1893120,
        space: 144
      })

      expect(await account.isDeployed()).toBe(false)
    })

    it('honours a programId override when checking ownership', async () => {
      const { account } = mockAccount(
        {
          owner: SQUADS_PROGRAM_ADDRESS,
          data: [toBase64(MULTISIG_DISCRIMINATOR), 'base64'],
          executable: false,
          lamports: 1893120,
          space: 144
        },
        { multisigPdaOrCreateKey: TEST_MULTISIG_PDA, programId: SYSTEM_PROGRAM_ADDRESS }
      )

      expect(await account.isDeployed()).toBe(false)
    })

    it('propagates RPC failures instead of reporting "not deployed"', async () => {
      const account = mockFailingAccount(new Error('503 Service Unavailable'))

      // Swallowing this into `false` would invite a caller to redeploy an
      // existing multisig.
      await expect(account.isDeployed()).rejects.toThrow('503 Service Unavailable')
    })

    it('requests only the 8-byte discriminator', async () => {
      const { account, rpc } = mockAccount(null)

      await account.isDeployed()

      expect(rpcRequests(rpc, 'getAccountInfo')[0]).toEqual([
        TEST_MULTISIG_PDA,
        { commitment: 'confirmed', encoding: 'base64', dataSlice: { offset: 0, length: 8 } }
      ])
    })
  })

  describe('getMultisigInfo', () => {
    it('reads the threshold as a u16, not into the time lock beside it', async () => {
      // `time_lock` is the u32 immediately after the u16 threshold, so a wrong width reads
      // both as one number. Only a non-zero time lock can tell the two apart.
      const { account } = mockAccount(multisigAccountValue({
        members: [{ address: MEMBER_A }, { address: MEMBER_B }],
        threshold: 2,
        timeLock: 3600
      }))

      expect((await account.getMultisigInfo()).threshold).toBe(2)
    })

    it('reads the full u16 range of the threshold', async () => {
      // Catches a getUint8, or a signed read that would report -1.
      const { account } = mockAccount(multisigAccountValue({
        members: [{ address: MEMBER_A }],
        threshold: 65535
      }))

      expect((await account.getMultisigInfo()).threshold).toBe(65535)
    })

    it('preserves the on-chain order of owners rather than base58 order', async () => {
      const { account } = mockAccount(multisigAccountValue({
        members: [{ address: MEMBER_A }, { address: MEMBER_B }]
      }))

      const { owners } = await account.getMultisigInfo()

      expect(owners).toEqual([MEMBER_A, MEMBER_B])
      expect(owners).not.toEqual([...owners].sort())
    })

    it('reads at the confirmed commitment when the config names none', async () => {
      const account = new WalletAccountReadOnlyMultisigSquads({
        provider: TEST_RPC_URL,
        multisigPdaOrCreateKey: TEST_MULTISIG_PDA
      })
      const rpc = stubSolanaRpc({
        getAccountInfo: () => ({
          context: { slot: 1 },
          value: multisigAccountValue({ members: [{ address: MEMBER_A }] })
        })
      })

      await account.getMultisigInfo()

      expect(rpcRequests(rpc, 'getAccountInfo')[0])
        .toEqual([TEST_MULTISIG_PDA, { commitment: 'confirmed', encoding: 'base64' }])
    })

    it('returns address, owners, masks and threshold from one read', async () => {
      const { account, rpc } = mockAccount(multisigAccountValue({
        members: [{ address: MEMBER_A }, { address: MEMBER_B }],
        threshold: 2
      }))

      expect(await account.getMultisigInfo()).toEqual({
        address: TEST_MULTISIG_PDA,
        owners: [MEMBER_A, MEMBER_B],
        masks: [7, 7],
        threshold: 2
      })
      expect(rpcRequests(rpc, 'getAccountInfo')).toHaveLength(1)
    })

    it('decodes correctly when rentCollector is set', async () => {
      const { account } = mockAccount(multisigAccountValue({
        members: [{ address: MEMBER_A }, { address: MEMBER_B }],
        threshold: 2,
        rentCollector: true
      }))

      expect(await account.getMultisigInfo()).toEqual({
        address: TEST_MULTISIG_PDA,
        owners: [MEMBER_A, MEMBER_B],
        masks: [7, 7],
        threshold: 2
      })
    })

    it('includes members that cannot vote', async () => {
      const { account } = mockAccount(multisigAccountValue({
        members: [
          { address: MEMBER_A, mask: 6 },
          { address: MEMBER_B, mask: 5 }
        ],
        threshold: 1
      }))

      const { owners, masks, threshold } = await account.getMultisigInfo()

      expect(owners).toEqual([MEMBER_A, MEMBER_B])
      // 2 owners but only 1 voter, so this is a 1-of-1 despite owners.length === 2.
      expect(threshold).toBe(1)
      // The masks are the only way a caller can tell: mask 6 votes, mask 5 does not.
      expect(masks).toEqual([6, 5])
      expect(masks.filter((mask) => mask & 2)).toHaveLength(1)
    })

    it('keeps masks positionally aligned with owners', async () => {
      const { account } = mockAccount(multisigAccountValue({
        members: [{ address: MEMBER_A, mask: 3 }, { address: MEMBER_B, mask: 7 }],
        threshold: 1
      }))

      const { owners, masks } = await account.getMultisigInfo()

      expect(masks).toHaveLength(owners.length)
      expect(masks[owners.indexOf(MEMBER_A)]).toBe(3)
      expect(masks[owners.indexOf(MEMBER_B)]).toBe(7)
    })

    it('ignores pre-allocated slack', async () => {
      const { account } = mockAccount(multisigAccountValue({
        members: [{ address: MEMBER_A }],
        slack: 9 * 33
      }))

      expect((await account.getMultisigInfo()).owners).toEqual([MEMBER_A])
    })

    it('returns an empty multisig without throwing when the account is missing', async () => {
      const { account } = mockAccount(null)

      expect(await account.getMultisigInfo()).toEqual({
        address: TEST_MULTISIG_PDA,
        owners: [],
        masks: [],
        threshold: 0
      })
    })

    it('leaves existence to isDeployed rather than reporting it', async () => {
      // The transport is global, so each half configures its own cluster state in turn.
      const { account: missing } = mockAccount(null)

      expect(Object.keys(await missing.getMultisigInfo())).not.toContain('isCreated')
      expect(await missing.isDeployed()).toBe(false)

      const { account: present } = mockAccount(multisigAccountValue({
        members: [{ address: MEMBER_A }]
      }))

      expect(Object.keys(await present.getMultisigInfo())).not.toContain('isCreated')
      expect(await present.isDeployed()).toBe(true)
    })

    it('throws rather than reporting isCreated false for another account type', async () => {
      // isCreated false invites a caller to deploy; the address is already taken.
      const { account } = mockAccount(multisigAccountValue({
        members: [{ address: MEMBER_A }],
        discriminator: PROGRAM_CONFIG_DISCRIMINATOR
      }))

      await expect(account.getMultisigInfo()).rejects.toThrow(/not a Squads multisig/)
    })

    it('throws when the account is owned by another program', async () => {
      const { account } = mockAccount({
        ...multisigAccountValue({ members: [{ address: MEMBER_A }] }),
        owner: SYSTEM_PROGRAM_ADDRESS
      })

      await expect(account.getMultisigInfo()).rejects.toThrow(/not a Squads multisig/)
    })

    it('propagates RPC failures', async () => {
      const account = mockFailingAccount(new Error('503 Service Unavailable'))

      await expect(account.getMultisigInfo()).rejects.toThrow('503 Service Unavailable')
    })

    it('reports the derived address when the identity is a create key', async () => {
      const { account } = mockAccount(
        multisigAccountValue({ members: [{ address: MEMBER_A }] }),
        { multisigPdaOrCreateKey: TEST_CREATE_KEY }
      )

      expect((await account.getMultisigInfo()).address).toBe(TEST_DERIVED_PDA)
    })
  })

  describe('getNonce', () => {
    it('returns the transaction index as a bigint', async () => {
      const { account } = mockAccount(multisigAccountValue({
        members: [{ address: MEMBER_A }],
        transactionIndex: 238n
      }))

      const nonce = await account.getNonce()

      expect(nonce).toBe(238n)
    })

    it('returns 0n for a multisig with no transactions yet', async () => {
      const { account } = mockAccount(multisigAccountValue({
        members: [{ address: MEMBER_A }],
        transactionIndex: 0n
      }))

      expect(await account.getNonce()).toBe(0n)
    })

    it('preserves values beyond Number.MAX_SAFE_INTEGER', async () => {
      // The field is a u64, so it cannot be narrowed to a JS number without
      // silently losing precision at the top of the range.
      const { account } = mockAccount(multisigAccountValue({
        members: [{ address: MEMBER_A }],
        transactionIndex: 18446744073709551615n
      }))

      expect(await account.getNonce()).toBe(18446744073709551615n)
    })

    it('is unaffected by rentCollector being set', async () => {
      const { account } = mockAccount(multisigAccountValue({
        members: [{ address: MEMBER_A }],
        transactionIndex: 7n,
        rentCollector: true
      }))

      expect(await account.getNonce()).toBe(7n)
    })

    it('does not confuse the threshold with the transaction index', async () => {
      // The two differ, so reading the wrong field returns the wrong number.
      const { account } = mockAccount(multisigAccountValue({
        members: [{ address: MEMBER_A }, { address: MEMBER_B }],
        threshold: 2,
        transactionIndex: 9n
      }))

      expect(await account.getNonce()).toBe(9n)
    })

    it('decodes a response truncated to the requested 86 bytes', async () => {
      const full = encodeMultisigAccount({
        members: [{ address: MEMBER_A }],
        transactionIndex: 238n
      })
      const truncated = getBase64Decoder().decode(
        getBase64Encoder().encode(full).subarray(0, 86)
      )

      const { account } = mockAccount({
        owner: SQUADS_PROGRAM_ADDRESS,
        data: [truncated, 'base64'],
        executable: false,
        lamports: 2039280,
        space: 165
      })

      expect(await account.getNonce()).toBe(238n)
    })

    it('reads only the bytes up to the transaction index field', async () => {
      const { account, rpc } = mockAccount(multisigAccountValue({
        members: [{ address: MEMBER_A }]
      }))

      await account.getNonce()

      expect(rpcRequests(rpc, 'getAccountInfo')[0]).toEqual([
        TEST_MULTISIG_PDA,
        { commitment: 'confirmed', encoding: 'base64', dataSlice: { offset: 0, length: 86 } }
      ])
    })

    it('throws when the multisig does not exist', async () => {
      const { account } = mockAccount(null)

      // Returning 0n would claim the multisig exists with no transactions.
      await expect(account.getNonce()).rejects.toThrow(/does not exist/)
    })

    it('throws rather than decoding another Squads account type', async () => {
      const { account } = mockAccount(multisigAccountValue({
        members: [{ address: MEMBER_A }],
        discriminator: PROGRAM_CONFIG_DISCRIMINATOR
      }))

      await expect(account.getNonce()).rejects.toThrow(/not a Squads multisig/)
    })

    it('throws when the account is owned by another program', async () => {
      const { account } = mockAccount({
        ...multisigAccountValue({ members: [{ address: MEMBER_A }] }),
        owner: SYSTEM_PROGRAM_ADDRESS
      })

      await expect(account.getNonce()).rejects.toThrow(/not a Squads multisig/)
    })

    it('propagates RPC failures', async () => {
      const account = mockFailingAccount(new Error('503 Service Unavailable'))

      await expect(account.getNonce()).rejects.toThrow('503 Service Unavailable')
    })
  })

  describe('getProposals', () => {
    it('returns a proposal with its confirmations and the multisig threshold', async () => {
      const { account } = mockProposals([
        proposalAccountValue({ approved: [MEMBER_A, MEMBER_B] })
      ])

      expect(await account.getProposals([1])).toEqual({
        1: {
          proposalId: '1',
          confirmations: 2,
          threshold: 2,
          status: 'pending',
          statusName: 'Active',
          approved: [MEMBER_A, MEMBER_B],
          rejected: [],
          cancelled: []
        }
      })
    })

    // The `it.each` blocks below enumerate this map, so pin it once: a status dropped from it
    // would otherwise shrink those suites silently.
    it('covers every status Squads defines', () => {
      expect(Object.keys(PROPOSAL_STATUS)).toEqual(['Draft', 'Active', 'Rejected', 'Approved', 'Executing', 'Executed', 'Cancelled'])
    })

    it.each(Object.entries(PROPOSAL_STATUS))(
      'reports the Squads status name %s', async (name, status) => {
        const { account } = mockProposals([proposalAccountValue({ status, approved: [MEMBER_A] })])
        const { 1: proposal } = await account.getProposals([1])

        expect(proposal.statusName).toBe(name)
      })

    it.each(Object.entries(PROPOSAL_STATUS))(
      'reports status as executed only for %s when it has run', async (name, status) => {
        const { account } = mockProposals([proposalAccountValue({ status })])
        const { 1: proposal } = await account.getProposals([1])

        expect(proposal.status).toBe(name === 'Executed' ? 'executed' : 'pending')
      })

    it('lists who voted, each way', async () => {
      const { account } = mockProposals([
        proposalAccountValue({ approved: [MEMBER_A], rejected: [MEMBER_B] })
      ])
      const { 1: proposal } = await account.getProposals([1])

      expect(proposal.approved).toEqual([MEMBER_A])
      expect(proposal.rejected).toEqual([MEMBER_B])
      expect(proposal.cancelled).toEqual([])
      // confirmations counts approvals only, not votes cast.
      expect(proposal.confirmations).toBe(1)
    })

    it('derives the proposal address from the transaction index', async () => {
      const { account, rpc } = mockProposals([
        proposalAccountValue({}),
        proposalAccountValue({})
      ])

      await account.getProposals([1, 2])

      expect(rpcRequests(rpc, 'getMultipleAccounts')[0]).toEqual([
        [PROPOSAL_PDA_1, PROPOSAL_PDA_2],
        { commitment: 'confirmed', encoding: 'base64' }
      ])
    })

    it('returns null for an id with no proposal, keeping every id keyed', async () => {
      const { account } = mockProposals([
        proposalAccountValue({ approved: [MEMBER_A] }),
        null,
        proposalAccountValue({ approved: [MEMBER_A, MEMBER_B] })
      ])

      const proposals = await account.getProposals([1, 2, 3])

      expect(proposals).toEqual({
        1: {
          proposalId: '1',
          confirmations: 1,
          threshold: 2,
          status: 'pending',
          statusName: 'Active',
          approved: [MEMBER_A],
          rejected: [],
          cancelled: []
        },
        2: null,
        3: {
          proposalId: '3',
          confirmations: 2,
          threshold: 2,
          status: 'pending',
          statusName: 'Active',
          approved: [MEMBER_A, MEMBER_B],
          rejected: [],
          cancelled: []
        }
      })
    })

    it('counts approvals correctly for an Executing proposal', async () => {
      // Executing is the only status carrying no timestamp, so everything after it
      // shifts 8 bytes. It is transient on chain, so only a synthetic test hits it.
      const { account } = mockProposals([
        proposalAccountValue({
          status: PROPOSAL_STATUS.Executing,
          approved: [MEMBER_A, MEMBER_B]
        })
      ])

      expect(await account.getProposals([1])).toEqual({
        1: {
          proposalId: '1',
          confirmations: 2,
          threshold: 2,
          status: 'pending',
          statusName: 'Executing',
          approved: [MEMBER_A, MEMBER_B],
          rejected: [],
          cancelled: []
        }
      })
    })

    it.each(Object.entries(PROPOSAL_STATUS).filter(([, status]) => status !== PROPOSAL_STATUS.Executing))(
      'counts approvals correctly for %s', async (name, status) => {
        const { account } = mockProposals([
          proposalAccountValue({ status, approved: [MEMBER_A] })
        ])

        expect(await account.getProposals([1])).toEqual({
          1: {
            proposalId: '1',
            confirmations: 1,
            threshold: 2,
            status: status === PROPOSAL_STATUS.Executed ? 'executed' : 'pending',
            statusName: name,
            approved: [MEMBER_A],
            rejected: [],
            cancelled: []
          }
        })
      })

    it('reports the cancelled voters of a cancelled proposal', async () => {
      // The third and last vote vector: nothing else in the file populates it, so a decoder
      // that stopped after `rejected` would look correct.
      const { account } = mockProposals([
        proposalAccountValue({
          status: PROPOSAL_STATUS.Cancelled,
          approved: [MEMBER_A, MEMBER_B],
          cancelled: [MEMBER_A]
        })
      ])

      expect(await account.getProposals([1])).toEqual({
        1: {
          proposalId: '1',
          confirmations: 2,
          threshold: 2,
          status: 'pending',
          statusName: 'Cancelled',
          approved: [MEMBER_A, MEMBER_B],
          rejected: [],
          cancelled: [MEMBER_A]
        }
      })
    })

    it('reports zero confirmations for a rejected-only proposal', async () => {
      // Indistinguishable from an untouched proposal through MultisigProposal.
      const { account } = mockProposals([
        proposalAccountValue({ approved: [], rejected: [MEMBER_A] })
      ])

      expect(await account.getProposals([1])).toEqual({
        1: {
          proposalId: '1',
          confirmations: 0,
          threshold: 2,
          status: 'pending',
          statusName: 'Active',
          approved: [],
          rejected: [MEMBER_A],
          cancelled: []
        }
      })
    })

    it('ignores pre-allocated slack after the vectors', async () => {
      const { account } = mockProposals([
        proposalAccountValue({ approved: [MEMBER_A], slack: 320 })
      ])

      expect(await account.getProposals([1])).toEqual({
        1: {
          proposalId: '1',
          confirmations: 1,
          threshold: 2,
          status: 'pending',
          statusName: 'Active',
          approved: [MEMBER_A],
          rejected: [],
          cancelled: []
        }
      })
    })

    it('accepts ids as number, bigint and string', async () => {
      const { account } = mockProposals([
        proposalAccountValue({}),
        proposalAccountValue({}),
        proposalAccountValue({})
      ])

      const proposals = await account.getProposals([1, 2n, '3'])

      expect(Object.keys(proposals)).toEqual(['1', '2', '3'])
    })

    it('keys an id by its canonical decimal form', async () => {
      const { account } = mockProposals([proposalAccountValue({})])

      expect(await account.getProposals(['007'])).toEqual({
        7: {
          proposalId: '7',
          confirmations: 0,
          threshold: 2,
          status: 'pending',
          statusName: 'Active',
          approved: [],
          rejected: [],
          cancelled: []
        }
      })
    })

    it('returns null rather than decoding another Squads account type', async () => {
      const { account } = mockProposals([
        proposalAccountValue({ discriminator: MULTISIG_DISCRIMINATOR })
      ])

      expect(await account.getProposals([1])).toEqual({ 1: null })
    })

    it('returns null when the account is owned by another program', async () => {
      const { account } = mockProposals([
        { ...proposalAccountValue({}), owner: SYSTEM_PROGRAM_ADDRESS }
      ])

      expect(await account.getProposals([1])).toEqual({ 1: null })
    })

    it('chunks requests at 100 addresses', async () => {
      const proposals = Array.from({ length: 150 }, () => proposalAccountValue({ approved: [MEMBER_A] }))
      const { account, rpc } = mockProposals(proposals)

      const result = await account.getProposals(Array.from({ length: 150 }, (_, i) => i + 1))

      expect(Object.keys(result)).toHaveLength(150)
      expect(rpcRequests(rpc, 'getMultipleAccounts')).toHaveLength(2)
      expect(rpcRequests(rpc, 'getMultipleAccounts')[0][0]).toHaveLength(100)
      expect(rpcRequests(rpc, 'getMultipleAccounts')[1][0]).toHaveLength(50)
    })

    it('reads many proposals without one request per id', async () => {
      const proposals = Array.from({ length: 40 }, () => proposalAccountValue({}))
      const { account, rpc } = mockProposals(proposals)

      await account.getProposals(Array.from({ length: 40 }, (_, i) => i + 1))

      expect(rpcRequests(rpc, 'getMultipleAccounts')).toHaveLength(1)
      expect(rpcRequests(rpc, 'getAccountInfo')).toHaveLength(1)
    })

    it('returns an empty record without any RPC call', async () => {
      const { account, rpc } = mockProposals([])

      expect(await account.getProposals([])).toEqual({})
      expect(rpcRequests(rpc, 'getMultipleAccounts')).toHaveLength(0)
      expect(rpcRequests(rpc, 'getAccountInfo')).toHaveLength(0)
    })

    it.each([[-1], [1.5], ['abc']])('throws naming the offending id %s', async (bad) => {
      const { account } = mockProposals([proposalAccountValue({})])

      await expect(account.getProposals([bad]))
        .rejects.toThrow(`Invalid proposal id ${bad}. It must be an integer between 0 and 18446744073709551615.`)
    })

    // `BigInt()` reads all of these as a number, so without a shape check each named proposal 0,
    // 1 or 5 and returned real data for an id the caller never meant.
    it.each([
      ['an empty string', ''],
      ['whitespace', ' '],
      ['an empty array', []],
      ['false', false],
      ['true', true],
      ['a one-element array', ['5']],
      ['hexadecimal', '0x1f'],
      ['exponent notation', '1e3'],
      ['null', null],
      ['undefined', undefined],
      ['an object', {}]
    ])('refuses %s as a proposal id', async (_label, bad) => {
      const { account, rpc } = mockProposals([proposalAccountValue({})])

      await expect(account.getProposals([bad])).rejects.toThrow(/Invalid proposal id/)
      expect(rpcRequests(rpc, 'getMultipleAccounts')).toHaveLength(0)
    })

    // The key is what the id normalizes to, which is the point of accepting these forms at all.
    it.each([
      [0, '0'],
      ['0', '0'],
      [7, '7'],
      ['7', '7'],
      [7n, '7'],
      ['18446744073709551615', '18446744073709551615']
    ])('accepts %s, keyed as %s', async (good, key) => {
      const { account } = mockProposals([proposalAccountValue({})])

      expect(await account.getProposals([good])).toEqual({
        [key]: {
          proposalId: key,
          confirmations: 0,
          threshold: 2,
          status: 'pending',
          statusName: 'Active',
          approved: [],
          rejected: [],
          cancelled: []
        }
      })
    })

    it('throws when the multisig does not exist', async () => {
      const { account } = mockProposals([], null)

      await expect(account.getProposals([1])).rejects.toThrow(/does not exist/)
    })

    it('propagates RPC failures', async () => {
      const { account } = mockProposals([proposalAccountValue({})])

      stubSolanaRpc({
        getAccountInfo: () => ({ context: { slot: 1 }, value: multisigAccountValue({ members: [{ address: MEMBER_A }] }) }),
        getMultipleAccounts: () => { throw new Error('503 Service Unavailable') }
      })

      await expect(account.getProposals([1])).rejects.toThrow('503 Service Unavailable')
    })
  })

  describe('getProposal', () => {
    it('returns the proposal at the given id', async () => {
      const { account } = mockProposals([proposalAccountValue({ approved: [MEMBER_A] })])

      expect(await account.getProposal(1)).toEqual({
        proposalId: '1',
        confirmations: 1,
        threshold: 2,
        status: 'pending',
        statusName: 'Active',
        approved: [MEMBER_A],
        rejected: [],
        cancelled: []
      })
    })

    it('returns null when no proposal exists at that id', async () => {
      const { account } = mockProposals([null])

      expect(await account.getProposal(1)).toBeNull()
    })

    it('resolves an id given as a string', async () => {
      const { account } = mockProposals([proposalAccountValue({})])

      expect(await account.getProposal('007')).toEqual({
        proposalId: '7',
        confirmations: 0,
        threshold: 2,
        status: 'pending',
        statusName: 'Active',
        approved: [],
        rejected: [],
        cancelled: []
      })
    })

    it('reads one proposal in a single request', async () => {
      const { account, rpc } = mockProposals([proposalAccountValue({})])

      await account.getProposal(1)

      expect(rpcRequests(rpc, 'getMultipleAccounts')).toHaveLength(1)
      expect(rpcRequests(rpc, 'getMultipleAccounts')[0][0]).toHaveLength(1)
    })

    it('throws naming the offending id', async () => {
      const { account } = mockProposals([proposalAccountValue({})])

      await expect(account.getProposal(-1)).rejects.toThrow(/Invalid proposal id -1/)
    })
  })

  describe('isReadyToExecute', () => {
    it('returns true for an approved proposal with no time lock', async () => {
      const { account } = mockExecutable()

      expect(await account.isReadyToExecute(1)).toBe(true)
    })

    it.each(Object.entries(PROPOSAL_STATUS).filter(([, status]) => status !== PROPOSAL_STATUS.Approved))(
      'returns false for %s', async (_name, status) => {
        const { account } = mockExecutable({ status })

        expect(await account.isReadyToExecute(1)).toBe(false)
      })

    it('returns false while the time lock has not elapsed', async () => {
      const { account } = mockExecutable({ approvedAt: 1000n, now: 1059n, timeLock: 60 })

      expect(await account.isReadyToExecute(1)).toBe(false)
    })

    it('returns true the moment the time lock elapses', async () => {
      // The program compares with >=, so the boundary second counts as released.
      const { account } = mockExecutable({ approvedAt: 1000n, now: 1060n, timeLock: 60 })

      expect(await account.isReadyToExecute(1)).toBe(true)
    })

    it('returns true for a stale approved vault transaction', async () => {
      // vault_transaction_execute performs no staleness check: a vault proposal
      // approved before going stale stays executable.
      const { account } = mockExecutable({
        transactionType: VAULT_TRANSACTION_DISCRIMINATOR,
        staleTransactionIndex: 100n
      })

      expect(await account.isReadyToExecute(1)).toBe(true)
    })

    it('returns false for a stale approved config transaction', async () => {
      // config_transaction_execute does check staleness.
      const { account } = mockExecutable({
        transactionType: CONFIG_TRANSACTION_DISCRIMINATOR,
        staleTransactionIndex: 100n
      })

      expect(await account.isReadyToExecute(1)).toBe(false)
    })

    it('throws when another program owns the accounts', async () => {
      // A discriminator is eight bytes any program can write, so the owner decides. The addresses
      // are PDAs of the Squads program, so this is not reachable in practice; it is the same
      // sentence every other read path throws rather than a predicate-only `false`.
      const { account } = mockExecutable({ owner: SYSTEM_PROGRAM_ADDRESS })

      await expect(account.isReadyToExecute(1))
        .rejects.toThrow(`The account ${TEST_MULTISIG_PDA} is not a Squads multisig.`)
    })

    it('returns true for a config transaction that is not stale', async () => {
      const { account } = mockExecutable({
        transactionType: CONFIG_TRANSACTION_DISCRIMINATOR,
        staleTransactionIndex: 0n
      })

      expect(await account.isReadyToExecute(1)).toBe(true)
    })

    it.each([0n, 100n])('returns false for an approved batch, stale index %s', async (staleTransactionIndex) => {
      // The program would execute a batch, stale or not, but `executeProposal` refuses one, so
      // reporting it ready would send a caller into a guaranteed throw.
      const { account } = mockExecutable({
        transactionType: BATCH_DISCRIMINATOR,
        staleTransactionIndex
      })

      expect(await account.isReadyToExecute(1)).toBe(false)
    })

    it('treats an index equal to the stale index as stale for config transactions', async () => {
      // The program requires transaction_index > stale_transaction_index.
      const { account } = mockExecutable({
        transactionType: CONFIG_TRANSACTION_DISCRIMINATOR,
        staleTransactionIndex: 5n
      })

      expect(await account.isReadyToExecute(5)).toBe(false)
      expect(await account.isReadyToExecute(6)).toBe(true)
    })

    it('returns false when the proposal does not exist', async () => {
      const { account } = mockExecutable({ proposalExists: false })

      expect(await account.isReadyToExecute(1)).toBe(false)
    })

    it('returns false when the transaction account does not exist', async () => {
      const { account } = mockExecutable({ transactionExists: false })

      expect(await account.isReadyToExecute(1)).toBe(false)
    })

    it('returns false rather than decoding another account type as a proposal', async () => {
      const account = new WalletAccountReadOnlyMultisigSquads({
        provider: TEST_RPC_URL,
        multisigPdaOrCreateKey: TEST_MULTISIG_PDA
      })
      stubSolanaRpc({
        getMultipleAccounts: () => ({
          context: { slot: 1 },
          value: [
            multisigAccountValue({ members: [{ address: MEMBER_A }] }),
            proposalAccountValue({
              status: PROPOSAL_STATUS.Approved,
              discriminator: MULTISIG_DISCRIMINATOR
            }),
            transactionAccountValue(VAULT_TRANSACTION_DISCRIMINATOR),
            clockAccountValue(1000n)
          ]
        })
      })

      expect(await account.isReadyToExecute(1)).toBe(false)
    })

    it('reads the multisig, proposal, transaction and clock in one request', async () => {
      const { account, rpc } = mockExecutable()

      await account.isReadyToExecute(1)

      expect(rpcRequests(rpc, 'getMultipleAccounts')).toHaveLength(1)

      const [addresses] = rpcRequests(rpc, 'getMultipleAccounts')[0]

      expect(addresses).toHaveLength(4)
      expect(addresses[0]).toBe(TEST_MULTISIG_PDA)
      expect(addresses[1]).toBe(PROPOSAL_PDA_1)
      expect(addresses[3]).toBe(CLOCK_SYSVAR_ADDRESS)
      // The transaction account is its own PDA, not the proposal's.
      expect(addresses[2]).toBe(TRANSACTION_PDA_1)
    })

    it('accepts ids as number, bigint and string', async () => {
      const { account } = mockExecutable()

      expect(await account.isReadyToExecute(1)).toBe(true)
      expect(await account.isReadyToExecute(1n)).toBe(true)
      expect(await account.isReadyToExecute('1')).toBe(true)
    })

    it('throws on an invalid id', async () => {
      const { account, rpc } = mockExecutable()

      await expect(account.isReadyToExecute(-1)).rejects.toThrow(/Invalid proposal id/)
      expect(rpcRequests(rpc, 'getMultipleAccounts')).toHaveLength(0)
    })

    it('propagates RPC failures', async () => {
      const account = new WalletAccountReadOnlyMultisigSquads({
        provider: TEST_RPC_URL,
        multisigPdaOrCreateKey: TEST_MULTISIG_PDA
      })
      stubSolanaRpc({
        getMultipleAccounts: () => { throw new Error('503 Service Unavailable') }
      })

      await expect(account.isReadyToExecute(1)).rejects.toThrow('503 Service Unavailable')
    })
  })

  describe('getTransactionReceipt', () => {
    // A well-formed 64-byte signature, and a 32-byte address that must be rejected.
    const DUMMY_SIGNATURE = getBase58Decoder().decode(new Uint8Array(64).fill(7))
    const DUMMY_RECEIPT = {
      blockTime: 1785346451n,
      slot: 435990582n,
      version: 0n,
      transactionIndex: 12n,
      meta: { err: null, fee: 6890n },
      transaction: { signatures: [DUMMY_SIGNATURE] }
    }

    /**
     * Builds an account whose RPC returns a fixed `getTransaction` result.
     *
     * @param {Object|null} value - The receipt to return.
     * @param {Object} [config] - Extra config for the account.
     * @returns {{ account: WalletAccountReadOnlyMultisigSquads, rpc: Object }}
     */
    function mockReceipt (value, config = {}) {
      const account = new WalletAccountReadOnlyMultisigSquads({
        provider: TEST_RPC_URL,
        multisigPdaOrCreateKey: TEST_MULTISIG_PDA,
        ...config
      })

      const rpc = stubSolanaRpc({ getTransaction: () => value })

      return { account, rpc }
    }

    it('returns the receipt unchanged', async () => {
      const { account } = mockReceipt(DUMMY_RECEIPT)

      // Equality, not identity: the receipt is decoded from the response rather than passed
      // through, so the method's contract is that it adds and removes nothing.
      expect(await account.getTransactionReceipt(DUMMY_SIGNATURE)).toEqual(DUMMY_RECEIPT)
    })

    it('returns null when the transaction is not found', async () => {
      const { account } = mockReceipt(null)

      expect(await account.getTransactionReceipt(DUMMY_SIGNATURE)).toBeNull()
    })

    it('returns the receipt of a failed transaction rather than throwing', async () => {
      // A failed transaction is still in a block and still has a receipt; callers
      // must check meta.err themselves.
      const failed = { ...DUMMY_RECEIPT, meta: { err: { InstructionError: [0, 'Custom'] }, fee: 5000 } }
      const { account } = mockReceipt(failed)

      const receipt = await account.getTransactionReceipt(DUMMY_SIGNATURE)

      // The client upcasts every integer in the response, including the ones inside `err`.
      expect(receipt).toEqual({
        ...failed,
        meta: { err: { InstructionError: [0n, 'Custom'] }, fee: 5000n }
      })
    })

    it('requests support for versioned transactions', async () => {
      // Squads executes v0 transactions; without this the RPC refuses them outright,
      // so the method would fail on exactly the transactions it exists to report on.
      const { account, rpc } = mockReceipt(DUMMY_RECEIPT)

      await account.getTransactionReceipt(DUMMY_SIGNATURE)

      expect(rpcRequests(rpc, 'getTransaction')[0]).toEqual([
        DUMMY_SIGNATURE,
        { commitment: 'confirmed', encoding: 'json', maxSupportedTransactionVersion: 0 }
      ])
    })

    it('raises a processed commitment to confirmed', async () => {
      // getTransaction rejects anything below confirmed.
      const { account, rpc } = mockReceipt(DUMMY_RECEIPT, { commitment: 'processed' })

      await account.getTransactionReceipt(DUMMY_SIGNATURE)

      expect(rpcRequests(rpc, 'getTransaction')[0]).toEqual([
        DUMMY_SIGNATURE,
        { commitment: 'confirmed', encoding: 'json', maxSupportedTransactionVersion: 0 }
      ])
    })

    it('does not lower a finalized commitment', async () => {
      const { account, rpc } = mockReceipt(DUMMY_RECEIPT, { commitment: 'finalized' })

      await account.getTransactionReceipt(DUMMY_SIGNATURE)

      // `finalized` is the RPC's own default, so the client drops it from the request rather
      // than sending it — the commitment is not lowered, it is simply implicit.
      expect(rpcRequests(rpc, 'getTransaction')[0]).toEqual([
        DUMMY_SIGNATURE,
        { encoding: 'json', maxSupportedTransactionVersion: 0 }
      ])
    })

    it('throws on a malformed signature without hitting the RPC', async () => {
      const { account, rpc } = mockReceipt(DUMMY_RECEIPT)

      await expect(account.getTransactionReceipt('nope'))
        .rejects.toThrow('Invalid transaction signature: nope')
      expect(rpcRequests(rpc, 'getTransaction')).toHaveLength(0)
    })

    it('throws on an empty signature', async () => {
      const { account } = mockReceipt(DUMMY_RECEIPT)

      await expect(account.getTransactionReceipt('')).rejects.toThrow('Invalid transaction signature: ')
    })

    it('rejects a 32-byte address passed as a signature', async () => {
      // Valid base58, wrong length: the mistake a caller is most likely to make.
      const { account, rpc } = mockReceipt(DUMMY_RECEIPT)

      await expect(account.getTransactionReceipt(TEST_MULTISIG_PDA))
        .rejects.toThrow(`Invalid transaction signature: ${TEST_MULTISIG_PDA}`)
      expect(rpcRequests(rpc, 'getTransaction')).toHaveLength(0)
    })

    it('propagates RPC failures', async () => {
      const account = new WalletAccountReadOnlyMultisigSquads({
        provider: TEST_RPC_URL,
        multisigPdaOrCreateKey: TEST_MULTISIG_PDA
      })
      stubSolanaRpc({ getTransaction: () => { throw new Error('503 Service Unavailable') } })

      await expect(account.getTransactionReceipt(DUMMY_SIGNATURE)).rejects.toThrow('503 Service Unavailable')
    })
  })

  describe('getTransaction', () => {
    const DUMMY_SIGNATURE = getBase58Decoder().decode(new Uint8Array(64).fill(7))
    const DUMMY_RECEIPT = {
      blockTime: 1785346451n,
      slot: 435990582n,
      meta: { err: null, fee: 6890n },
      transaction: { signatures: [DUMMY_SIGNATURE] }
    }

    /**
     * Builds an account whose RPC reports a fixed signature status and a fixed transaction.
     *
     * @param {Object|null} status - The signature status, or null for a signature the cluster does not know.
     * @param {Object|null} [receipt] - The transaction `getTransaction` returns.
     * @returns {{ account: WalletAccountReadOnlyMultisigSquads, rpc: Object }}
     */
    function mockStatus (status, receipt = DUMMY_RECEIPT) {
      const account = new WalletAccountReadOnlyMultisigSquads({
        provider: TEST_RPC_URL,
        multisigPdaOrCreateKey: TEST_MULTISIG_PDA
      })

      const rpc = stubSolanaRpc({
        getSignatureStatuses: () => ({ context: { apiVersion: '2.1.0', slot: 435990600n }, value: [status] }),
        getTransaction: () => receipt
      })

      return { account, rpc }
    }

    it('normalizes a confirmed transaction', async () => {
      const { account } = mockStatus({
        confirmationStatus: 'confirmed',
        confirmations: 12n,
        err: null,
        slot: 435990582n
      })

      expect(await account.getTransaction(DUMMY_SIGNATURE)).toEqual({
        hash: DUMMY_SIGNATURE,
        finality: 'confirmed',
        success: true,
        block: 435990582,
        fee: 6890n
      })
    })

    it('reports a finalized transaction as final', async () => {
      const { account } = mockStatus({
        confirmationStatus: 'finalized',
        confirmations: null,
        err: null,
        slot: 435990582n
      })

      expect((await account.getTransaction(DUMMY_SIGNATURE)).finality).toBe('final')
    })

    it('reports a processed transaction as pending, without reading it', async () => {
      // Nothing but the finality is known yet: the fee and the execution's result are only
      // decided once the transaction lands, so the second round trip is not made.
      const { account, rpc } = mockStatus({
        confirmationStatus: 'processed',
        confirmations: 0n,
        err: null,
        slot: 435990582n
      })

      expect(await account.getTransaction(DUMMY_SIGNATURE)).toEqual({
        hash: DUMMY_SIGNATURE,
        finality: 'pending'
      })
      expect(rpcRequests(rpc, 'getTransaction')).toHaveLength(0)
    })

    it('reports a reverted transaction as an unsuccessful confirmation', async () => {
      // A transaction that failed on-chain still reached its finality: `success` is what
      // separates the two, not the finality.
      const { account } = mockStatus({
        confirmationStatus: 'confirmed',
        confirmations: 3n,
        err: { InstructionError: [0, 'Custom'] },
        slot: 435990582n
      })

      expect(await account.getTransaction(DUMMY_SIGNATURE)).toMatchObject({
        finality: 'confirmed',
        success: false
      })
    })

    it('omits the fee when the transaction is not readable yet', async () => {
      // `getSignatureStatuses` sees a transaction a slot or two before `getTransaction` serves
      // it, so the receipt must survive the gap rather than fail on it.
      const { account } = mockStatus(
        { confirmationStatus: 'confirmed', confirmations: 1n, err: null, slot: 435990582n },
        null
      )

      const receipt = await account.getTransaction(DUMMY_SIGNATURE)

      expect(receipt).toEqual({
        hash: DUMMY_SIGNATURE,
        finality: 'confirmed',
        success: true,
        block: 435990582
      })
      expect(receipt.fee).toBeUndefined()
    })

    it('searches the transaction history', async () => {
      // Without it the cluster only answers for the last few minutes of slots, so an older
      // transaction would read as never seen.
      const { account, rpc } = mockStatus({
        confirmationStatus: 'finalized',
        confirmations: null,
        err: null,
        slot: 435990582n
      })

      await account.getTransaction(DUMMY_SIGNATURE)

      expect(rpcRequests(rpc, 'getSignatureStatuses')[0]).toEqual([
        [DUMMY_SIGNATURE],
        { searchTransactionHistory: true }
      ])
    })

    it('throws when the cluster reports no status', async () => {
      // The type matters: `waitForTransaction` treats it as a transient not-found and keeps
      // polling, rather than giving up on a transaction that has not propagated yet.
      const { account } = mockStatus(null)

      await expect(account.getTransaction(DUMMY_SIGNATURE)).rejects.toThrow(NoSuchElementError)
    })

    it('throws on a malformed signature without hitting the RPC', async () => {
      const { account, rpc } = mockStatus(null)

      await expect(account.getTransaction('nope'))
        .rejects.toThrow('Invalid transaction signature: nope')
      expect(rpcRequests(rpc, 'getSignatureStatuses')).toHaveLength(0)
    })

    it('rejects a 32-byte address passed as a signature', async () => {
      // Valid base58, wrong length: the mistake a caller is most likely to make, and the one
      // a not-found result would otherwise hide.
      const { account } = mockStatus(null)

      await expect(account.getTransaction(TEST_MULTISIG_PDA))
        .rejects.toThrow(`Invalid transaction signature: ${TEST_MULTISIG_PDA}`)
    })

    it('throws without a provider', async () => {
      const account = new WalletAccountReadOnlyMultisigSquads({
        multisigPdaOrCreateKey: TEST_MULTISIG_PDA
      })

      await expect(account.getTransaction(DUMMY_SIGNATURE))
        .rejects.toThrow(ProviderRequiredError)
      await expect(account.getTransaction(DUMMY_SIGNATURE))
        .rejects.toThrow('The wallet must be connected to a provider to retrieve transactions.')
    })

    it('polls at one slot', async () => {
      const account = new WalletAccountReadOnlyMultisigSquads({
        multisigPdaOrCreateKey: TEST_MULTISIG_PDA
      })

      expect(account.defaultWaitInterval).toBe(400)
    })
  })

  describe('getTokenBalance', () => {
    it('returns the token amount as a bigint', async () => {
      const { account } = mockTokenAccount('51448811')

      const balance = await account.getTokenBalance(USDC_MINT)

      expect(balance).toBe(51448811n)
    })

    it('reads the vault\'s associated token account', async () => {
      const { account, rpc } = mockTokenAccount('0')

      await account.getTokenBalance(USDC_MINT)

      expect(rpcRequests(rpc, 'getAccountInfo')[0]).toEqual([
        USDC_ATA_VAULT_0,
        { commitment: 'confirmed', encoding: 'jsonParsed' }
      ])
    })

    it('returns 0n when no associated token account exists', async () => {
      const { account } = mockTokenAccount(null)

      expect(await account.getTokenBalance(USDC_MINT)).toBe(0n)
    })

    it('returns 0n for an existing account holding nothing', async () => {
      const { account } = mockTokenAccount('0')

      expect(await account.getTokenBalance(USDC_MINT)).toBe(0n)
    })

    it('preserves amounts beyond Number.MAX_SAFE_INTEGER', async () => {
      // The RPC reports the amount as a decimal string precisely so it can exceed
      // what a JS number holds.
      const { account } = mockTokenAccount('18446744073709551615')

      expect(await account.getTokenBalance(USDC_MINT)).toBe(18446744073709551615n)
    })

    it('reads the token account of a vault selected by index', async () => {
      const { account, rpc } = mockTokenAccount('7')

      expect(await account.getTokenBalance(USDC_MINT, 3)).toBe(7n)
      expect(rpcRequests(rpc, 'getAccountInfo')[0])
        .toEqual([USDC_ATA_VAULT_3, { commitment: 'confirmed', encoding: 'jsonParsed' }])
    })

    it('queries a different account per mint, and never the vault itself', async () => {
      const { account, rpc } = mockTokenAccount('0')

      await account.getTokenBalance(USDC_MINT)
      await account.getTokenBalance(TOKEN_2022_MINT)

      const [[first], [second]] = rpcRequests(rpc, 'getAccountInfo')

      // One associated token account per mint, each owned by the vault rather than being it.
      expect([first, second]).toEqual([USDC_ATA_VAULT_0, TOKEN_2022_ATA_VAULT_0])
    })

    it('throws on a malformed mint without hitting the RPC', async () => {
      const { account, rpc } = mockTokenAccount('0')

      await expect(account.getTokenBalance('not-a-mint'))
        .rejects.toThrow('Expected base58-encoded address string of length in the range [32, 44]. Actual length: 10.')
      expect(rpcRequests(rpc, 'getAccountInfo')).toHaveLength(0)
    })

    it('rejects an out-of-range vault index before hitting the RPC', async () => {
      const { account, rpc } = mockTokenAccount('0')

      await expect(account.getTokenBalance(USDC_MINT, 256)).rejects.toThrow(/Invalid vault index/)
      expect(rpcRequests(rpc, 'getAccountInfo')).toHaveLength(0)
    })

    it('reports the mint problem first when both arguments are invalid', async () => {
      // The mint is validated up front, so a caller fixing errors one at a time is
      // told about the argument they passed first rather than the second.
      const { account } = mockTokenAccount('0')

      await expect(account.getTokenBalance('not-a-mint', 256))
        .rejects.toThrow('Expected base58-encoded address string of length in the range [32, 44]. Actual length: 10.')
    })

    it('propagates RPC failures', async () => {
      const account = new WalletAccountReadOnlyMultisigSquads({
        provider: TEST_RPC_URL,
        multisigPdaOrCreateKey: TEST_MULTISIG_PDA
      })
      stubSolanaRpc({ getAccountInfo: () => { throw new Error('503 Service Unavailable') } })

      await expect(account.getTokenBalance(USDC_MINT)).rejects.toThrow('503 Service Unavailable')
    })

    it('resolves a Token-2022 mint to a legacy address — known limitation', async () => {
      // Documents the @todo rather than asserting desired behaviour: the derivation
      // uses the SPL Token program, so a Token-2022 mint yields an address that does
      // not hold the real balance. Delete this test when Token-2022 is supported.
      const { account, rpc } = mockTokenAccount(null)

      expect(await account.getTokenBalance(TOKEN_2022_MINT)).toBe(0n)

      const [queried] = rpcRequests(rpc, 'getAccountInfo')[0]
      expect(queried).toBe('mKKRTmYrT4YywefDUvszdEqz7nm1oddDd6QRXn1snfz')
    })
  })

  describe('getVaultAddress', () => {
    it('derives vault 0 by default', async () => {
      const { account } = mockBalanceAccount(0n)

      expect(await account.getVaultAddress()).toBe(TEST_VAULT_0)
    })

    it('is a PDA of the multisig, not the multisig itself', async () => {
      // The multisig account holds only its rent; funds live in the vault.
      const { account } = mockBalanceAccount(0n)

      expect(await account.getVaultAddress()).toBe(TEST_VAULT_0)
      expect(TEST_VAULT_0).not.toBe(TEST_MULTISIG_PDA)
    })

    it('derives a vault by index', async () => {
      const { account } = mockBalanceAccount(0n)

      expect(await account.getVaultAddress(3)).toBe(TEST_VAULT_3)
    })

    it('accepts an address that derives from this multisig', async () => {
      const { account } = mockBalanceAccount(0n)

      expect(await account.getVaultAddress(TEST_VAULT_3)).toBe(TEST_VAULT_3)
      expect(await account.getVaultAddress(TEST_VAULT_255)).toBe(TEST_VAULT_255)
    })

    it('rejects an address that is not a vault of this multisig', async () => {
      const { account } = mockBalanceAccount(0n)

      await expect(account.getVaultAddress(TEST_MULTISIG_PDA)).rejects.toThrow(
        `The address ${TEST_MULTISIG_PDA} is not a vault of the multisig ${TEST_MULTISIG_PDA}.`
      )
    })

    it('rejects a vault of another multisig', async () => {
      const { account } = mockBalanceAccount(0n)
      const { account: other } = mockBalanceAccount(0n, { multisigPdaOrCreateKey: TEST_DERIVED_PDA })
      const foreignVault = await other.getVaultAddress(0)

      expect(foreignVault).not.toBe(TEST_VAULT_0)
      await expect(account.getVaultAddress(foreignVault)).rejects.toThrow(
        `The address ${foreignVault} is not a vault of the multisig ${TEST_MULTISIG_PDA}.`
      )
    })

    it('accepts the full u8 index range', async () => {
      const { account } = mockBalanceAccount(0n)

      await expect(account.getVaultAddress(255)).resolves.toBe(TEST_VAULT_255)
    })

    it('rejects an index above the u8 range', async () => {
      const { account } = mockBalanceAccount(0n)

      await expect(account.getVaultAddress(256)).rejects.toThrow(/Invalid vault index/)
    })

    it('rejects a negative or fractional index', async () => {
      const { account } = mockBalanceAccount(0n)

      await expect(account.getVaultAddress(-1)).rejects.toThrow(/Invalid vault index/)
      await expect(account.getVaultAddress(1.5)).rejects.toThrow(/Invalid vault index/)
    })

    it('rejects a malformed address', async () => {
      const { account } = mockBalanceAccount(0n)

      await expect(account.getVaultAddress('not-an-address'))
        .rejects.toThrow('Expected base58-encoded address string of length in the range [32, 44]. Actual length: 14.')
    })
  })

  describe('getBalance', () => {
    it('reads the vault address, not the multisig address', async () => {
      // The only assertion here that catches reading the wrong account: every
      // other test in this block passes with the multisig address substituted.
      const { account, rpc } = mockBalanceAccount(51000001n)

      await account.getBalance()

      expect(rpcRequests(rpc, 'getBalance')[0]).toEqual([TEST_VAULT_0, { commitment: 'confirmed' }])
      expect(rpcRequests(rpc, 'getBalance').map(([queried]) => queried))
        .not.toContain(TEST_MULTISIG_PDA)
    })

    it('returns the balance as a bigint', async () => {
      const { account } = mockBalanceAccount(51000001n)

      const balance = await account.getBalance()

      expect(balance).toBe(51000001n)
    })

    it('returns 0n for an unfunded vault that has no account', async () => {
      // Most vaults do not exist on chain; the RPC reports 0 rather than erroring,
      // and that is the correct balance rather than a placeholder.
      const { account } = mockBalanceAccount(0n)

      expect(await account.getBalance()).toBe(0n)
    })

    it('preserves values beyond Number.MAX_SAFE_INTEGER', async () => {
      const { account } = mockBalanceAccount(18446744073709551615n)

      expect(await account.getBalance()).toBe(18446744073709551615n)
    })

    it('reads a vault selected by index', async () => {
      const { account, rpc } = mockBalanceAccount(7n)

      expect(await account.getBalance(3)).toBe(7n)
      expect(rpcRequests(rpc, 'getBalance')[0]).toEqual([TEST_VAULT_3, { commitment: 'confirmed' }])
    })

    it('reads a vault selected by address', async () => {
      const { account, rpc } = mockBalanceAccount(7n)

      await account.getBalance(TEST_VAULT_3)

      expect(rpcRequests(rpc, 'getBalance')[0]).toEqual([TEST_VAULT_3, { commitment: 'confirmed' }])
    })

    it('rejects an out-of-range index before hitting the RPC', async () => {
      const { account, rpc } = mockBalanceAccount(0n)

      await expect(account.getBalance(256)).rejects.toThrow(/Invalid vault index/)
      expect(rpcRequests(rpc, 'getBalance')).toHaveLength(0)
    })

    it('propagates RPC failures', async () => {
      const account = new WalletAccountReadOnlyMultisigSquads({
        provider: TEST_RPC_URL,
        multisigPdaOrCreateKey: TEST_MULTISIG_PDA
      })
      stubSolanaRpc({ getBalance: () => { throw new Error('503 Service Unavailable') } })

      await expect(account.getBalance()).rejects.toThrow('503 Service Unavailable')
    })
  })

  describe('quoteDeploy', () => {
    it('sums rent, creation fee and the two-signature base fee', async () => {
      const { account } = mockDeployQuote({ rent: 2039280n, creationFee: 0n })

      // 2039280 rent + 0 fee + 2 x 5000 signatures
      expect(await account.quoteDeploy()).toEqual({ fee: 2049280n })
    })

    it('includes a non-zero creation fee', async () => {
      // The mainnet fee is currently 0, so this is the only case that catches an
      // implementation ignoring the program config.
      const { account } = mockDeployQuote({ rent: 2039280n, creationFee: 100000000n })

      expect(await account.quoteDeploy()).toEqual({ fee: 102049280n })
    })

    it('requests rent for the size the member count implies', async () => {
      const { account, rpc } = mockDeployQuote()

      await account.quoteDeploy(3)

      // 132 base + 3 x 33 per member
      expect(rpcRequests(rpc, 'getMinimumBalanceForRentExemption')[0])
        .toEqual([231, { commitment: 'confirmed' }])
    })

    it('quotes a single member by default', async () => {
      const { account, rpc } = mockDeployQuote()

      await account.quoteDeploy()

      expect(rpcRequests(rpc, 'getMinimumBalanceForRentExemption')[0])
        .toEqual([165, { commitment: 'confirmed' }])
    })

    it('reads the creation fee from the program config account', async () => {
      const { account, rpc } = mockDeployQuote()

      await account.quoteDeploy()

      // Derived PDA for ["multisig", "program_config"], not a hardcoded fee.
      expect(rpcRequests(rpc, 'getAccountInfo')[0]).toEqual([
        'BSTq9w3kZwNwpBXJEvTZz2G9ZTNyKBvoSeXMvwb4cNZr',
        { commitment: 'confirmed', encoding: 'base64' }
      ])
    })

    it('throws when the program config does not exist', async () => {
      const { account } = mockDeployQuote({ exists: false })

      await expect(account.quoteDeploy()).rejects.toThrow(/program config/)
    })

    it('throws rather than reading a fee from another account type', async () => {
      const { account } = mockDeployQuote({ discriminator: MULTISIG_DISCRIMINATOR })

      await expect(account.quoteDeploy()).rejects.toThrow(/program config/)
    })

    it.each([[0], [-1], [1.5], [65536]])(
      'rejects a member count of %s before hitting the RPC', async (bad) => {
        const { account, rpc } = mockDeployQuote()

        await expect(account.quoteDeploy(bad)).rejects.toThrow(
          `Invalid member count ${bad}. It must be an integer between 1 and 65535.`
        )
        expect(rpcRequests(rpc, 'getAccountInfo')).toHaveLength(0)
      })

    it('accepts the full member range', async () => {
      const { account, rpc } = mockDeployQuote()

      expect(await account.quoteDeploy(65535)).toEqual({ fee: 2049280n })

      // The stub's rent is fixed, so the size it was asked for is what carries the claim:
      // 132 base + 33 per member, for the largest multisig Squads allows.
      expect(rpcRequests(rpc, 'getMinimumBalanceForRentExemption')[0])
        .toEqual([2162787, { commitment: 'confirmed' }])
    })

    it('propagates RPC failures', async () => {
      const account = new WalletAccountReadOnlyMultisigSquads({
        provider: TEST_RPC_URL,
        multisigPdaOrCreateKey: TEST_MULTISIG_PDA
      })
      stubSolanaRpc({
        getAccountInfo: () => { throw new Error('503 Service Unavailable') },
        getMinimumBalanceForRentExemption: () => 0
      })

      await expect(account.quoteDeploy()).rejects.toThrow('503 Service Unavailable')
    })
  })

  describe('quotePropose', () => {
    const TX = { to: MEMBER_C, value: 1000000n }

    /**
     * Builds an account serving a multisig and real rent-exempt minimums.
     *
     * @param {number} memberCount - How many members the multisig holds.
     * @returns {{ account: WalletAccountReadOnlyMultisigSquads, getMinimumBalanceForRentExemption: Function }}
     */
    function mockQuote (memberCount) {
      const account = new WalletAccountReadOnlyMultisigSquads({
        provider: TEST_RPC_URL,
        commitment: 'confirmed',
        multisigPdaOrCreateKey: TEST_MULTISIG_PDA
      })

      const members = [MEMBER_A, MEMBER_B, MEMBER_C]
        .slice(0, memberCount)
        .map((address) => ({ address }))

      const rpc = stubSolanaRpc({
        getAccountInfo: () => ({
          context: { slot: 1 },
          value: multisigAccountValue({ members, threshold: 1 })
        }),
        // The real rent formula: (128 + size) * 6960 lamports.
        getMinimumBalanceForRentExemption: ([size]) => (128n + BigInt(size)) * 6960n
      })

      return { account, rpc }
    }

    it('sums transaction rent, proposal rent and one signature', async () => {
      const { account } = mockQuote(2)

      // 221 B tx rent + 262 B proposal rent + 5000
      expect(await account.quotePropose(TX)).toEqual({ fee: 5148440n })
    })

    it('scales with the member count', async () => {
      // One cluster state at a time: the transport is global.
      const { account: two } = mockQuote(2)
      const a = (await two.quotePropose(TX)).fee

      const { account: three } = mockQuote(3)
      const b = (await three.quotePropose(TX)).fee

      // One more member adds 96 bytes of proposal rent.
      expect(b - a).toBe(96n * 6960n)
    })

    it('sizes the transaction account from the message, not a constant', async () => {
      const { account, rpc } = mockQuote(2)

      await account.quotePropose(TX)

      // 83 base + 4 ephemeral prefix + 134 message
      expect(rpcRequests(rpc, 'getMinimumBalanceForRentExemption')[0])
        .toEqual([221, { commitment: 'confirmed' }])
    })

    it('sizes the proposal account as 70 + 96 per member', async () => {
      const { account, rpc } = mockQuote(3)

      await account.quotePropose(TX)

      expect(rpcRequests(rpc, 'getMinimumBalanceForRentExemption')[1])
        .toEqual([358, { commitment: 'confirmed' }])
    })

    it('charges one signature, not two', async () => {
      // Creating the transaction and its proposal share a single transaction, unlike
      // multisigCreateV2 which needs the createKey to sign as well.
      const { account } = mockQuote(2)

      const { fee } = await account.quotePropose(TX)
      const rent = (128n + 221n) * 6960n + (128n + 262n) * 6960n

      expect(fee - rent).toBe(5000n)
    })

    it('sizes an arbitrary message from the message itself', async () => {
      const { account, rpc } = mockQuote(2)

      // One instruction with no accounts and two bytes of data: 3 header + (4 + 32 vault key)
      // + (4 + 1 program index + 4 + 0 indexes + 4 + 2 data) + 4 lookups = 90 B stored, so the
      // transaction account is 83 + 4 + 90.
      const { fee } = await account.quotePropose({
        instructions: [{
          programAddress: TEST_MULTISIG_PDA,
          accounts: [],
          data: new Uint8Array([1, 2])
        }]
      })

      expect(rpcRequests(rpc, 'getMinimumBalanceForRentExemption')[0])
        .toEqual([177, { commitment: 'confirmed' }])
      expect(fee).toBe(4842200n)
    })

    it('refuses a message the vault cannot execute, before quoting', async () => {
      const { account, rpc } = mockQuote(2)

      await expect(account.quotePropose({ instructions: [] }))
        .rejects.toThrow('A proposed transaction must carry at least one instruction.')
      expect(rpcRequests(rpc, 'getMinimumBalanceForRentExemption')).toHaveLength(0)
    })

    it('throws on a malformed recipient', async () => {
      const { account } = mockQuote(2)

      await expect(account.quotePropose({ to: 'nope', value: 1n }))
        .rejects.toThrow('Expected base58-encoded address string of length in the range [32, 44]. Actual length: 4.')
    })

    it('throws when the multisig does not exist', async () => {
      const account = new WalletAccountReadOnlyMultisigSquads({
        provider: TEST_RPC_URL,
        multisigPdaOrCreateKey: TEST_MULTISIG_PDA
      })
      stubSolanaRpc({
        getAccountInfo: () => ({ context: { slot: 1 }, value: null }),
        getMinimumBalanceForRentExemption: () => 0
      })

      await expect(account.quotePropose(TX)).rejects.toThrow(/does not exist/)
    })

    it('quotes the multisig named in a config override', async () => {
      const { account, rpc } = mockQuote(2)

      const { fee } = await account.quotePropose(TX, { multisigPdaOrCreateKey: TEST_DERIVED_PDA })

      // The override keeps this account's provider, and reads the multisig it names.
      expect(rpcRequests(rpc, 'getAccountInfo')[0][0]).toBe(TEST_DERIVED_PDA)
      expect(fee).toBe(5148440n)
    })

    it('propagates RPC failures', async () => {
      const { account } = mockQuote(2)

      stubSolanaRpc({
        getAccountInfo: () => ({
          context: { slot: 1 },
          value: multisigAccountValue({ members: [{ address: MEMBER_A }], threshold: 1 })
        }),
        getMinimumBalanceForRentExemption: () => { throw new Error('503 Service Unavailable') }
      })

      await expect(account.quotePropose(TX)).rejects.toThrow('503 Service Unavailable')
    })

    it('throws without a provider, before reading the multisig', async () => {
      const account = new WalletAccountReadOnlyMultisigSquads({
        multisigPdaOrCreateKey: TEST_MULTISIG_PDA
      })

      await expect(account.quotePropose(TX)).rejects.toThrow(ProviderRequiredError)
      await expect(account.quotePropose(TX))
        .rejects.toThrow('The wallet must be connected to a provider to quote transactions.')
    })
  })

  describe('quoteTransfer', () => {
    const OPTIONS = { token: USDC_MINT, recipient: MEMBER_C, amount: 1000000n }

    /**
     * Builds an account serving a multisig, an ATA lookup and real rent minimums.
     *
     * @param {Object} [options] - The scenario.
     * @param {number} [options.memberCount=2] - How many members the multisig holds.
     * @param {boolean} [options.recipientAtaExists=true] - Whether the recipient holds the token.
     * @returns {{ account: WalletAccountReadOnlyMultisigSquads, rpc: Object }}
     */
    function mockTransferQuote ({ memberCount = 2, recipientAtaExists = true } = {}) {
      const account = new WalletAccountReadOnlyMultisigSquads({
        provider: TEST_RPC_URL,
        commitment: 'confirmed',
        multisigPdaOrCreateKey: TEST_MULTISIG_PDA
      })

      const members = [MEMBER_A, MEMBER_B, MEMBER_C]
        .slice(0, memberCount)
        .map((address) => ({ address }))

      const tokenAccount = {
        owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        data: ['', 'base64'],
        space: 165,
        lamports: 2039280,
        executable: false
      }

      const rpc = stubSolanaRpc({
        getAccountInfo: () => ({
          context: { slot: 1 },
          value: multisigAccountValue({ members, threshold: 1 })
        }),
        // The mint, then the recipient's associated token account. Only their existence matters
        // here, not their contents.
        getMultipleAccounts: () => ({
          context: { slot: 1 },
          value: [tokenAccount, recipientAtaExists ? tokenAccount : null]
        }),
        getMinimumBalanceForRentExemption: ([size]) => (128n + BigInt(size)) * 6960n
      })

      return { account, rpc }
    }

    it('quotes a transfer to a recipient that already holds the token', async () => {
      const { account } = mockTransferQuote({ memberCount: 2 })

      // 251 B tx rent + 262 B proposal rent + 5000
      expect(await account.quoteTransfer(OPTIONS)).toEqual({ fee: 5357240n })
    })

    it('quotes more when the recipient token account must be created', async () => {
      const { account } = mockTransferQuote({ memberCount: 2, recipientAtaExists: false })

      // 395 B tx rent instead of 251 B
      expect(await account.quoteTransfer(OPTIONS)).toEqual({ fee: 6359480n })
    })

    it('sizes the transaction account from the branch it observed', async () => {
      const sizes = (rpc) =>
        rpcRequests(rpc, 'getMinimumBalanceForRentExemption').map(([size]) => size)

      const { account: withAta, rpc: a } = mockTransferQuote()

      await withAta.quoteTransfer(OPTIONS)

      const { account: without, rpc: b } = mockTransferQuote({ recipientAtaExists: false })

      await without.quoteTransfer(OPTIONS)

      // 83 + 4 + 164, versus 83 + 4 + 308
      expect(sizes(a)).toContain(251)
      expect(sizes(b)).toContain(395)
    })

    it('scales with the member count', async () => {
      const { account: two } = mockTransferQuote({ memberCount: 2 })
      const forTwo = (await two.quoteTransfer(OPTIONS)).fee

      const { account: three } = mockTransferQuote({ memberCount: 3 })
      const forThree = (await three.quoteTransfer(OPTIONS)).fee

      expect(forThree - forTwo).toBe(96n * 6960n)
    })

    it('queries the recipient token account, not the recipient address', async () => {
      const { account, rpc } = mockTransferQuote()

      await account.quoteTransfer(OPTIONS)

      const [[queried]] = rpcRequests(rpc, 'getMultipleAccounts')

      expect(rpcRequests(rpc, 'getAccountInfo').map(([addr]) => addr)).toEqual([TEST_MULTISIG_PDA])
      expect(queried).toHaveLength(2)
      expect(queried).not.toContain(MEMBER_C)
      expect(queried[0]).toBe(USDC_MINT)
    })

    it('charges one signature, not two', async () => {
      const { account } = mockTransferQuote({ memberCount: 2 })

      const { fee } = await account.quoteTransfer(OPTIONS)
      const rent = (128n + 251n) * 6960n + (128n + 262n) * 6960n

      expect(fee - rent).toBe(5000n)
    })

    it('throws without a provider, before reading the multisig', async () => {
      const account = new WalletAccountReadOnlyMultisigSquads({
        multisigPdaOrCreateKey: TEST_MULTISIG_PDA
      })

      await expect(account.quoteTransfer(OPTIONS)).rejects.toThrow(ProviderRequiredError)
      await expect(account.quoteTransfer(OPTIONS))
        .rejects.toThrow('The wallet must be connected to a provider to quote transfer operations.')
    })

    it('throws an invalid token error when the mint does not exist', async () => {
      const { account } = mockTransferQuote()

      stubSolanaRpc({
        getAccountInfo: () => ({
          context: { slot: 1 },
          value: multisigAccountValue({ members: [{ address: MEMBER_A }], threshold: 1 })
        }),
        getMultipleAccounts: () => ({ context: { slot: 1 }, value: [null, null] })
      })

      await expect(account.quoteTransfer(OPTIONS)).rejects.toThrow(InvalidTokenError)
      await expect(account.quoteTransfer(OPTIONS))
        .rejects.toThrow(`The token mint ${USDC_MINT} does not exist.`)
    })

    it('throws on a malformed mint or recipient before any RPC call', async () => {
      const { account, rpc } = mockTransferQuote()

      // Distinct lengths, so the message names which argument was rejected.
      await expect(account.quoteTransfer({ ...OPTIONS, token: 'bad-mint' }))
        .rejects.toThrow('Expected base58-encoded address string of length in the range [32, 44]. Actual length: 8.')
      await expect(account.quoteTransfer({ ...OPTIONS, recipient: 'bad-recipient-address' }))
        .rejects.toThrow('Expected base58-encoded address string of length in the range [32, 44]. Actual length: 21.')
      expect(rpcRequests(rpc, 'getAccountInfo')).toHaveLength(0)
    })

    it('reports the mint problem first when both arguments are invalid', async () => {
      // Same contract as getTokenBalance: a caller fixing errors one at a time hears about
      // the argument they passed first.
      const { account } = mockTransferQuote()

      await expect(account.quoteTransfer({
        ...OPTIONS,
        token: 'bad-mint',
        recipient: 'bad-recipient-address'
      })).rejects.toThrow('Expected base58-encoded address string of length in the range [32, 44]. Actual length: 8.')
    })

    it('throws when the multisig does not exist', async () => {
      const account = new WalletAccountReadOnlyMultisigSquads({
        provider: TEST_RPC_URL,
        multisigPdaOrCreateKey: TEST_MULTISIG_PDA
      })
      stubSolanaRpc({
        getAccountInfo: () => ({ context: { slot: 1 }, value: null }),
        getMinimumBalanceForRentExemption: () => 0
      })

      await expect(account.quoteTransfer(OPTIONS)).rejects.toThrow(/does not exist/)
    })

    it('propagates RPC failures', async () => {
      const { account } = mockTransferQuote()

      stubSolanaRpc({
        getAccountInfo: () => ({
          context: { slot: 1 },
          value: multisigAccountValue({ members: [{ address: MEMBER_A }], threshold: 1 })
        }),
        getMultipleAccounts: () => { throw new Error('503 Service Unavailable') },
        getMinimumBalanceForRentExemption: () => 0
      })

      await expect(account.quoteTransfer(OPTIONS)).rejects.toThrow('503 Service Unavailable')
    })
  })

  describe('quoteExecuteProposal', () => {
    /**
     * Builds a read-only account whose RPC serves the multisig and the proposal that
     * quoting an execution reads.
     *
     * @param {Object|null} proposal - The proposal account, or null to report it missing.
     * @returns {{ account: WalletAccountReadOnlyMultisigSquads, rpc: Object }}
     */
    function mockExecuteQuote (proposal = proposalAccountValue({ approved: [MEMBER_A] })) {
      const account = new WalletAccountReadOnlyMultisigSquads({
        provider: TEST_RPC_URL,
        multisigPdaOrCreateKey: TEST_MULTISIG_PDA
      })

      const rpc = stubSolanaRpc({
        getMultipleAccounts: () => ({
          context: { slot: 1 },
          value: [
            multisigAccountValue({
              members: [{ address: MEMBER_A }, { address: MEMBER_B }],
              threshold: 2
            }),
            proposal
          ]
        })
      })

      return { account, rpc }
    }

    it('quotes the base fee of the execution transaction', async () => {
      const { account } = mockExecuteQuote()

      expect(await account.quoteExecuteProposal(1)).toEqual({ fee: 5000n })
    })

    it('reads the multisig and the proposal in one request', async () => {
      const { account, rpc } = mockExecuteQuote()

      await account.quoteExecuteProposal(1)

      expect(rpcRequests(rpc, 'getMultipleAccounts')).toHaveLength(1)
      expect(rpcRequests(rpc, 'getMultipleAccounts')[0][0]).toHaveLength(2)
    })

    it('throws NoSuchElementError when no proposal exists at that id', async () => {
      const { account } = mockExecuteQuote(null)

      await expect(account.quoteExecuteProposal(1)).rejects.toThrow(NoSuchElementError)
      await expect(account.quoteExecuteProposal(1)).rejects.toThrow(/no proposal at index 1/)
    })

    it('throws naming the offending id', async () => {
      const { account } = mockExecuteQuote()

      await expect(account.quoteExecuteProposal(-1)).rejects.toThrow(/Invalid proposal id -1/)
    })

    it('propagates RPC failures', async () => {
      const { account } = mockExecuteQuote()

      stubSolanaRpc({
        getMultipleAccounts: () => { throw new Error('503 Service Unavailable') }
      })

      await expect(account.quoteExecuteProposal(1)).rejects.toThrow('503 Service Unavailable')
    })
  })

  describe('unsupported operations', () => {
    let account

    beforeEach(() => {
      account = new WalletAccountReadOnlyMultisigSquads({
        provider: TEST_RPC_URL,
        multisigPdaOrCreateKey: TEST_MULTISIG_PDA
      })
    })

    it('names verify as the unsupported method', async () => {
      const error = await account.verify('hello', 'sig').catch((e) => e)

      expect(error).toBeInstanceOf(UnsupportedOperationError)
      expect(error.message).toBe("Method 'verify(message, signature)' is not supported.")
    })

    it('does not expose the message-proposal surface at all', () => {
      expect(account.getMessageProposal).toBeUndefined()
      expect(account.getMessageProposals).toBeUndefined()
    })

    // A caller doing capability detection has to tell "this protocol cannot" from "not built
    // yet", so each half is its own test.
    it('names quoteSendTransaction as the unsupported method', async () => {
      const error = await account.quoteSendTransaction({ to: MEMBER_A, value: 1n })
        .catch((thrown) => thrown)

      expect(error).toBeInstanceOf(UnsupportedOperationError)
      expect(error.message).toBe("Method 'quoteSendTransaction(tx)' is not supported.")
    })

    it('reports an unsupported operation as a WdkError', async () => {
      const error = await account.verify('hello', 'sig').catch((thrown) => thrown)

      expect(error).toBeInstanceOf(WdkError)
    })

    it('does not report pending work as unsupported', async () => {
      stubSolanaRpc({
        getAccountInfo: () => ({ context: { slot: 1 }, value: null }),
        getMinimumBalanceForRentExemption: () => 2039280
      })

      // quoteDeploy fails because the multisig is absent, not because Squads cannot do it.
      const error = await account.quoteDeploy().catch((thrown) => thrown)

      expect(error).not.toBeInstanceOf(UnsupportedOperationError)
      expect(error.message).toMatch(/could not be read/)
    })

    it('is not a NotImplementedError', async () => {
      // Deliberate: a consumer catching NotImplementedError to mean "unfinished" must
      // not also swallow "this protocol cannot do it".
      const error = await account.verify('hello', 'sig').catch((e) => e)

      expect(error).toBeInstanceOf(UnsupportedOperationError)
      expect(error).not.toBeInstanceOf(NotImplementedError)
    })
  })

  describe('address resolution', () => {
    it('uses an off-curve identity as the multisig address', async () => {
      const { account } = mockAccount(null)

      expect(await account.getAddress()).toBe(TEST_MULTISIG_PDA)
    })

    it('derives the address from an on-curve identity, which can only be a create key', async () => {
      const { account } = mockAccount(null, { multisigPdaOrCreateKey: TEST_CREATE_KEY })

      expect(await account.getAddress()).toBe(TEST_DERIVED_PDA)
    })

    it('queries the derived address', async () => {
      const { account, rpc } = mockAccount(null, { multisigPdaOrCreateKey: TEST_CREATE_KEY })

      await account.isDeployed()

      expect(rpcRequests(rpc, 'getAccountInfo')[0]).toEqual([
        TEST_DERIVED_PDA,
        { commitment: 'confirmed', encoding: 'base64', dataSlice: { offset: 0, length: 8 } }
      ])
    })

    it('throws without hitting the RPC when nothing is configured', async () => {
      const { account, rpc } = mockAccount(null, {})

      await expect(account.isDeployed()).rejects.toThrow(/address must be set/)
      expect(rpcRequests(rpc, 'getAccountInfo')).toHaveLength(0)
    })
  })
})
