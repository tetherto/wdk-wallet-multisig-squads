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

import { InvalidTokenError, NoSuchElementError, ProviderError, ProviderErrorReason, ProviderRequiredError, UnsupportedOperationError, ValueError, WalletAccountReadOnly } from '@tetherto/wdk-wallet'

import FailoverProvider from '@tetherto/wdk-failover-provider'

import { createSolanaRpc } from '@solana/rpc'
import { address, getAddressEncoder, isOffCurveAddress } from '@solana/addresses'
import { getBase58Decoder, getBase58Encoder, getBase64Encoder, getU64Encoder } from '@solana/codecs'
import { isSignature } from '@solana/keys'
import { AccountRole } from '@solana/instructions'
import { SYSTEM_PROGRAM_ADDRESS, getTransferSolInstructionDataEncoder } from '@solana-program/system'
import { SYSVAR_CLOCK_ADDRESS } from '@solana/sysvars'
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getTransferInstruction,
  TOKEN_PROGRAM_ADDRESS
} from '@solana-program/token'

import { ed25519 } from '@noble/curves/ed25519'

import {
  ACCOUNT,
  ACCOUNT_DISCRIMINATOR,
  PROPOSAL_STATUS,
  STORED_TRANSACTION_MESSAGE,
  TRANSACTION_MESSAGE
} from './helpers/layouts.js'

import { getProgramDerivedAddressSync } from './helpers/program-derived-address.js'

/** @typedef {ReturnType<typeof import('@solana/rpc').createSolanaRpc>} SolanaRpc */
/** @typedef {import('@solana/rpc-types').Commitment} Commitment */
/** @typedef {import('@solana/addresses').Address} Address */
/** @typedef {import('@solana/instructions').AccountMeta} AccountMeta */
/** @typedef {import('@solana/instructions').Instruction} Instruction */
/** @typedef {import('@solana/codecs-core').ReadonlyUint8Array} ReadonlyUint8Array */
/**
 * A kit instruction with the two halves kit leaves optional. Every instruction this package builds
 * carries both, and `_compileTransactionMessage` reads both.
 *
 * @typedef {Instruction & { accounts: readonly AccountMeta[], data: ReadonlyUint8Array }} CompilableInstruction
 */
/**
 * A transaction message compiled into the two forms the create instruction needs: the bytes it
 * carries, and the size the transaction account is allocated at.
 *
 * @typedef {Object} CompiledTransactionMessage
 * @property {ReadonlyUint8Array} bytes - The message as the create instruction carries it.
 * @property {number} storedSize - The size the transaction account is allocated at.
 * @property {Address[]} accountKeys - The account keys, in message order.
 * @property {number} numSigners - How many leading keys are signers.
 * @property {number} numWritableSigners - How many of those signers are writable.
 * @property {number} numWritableNonSigners - How many non-signers after them are writable.
 */

/** @typedef {import('@tetherto/wdk-wallet/multisig').IWalletAccountReadOnlyMultisig} IWalletAccountReadOnlyMultisig */
/** @typedef {import('@tetherto/wdk-wallet/multisig').MultisigInfo} MultisigInfo */
/**
 * `MultisigInfo` widened with each owner's Squads permission mask, aligned with `owners`.
 *
 * @typedef {MultisigInfo & { masks: number[] }} MultisigSquadsInfo
 */
/** @typedef {import('@tetherto/wdk-wallet/multisig').MultisigProposal} MultisigProposal */
/**
 * `MultisigProposal` widened with the proposal's Squads status and its vote lists.
 *
 * @typedef {MultisigProposal & { statusName: string, approved: string[], rejected: string[], cancelled: string[] }} MultisigSquadsProposal
 */
/** @typedef {import('@tetherto/wdk-wallet').TransactionResult} TransactionResult */
/** @typedef {import('@tetherto/wdk-wallet').TransactionReceipt} TransactionReceipt */
/** @typedef {import('@tetherto/wdk-wallet').Finality} Finality */
/** @typedef {import('@tetherto/wdk-wallet').TransferOptions} TransferOptions */

/** @typedef {import('./coordinators/index.js').MultisigCoordinatorFactory} MultisigCoordinatorFactory */

/** @typedef {import('@tetherto/wdk-wallet-solana').SolanaTransaction} SolanaTransaction */
/** @typedef {import('@tetherto/wdk-wallet-solana').SolanaTransactionReceipt} SolanaTransactionReceipt */

/**
 * The configuration a read-only Squads account takes: how to reach the cluster, and which
 * multisig to operate on. Two fields name the multisig: its address, or the create key it derives
 * from, or the secret that create key derives from. The first two never look alike. A multisig
 * address always sits off the ed25519 curve, and a create key always sits on it, because it has to
 * sign the multisig into being.
 *
 * @typedef {Object} MultisigSquadsWalletReadOnlyConfig
 * @property {string | string[]} [provider] - A Solana RPC URL, or a list of URLs for failover. Omit it to derive addresses without reaching the cluster; every method that needs the cluster then throws.
 * @property {Commitment} [commitment] - The commitment level for transactions (default: 'confirmed').
 * @property {number} [retries] - The number of retries for the failover provider (default: 3).
 * @property {string} [programId] - The Squads program to operate against, for a fork or a local deployment (default: `SQUADS_PROGRAM_ADDRESS`).
 * @property {string} [multisigPdaOrCreateKey] - The address of an existing Squads multisig, or the create key its address derives from.
 * @property {string | Uint8Array} [createKeySecret] - The create key's secret, which the multisig address derives from when `multisigPdaOrCreateKey` is absent, and which deploying a multisig requires. Base58 or raw bytes, either a 32-byte private key or a 64-byte keypair.
 */

/**
 * The extra configuration a signing account takes: the account that funds the rent Squads
 * charges, and the fee ceilings above which it refuses to submit.
 *
 * @typedef {Object} MultisigSquadsWalletSigningConfig
 * @property {MultisigCoordinatorFactory} [coordinator] - Builds the coordinator the account votes through, from the address of the member it will vote as. Omit it and each vote is the member's own transaction.
 * @property {string} [rentPayer] - The account charged for the rent the multisig, transaction and proposal accounts lock up (default: the signer). It must sign the transaction by other means, which nothing in this package currently provides.
 * @property {number | bigint} [createMaxFee] - The maximum fee amount for the create/deploy operation.
 * @property {number | bigint} [transferMaxFee] - The maximum fee amount for transfers.
 * @property {number | bigint} [approveMaxFee] - The maximum fee amount for approving through a coordinator, quoted before the member signs. A coordinator compiles the bundle, so it fixes the priority fee that vote carries.
 */

/** @typedef {MultisigSquadsWalletReadOnlyConfig & MultisigSquadsWalletSigningConfig} MultisigSquadsWalletConfig */

/**
 * A member of a Squads multisig, as stored on-chain.
 *
 * @typedef {Object} SquadsMember
 * @property {string} address - The member's address.
 * @property {number} mask - The member's permission bitmask: 1 initiate, 2 vote, 4 execute.
 */

/**
 * A decoded Squads multisig account. When `isCreated` is false the account does not exist
 * on-chain and every other field holds a placeholder.
 *
 * @typedef {Object} SquadsMultisigAccount
 * @property {string} address - The multisig address the account was read from.
 * @property {boolean} isCreated - Whether the account exists on-chain.
 * @property {string | null} configAuthority - The authority that alone may change the members and threshold, or null when the multisig votes on its own configuration.
 * @property {number} threshold - The number of approvals a proposal needs to be executable.
 * @property {number} timeLock - Seconds an approved proposal must wait before it can execute.
 * @property {bigint} transactionIndex - The index of the most recently created transaction.
 * @property {bigint} staleTransactionIndex - Proposals at or below this index were invalidated by a later configuration change and can no longer be voted on or executed.
 * @property {string | null} rentCollector - The address that reclaims rent when a proposal's accounts are closed, or null when the multisig collects none.
 * @property {SquadsMember[]} members - The members, in on-chain order.
 */

/**
 * A decoded Squads proposal account. When `exists` is false no proposal has been created at
 * that transaction index and every other field holds a placeholder.
 *
 * @typedef {Object} SquadsProposalAccount
 * @property {Address} address - The proposal's program-derived address.
 * @property {boolean} exists - Whether a proposal has been created at that index.
 * @property {number} status - The raw status discriminant, or -1 when the proposal is absent.
 * @property {string | null} statusName - The status as a name, e.g. `'Active'`.
 * @property {string | null} statusPhrase - The status as a sentence fragment, for error messages.
 * @property {bigint | null} statusTimestamp - The Unix timestamp the status was set at, or null while the proposal is executing, the one status Squads stores without a timestamp.
 * @property {string[]} approved - The members that have approved.
 * @property {string[]} rejected - The members that have rejected.
 * @property {string[]} cancelled - The members that have cancelled.
 */

/**
 * A lookup a stored transaction message makes into an address lookup table.
 *
 * @typedef {Object} SquadsAddressTableLookup
 * @property {string} accountKey - The lookup table's address.
 * @property {number[]} writableIndexes - The table indexes loaded as writable accounts.
 * @property {number[]} readonlyIndexes - The table indexes loaded as read-only accounts.
 */

/**
 * The message a vault transaction executes, decoded far enough to rebuild its account list.
 *
 * @typedef {Object} SquadsTransactionMessage
 * @property {number} numSigners - How many leading account keys are signers.
 * @property {number} numWritableSigners - How many of those leading signers are writable.
 * @property {number} numWritableNonSigners - How many non-signers after them are writable.
 * @property {string[]} accountKeys - The statically listed addresses, in message order.
 * @property {SquadsAddressTableLookup[]} addressTableLookups - The lookup table references.
 */

/** @typedef {'vault' | 'config' | 'batch'} SquadsTransactionKind */

/** @typedef {'AddMember' | 'RemoveMember' | 'ChangeThreshold' | 'SetTimeLock' | 'AddSpendingLimit' | 'RemoveSpendingLimit' | 'SetRentCollector'} SquadsConfigActionKind */

/**
 * A configuration change a config transaction applies. `createKey` and `spendingLimit` name the
 * spending limit account the executor has to pass through, and are null for every other kind.
 *
 * @typedef {Object} SquadsConfigAction
 * @property {SquadsConfigActionKind} kind - The change the action applies.
 * @property {string | null} createKey - The key the spending limit to create derives from.
 * @property {string | null} spendingLimit - The address of the spending limit to close.
 */

/**
 * A decoded Squads transaction account backing a proposal. When `exists` is false no
 * transaction has been created at that index and every other field holds a placeholder.
 *
 * @typedef {Object} SquadsTransactionAccount
 * @property {Address} address - The transaction's program-derived address.
 * @property {boolean} exists - Whether a transaction has been created at that index.
 * @property {SquadsTransactionKind | null} kind - The transaction kind, null when the account is absent or holds a kind this package cannot decode.
 * @property {number} vaultIndex - The vault the message spends from; 0 for non-vault kinds.
 * @property {number} ephemeralSignerCount - The ephemeral signers the message expects.
 * @property {SquadsTransactionMessage | null} message - The stored message, vault kind only.
 * @property {SquadsConfigAction[]} actions - The configuration actions, config kind only.
 */

/**
 * The Squads program config: the fee it charges to create a multisig, and the treasury that
 * collects it.
 *
 * @typedef {Object} SquadsProgramConfig
 * @property {Address} programConfigPda - The program config's program-derived address.
 * @property {bigint} creationFee - The fee charged per multisig creation, in lamports.
 * @property {string} treasury - The address the creation fee is paid to.
 */

/**
 * A multisig, one of its proposals, the transaction that proposal backs, and the cluster clock,
 * read together so an execution can be checked against a single consistent snapshot.
 *
 * @typedef {Object} SquadsProposalContext
 * @property {SquadsMultisigAccount} multisig - The decoded multisig account.
 * @property {SquadsProposalAccount} proposal - The decoded proposal account.
 * @property {SquadsTransactionAccount} transaction - The decoded transaction account.
 * @property {bigint} now - The cluster's current Unix timestamp, read from the clock sysvar.
 */

export const SQUADS_PROGRAM_ADDRESS = 'SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf'

/**
 * The transaction kinds a Squads proposal can back, keyed by kind.
 *
 * @type {{ [K in SquadsTransactionKind]: K }}
 */
export const TRANSACTION_KIND = { vault: 'vault', config: 'config', batch: 'batch' }

const PROPOSAL_STATUS_LABELS = [
  { name: 'Draft', phrase: 'a draft' },
  { name: 'Active', phrase: 'open for voting' },
  { name: 'Rejected', phrase: 'rejected' },
  { name: 'Approved', phrase: 'approved' },
  { name: 'Executing', phrase: 'executing' },
  { name: 'Executed', phrase: 'executed' },
  { name: 'Cancelled', phrase: 'cancelled' }
]

// What is left of the byte arithmetic: the account sizes the rent quotes are computed from, which
// `src/helpers/layouts.js` cannot supply because the accounts are sized before they hold anything.
const SIZE = {
  member: 33,
  vecPrefix: 4,
  multisigBase: 132,
  vaultTransactionBase: 83,
  configTransactionBase: 81,
  proposalBase: 70,
  proposalMember: 96
}

const COUNT = { multisigCreateSignatures: 2n }

const SEED = {
  prefix: 'multisig',
  multisig: 'multisig',
  vault: 'vault',
  transaction: 'transaction',
  proposal: 'proposal',
  programConfig: 'program_config',
  spendingLimit: 'spending_limit',
  ephemeralSigner: 'ephemeral_signer'
}

/** @type {{ multisig: 8, proposal: 4, transaction: 2, now: 1, all: 15 }} */
export const PROPOSAL_DATA_MASK = { multisig: 8, proposal: 4, transaction: 2, now: 1, all: 15 }

const DEFAULT = { vaultIndex: 0, memberCount: 1, authority: SYSTEM_PROGRAM_ADDRESS }

export const SECRET_SIZE = { privateKey: 32, keyPair: 64 }

const MAX = {
  vaultIndex: 255,
  memberCount: 65535,
  proposalIndex: 18446744073709551615n,
  multipleAccounts: 100
}

export const SIGNATURE_BASE_FEE = 5000n

/** @type {{ [K in Commitment]: Finality }} */
const FINALITY = { processed: 'pending', confirmed: 'confirmed', finalized: 'final' }

/**
 * Read-only Solana Squads multisig wallet account implementation.
 *
 * @implements {IWalletAccountReadOnlyMultisig}
 */
export default class WalletAccountReadOnlyMultisigSquads extends WalletAccountReadOnly {
  /**
   * The default poll cadence for `waitForTransaction`, one slot rather than the block time the
   * base class assumes.
   *
   * @type {number}
   */
  get defaultWaitInterval () {
    return 400
  }

  /**
   * Creates a new read-only Solana Squads multisig wallet account.
   *
   * @param {MultisigSquadsWalletReadOnlyConfig} config - The configuration object.
   */
  constructor (config) {
    const programId = address(config.programId ?? SQUADS_PROGRAM_ADDRESS)
    const identity = config.multisigPdaOrCreateKey ?? (config.createKeySecret &&
      WalletAccountReadOnlyMultisigSquads.getCreateKey(config.createKeySecret))

    super(WalletAccountReadOnlyMultisigSquads.toMultisigPda(programId, identity))

    /**
     * The multisig Squads configuration. It carries the signing fields too when a signing
     * account owns it, or when one derived this account through `_withConfig`.
     *
     * @protected
     * @type {MultisigSquadsWalletConfig}
     */
    this._config = config

    /**
     * The address of the Squads program to operate against.
     *
     * @protected
     * @type {Address}
     */
    this._programId = programId

    /**
     * The commitment level for transactions.
     *
     * @protected
     * @type {Commitment}
     */
    this._commitment = config.commitment ?? 'confirmed'

    /**
     * A Solana RPC client for HTTP requests.
     *
     * @protected
     * @type {SolanaRpc | undefined}
     */
    this._rpc = WalletAccountReadOnlyMultisigSquads.createRpc(config)
  }

  /**
   * Normalizes a create key secret to bytes, rejecting what cannot be one. Both the address
   * derivation and the signer build read a secret through this, so they refuse the same inputs.
   *
   * @param {string | Uint8Array} createKeySecret - The secret, base58 or raw bytes.
   * @returns {Uint8Array} The secret's bytes, either 32 or 64 of them.
   * @throws {ValueError} The secret must be given, and must be 32 or 64 bytes.
   */
  static toCreateKeySecretBytes (createKeySecret) {
    if (!createKeySecret) {
      throw new ValueError(
        'A `createKeySecret` is required to create a multisig. Provide it in the configuration.'
      )
    }

    const bytes = typeof createKeySecret === 'string'
      ? getBase58Encoder().encode(createKeySecret)
      : createKeySecret

    if (bytes.length !== SECRET_SIZE.privateKey && bytes.length !== SECRET_SIZE.keyPair) {
      throw new ValueError(
        `Invalid createKeySecret of ${bytes.length} bytes. Expected ${SECRET_SIZE.privateKey} or ${SECRET_SIZE.keyPair}.`
      )
    }

    return bytes
  }

  /**
   * Derives the create key's address from its secret, without building a signer. Synchronous, so a
   * multisig's address is known at construction rather than on the first call that needs it.
   *
   * @param {string | Uint8Array} createKeySecret - The create key's secret. Base58 or raw bytes, either a 32-byte private key or a 64-byte keypair.
   * @returns {string} The create key's address.
   */
  static getCreateKey (createKeySecret) {
    const bytes = this.toCreateKeySecretBytes(createKeySecret)

    return getBase58Decoder().decode(
      bytes.length === SECRET_SIZE.privateKey
        ? ed25519.getPublicKey(bytes)
        : bytes.subarray(SECRET_SIZE.privateKey)
    )
  }

  /**
   * Resolves what a config names, an address or a create key, to the multisig's address. A create
   * key is on the ed25519 curve and a multisig address is not, so the two need no disambiguation
   * beyond the value itself.
   *
   * @param {string} programId - The Squads program the multisig belongs to.
   * @param {string} [multisigPdaOrCreateKey] - The multisig address, or the create key it derives from.
   * @returns {Address | undefined} The multisig address, or undefined when neither is given.
   */
  static toMultisigPda (programId, multisigPdaOrCreateKey) {
    if (!multisigPdaOrCreateKey) {
      return undefined
    }

    const identity = address(multisigPdaOrCreateKey)

    if (isOffCurveAddress(identity)) {
      return identity
    }

    const [multisigPda] = getProgramDerivedAddressSync({
      programAddress: address(programId),
      seeds: [SEED.prefix, SEED.multisig, getAddressEncoder().encode(identity)]
    })

    return multisigPda
  }

  /**
   * Builds the RPC client a configuration asks for: one client per URL behind a failover proxy
   * when it names a list, a single client when it names one URL, and none when it names neither.
   *
   * @param {MultisigSquadsWalletReadOnlyConfig} [config] - The configuration to read `provider` and `retries` from.
   * @returns {SolanaRpc | undefined} The client, or undefined when no provider is configured.
   */
  static createRpc ({ provider, retries = 3 } = {}) {
    if (Array.isArray(provider)) {
      if (provider.length === 0) {
        return undefined
      }

      const failoverProvider = new FailoverProvider({ retries })

      for (const entry of provider) {
        failoverProvider.addProvider(createSolanaRpc(entry))
      }

      return failoverProvider.initialize()
    }

    return provider ? createSolanaRpc(provider) : undefined
  }

  /**
   * Returns whether the multisig account exists on-chain.
   *
   * @returns {Promise<boolean>} Whether the multisig account exists.
   * @throws {ProviderRequiredError} The wallet must be connected to a provider.
   */
  async isDeployed () {
    if (!this._rpc) {
      throw new ProviderRequiredError('The wallet must be connected to a provider to check whether the multisig exists.')
    }

    const multisigPda = await this.getAddress()

    const { value } = await this._rpc
      .getAccountInfo(address(multisigPda), {
        commitment: this._commitment,
        encoding: 'base64',
        dataSlice: { offset: 0, length: ACCOUNT_DISCRIMINATOR.multisig.length }
      })
      .send()

    if (!value) {
      return false
    }

    if (value.owner !== this._programId) {
      return false
    }

    return this._hasDiscriminator(
      getBase64Encoder().encode(value.data[0]),
      ACCOUNT_DISCRIMINATOR.multisig
    )
  }

  /**
   * Returns aggregated information about the multisig.
   *
   * @returns {Promise<MultisigSquadsInfo>} The multisig info.
   */
  async getMultisigInfo () {
    const { address: multisigPda, threshold, members } = await this._getMultisigAccount()

    return {
      address: multisigPda,
      owners: members.map((member) => member.address),
      masks: members.map((member) => member.mask),
      threshold
    }
  }

  /**
   * Returns the transaction index of the most recently created transaction.
   *
   * @returns {Promise<bigint>} The transaction index.
   * @throws {ProviderRequiredError} The wallet must be connected to a provider.
   * @throws {NoSuchElementError} The multisig account must exist.
   * @throws {ValueError} The account must hold a Squads multisig.
   */
  async getNonce () {
    if (!this._rpc) {
      throw new ProviderRequiredError('The wallet must be connected to a provider to read the transaction index.')
    }

    const multisigPda = await this.getAddress()

    const { value } = await this._rpc
      .getAccountInfo(address(multisigPda), {
        commitment: this._commitment,
        encoding: 'base64',
        dataSlice: { offset: 0, length: ACCOUNT.multisigHeader.fixedSize }
      })
      .send()

    if (!value) {
      throw new NoSuchElementError(
        `The multisig account ${multisigPda} does not exist. Deploy it before reading its transaction index.`
      )
    }

    const data = getBase64Encoder().encode(value.data[0])

    if (
      value.owner !== this._programId ||
      !this._hasDiscriminator(data, ACCOUNT_DISCRIMINATOR.multisig)
    ) {
      throw new ValueError(`The account ${multisigPda} is not a Squads multisig.`)
    }

    return ACCOUNT.multisigHeader.decode(data).transactionIndex
  }

  /**
   * Returns the address of one of the multisig's vaults, where its funds are held. An address is
   * accepted only when it derives from this multisig, so a vault of another multisig, or an
   * unrelated account, is rejected rather than read.
   *
   * @param {number | string} [vaultIndexOrAddress] - A vault index between 0 and `MAX.vaultIndex`, or the address of one of this multisig's vaults (default: 0).
   * @returns {Promise<string>} The vault address.
   * @throws {ValueError} The index must be in range, and the address must be valid base58 and belong to this multisig.
   */
  async getVaultAddress (vaultIndexOrAddress = DEFAULT.vaultIndex) {
    if (typeof vaultIndexOrAddress === 'string') {
      const vaultPda = address(vaultIndexOrAddress)
      const multisigPda = await this.getAddress()

      for (let index = DEFAULT.vaultIndex; index <= MAX.vaultIndex; index++) {
        if (this._getVaultPda(multisigPda, index) === vaultPda) {
          return vaultPda
        }
      }

      throw new ValueError(
        `The address ${vaultIndexOrAddress} is not a vault of the multisig ${multisigPda}.`
      )
    }

    if (
      !Number.isInteger(vaultIndexOrAddress) ||
      vaultIndexOrAddress < DEFAULT.vaultIndex ||
      vaultIndexOrAddress > MAX.vaultIndex
    ) {
      throw new ValueError(
        `Invalid vault index ${vaultIndexOrAddress}. It must be an integer between ${DEFAULT.vaultIndex} and ${MAX.vaultIndex}.`
      )
    }

    const multisigPda = await this.getAddress()
    return this._getVaultPda(multisigPda, vaultIndexOrAddress)
  }

  /**
   * Returns the native SOL balance of one of the multisig's vaults.
   *
   * @param {number | string} [vaultIndexOrAddress] - A vault index between 0 and `MAX.vaultIndex`, or a vault address to read as given (default: 0).
   * @returns {Promise<bigint>} The balance in lamports.
   * @throws {ProviderRequiredError} The wallet must be connected to a provider.
   */
  async getBalance (vaultIndexOrAddress = DEFAULT.vaultIndex) {
    if (!this._rpc) {
      throw new ProviderRequiredError('The wallet must be connected to a provider to retrieve balances.')
    }

    const vaultPda = await this.getVaultAddress(vaultIndexOrAddress)

    const { value } = await this._rpc
      .getBalance(address(vaultPda), { commitment: this._commitment })
      .send()

    return value
  }

  /**
   * Returns the balance of an SPL token held by one of the multisig's vaults.
   *
   * @param {string} tokenAddress - The SPL token mint address.
   * @param {number | string} [vaultIndexOrAddress] - A vault index between 0 and `MAX.vaultIndex`, or a vault address to read as given (default: 0).
   * @returns {Promise<bigint>} The token balance (in base unit).
   * @throws {ProviderRequiredError} The wallet must be connected to a provider.
   * @todo Support Token-2022 (Token Extensions Program).
   */
  async getTokenBalance (tokenAddress, vaultIndexOrAddress = DEFAULT.vaultIndex) {
    if (!this._rpc) {
      throw new ProviderRequiredError('The wallet must be connected to a provider to retrieve token balances.')
    }

    const mint = address(tokenAddress)
    const vaultPda = await this.getVaultAddress(vaultIndexOrAddress)

    const [ata] = await findAssociatedTokenPda({
      mint,
      owner: address(vaultPda),
      tokenProgram: TOKEN_PROGRAM_ADDRESS
    })

    const { value } = await this._rpc
      .getAccountInfo(ata, { commitment: this._commitment, encoding: 'jsonParsed' })
      .send()

    if (!value) {
      return 0n
    }

    return BigInt(value.data.parsed.info.tokenAmount.amount)
  }

  /**
   * Retrieves a transaction receipt by its signature.
   *
   * @param {string} hash - The transaction signature.
   * @returns {Promise<SolanaTransactionReceipt | null>} The receipt, or null if the transaction was not found.
   * @throws {ProviderRequiredError} The wallet must be connected to a provider.
   * @throws {ValueError} The signature must be 64 base58-encoded bytes.
   */
  async getTransactionReceipt (hash) {
    if (!this._rpc) {
      throw new ProviderRequiredError('The wallet must be connected to a provider to retrieve transaction receipts.')
    }

    if (!isSignature(hash)) {
      throw new ValueError(`Invalid transaction signature: ${hash}`)
    }

    return this._rpc
      .getTransaction(hash, {
        commitment: this._commitment === 'processed' ? 'confirmed' : this._commitment,
        maxSupportedTransactionVersion: 0,
        encoding: 'json'
      })
      .send()
  }

  /**
   * Retrieves a transaction's normalized receipt, which `waitForTransaction` polls.
   *
   * A signature the cluster has evicted and one it has never seen are indistinguishable without
   * the transaction's blockhash, which a signature alone does not carry, so a dropped transaction
   * raises `NoSuchElementError` rather than reporting a `dropped` finality. A caller waiting on
   * one therefore times out instead of being told it was dropped.
   *
   * @param {string} hash - The transaction signature.
   * @returns {Promise<TransactionReceipt>} The normalized receipt. `fee` is omitted while the transaction is below the account's commitment.
   * @throws {ProviderRequiredError} The wallet must be connected to a provider.
   * @throws {ValueError} The signature must be 64 base58-encoded bytes.
   * @throws {NoSuchElementError} The cluster must hold a status for the signature.
   */
  async getTransaction (hash) {
    if (!this._rpc) {
      throw new ProviderRequiredError('The wallet must be connected to a provider to retrieve transactions.')
    }

    if (!isSignature(hash)) {
      throw new ValueError(`Invalid transaction signature: ${hash}`)
    }

    const { value: [status] } = await this._rpc
      .getSignatureStatuses([hash], { searchTransactionHistory: true })
      .send()

    if (!status) {
      throw new NoSuchElementError(`No transaction found at signature ${hash}.`)
    }

    const finality = FINALITY[status.confirmationStatus ?? 'processed']

    if (finality === 'pending') {
      return { hash, finality }
    }

    const receipt = await this.getTransactionReceipt(hash)
    const normalized = { hash, finality, success: !status.err, block: Number(status.slot) }

    return receipt ? { ...normalized, fee: receipt.meta.fee } : normalized
  }

  /**
   * Verifies a message's signature. Not supported by Squads.
   *
   * @param {string} message - The signed message.
   * @param {string} signature - The signature to verify.
   * @returns {Promise<boolean>} Whether the signature is valid.
   * @throws {UnsupportedOperationError} A multisig address has no private key to attribute a signature to.
   */
  async verify (message, signature) {
    throw new UnsupportedOperationError('verify(message, signature)')
  }

  /**
   * Returns the proposals at the given ids, keyed by id in canonical decimal form.
   *
   * @param {(number | bigint | string)[]} proposalIds - The proposal (transaction index) ids.
   * @returns {Promise<Record<string, MultisigSquadsProposal | null>>} For each id, the proposal, or null if no proposal exists at that id.
   * @throws {ProviderRequiredError} The wallet must be connected to a provider.
   * @throws {NoSuchElementError} The multisig account must exist.
   */
  async getProposals (proposalIds) {
    if (!proposalIds.length) {
      return {}
    }

    if (!this._rpc) {
      throw new ProviderRequiredError('The wallet must be connected to a provider to read proposals.')
    }

    const { address: multisigPda, threshold, isCreated } = await this._getMultisigAccount()

    if (!isCreated) {
      throw new NoSuchElementError(
        `The multisig account ${multisigPda} does not exist. Deploy it before reading its proposals.`
      )
    }

    const indices = proposalIds.map((id) => this._toProposalIndex(id))
    const proposalPdas = indices.map((index) => this._getProposalPda(multisigPda, index))

    const proposals = {}

    for (let offset = 0; offset < proposalPdas.length; offset += MAX.multipleAccounts) {
      const { value } = await this._rpc
        .getMultipleAccounts(proposalPdas.slice(offset, offset + MAX.multipleAccounts), {
          commitment: this._commitment,
          encoding: 'base64'
        })
        .send()

      value.forEach((account, i) => {
        const index = indices[offset + i]
        const proposal = this._decodeProposalAccount(proposalPdas[offset + i], account)

        proposals[index.toString()] = proposal.exists
          ? {
              proposalId: index.toString(),
              confirmations: proposal.approved.length,
              threshold,
              status: proposal.status === PROPOSAL_STATUS.executed ? 'executed' : 'pending',
              statusName: proposal.statusName,
              approved: proposal.approved,
              rejected: proposal.rejected,
              cancelled: proposal.cancelled
            }
          : null
      })
    }

    return proposals
  }

  /**
   * Returns the proposal at the given id.
   *
   * @param {number | bigint | string} proposalId - The proposal (transaction index) id.
   * @returns {Promise<MultisigSquadsProposal | null>} The proposal, or null if no proposal exists at that id.
   */
  async getProposal (proposalId) {
    const proposals = await this.getProposals([proposalId])

    return proposals[this._toProposalIndex(proposalId).toString()]
  }

  /**
   * Returns whether a proposal can be executed right now, meaning `executeProposal` would submit
   * it rather than throw. A batch reads as not ready for that reason, though the program would
   * execute one.
   *
   * @param {number | bigint | string} proposalId - The proposal (transaction index) id.
   * @returns {Promise<boolean>} Whether the proposal can be executed.
   */
  async isReadyToExecute (proposalId) {
    const index = this._toProposalIndex(proposalId)
    const { multisig, proposal, transaction, now } = await this._getProposal(index)

    if (!multisig.isCreated || !proposal.exists) {
      return false
    }

    if (proposal.status !== PROPOSAL_STATUS.approved) {
      return false
    }

    const executable = transaction.kind === TRANSACTION_KIND.vault ||
      (transaction.kind === TRANSACTION_KIND.config && index > multisig.staleTransactionIndex)

    if (!executable) {
      return false
    }

    return now - proposal.statusTimestamp >= BigInt(multisig.timeLock)
  }

  /**
   * Quotes the costs of a send transaction operation. Not supported by Squads.
   *
   * @param {SolanaTransaction} tx - The transaction to quote.
   * @returns {Promise<Omit<TransactionResult, 'hash'>>} The transaction's quote.
   * @throws {UnsupportedOperationError} A multisig proposes transactions rather than submitting them.
   */
  async quoteSendTransaction (tx) {
    throw new UnsupportedOperationError('quoteSendTransaction(tx)')
  }

  /**
   * Quotes the costs of a deploy operation.
   *
   * @param {number} [memberCount] - The number of members the multisig will hold (default: 1).
   * @returns {Promise<Omit<TransactionResult, 'hash'>>} The deploy quote, in lamports.
   * @throws {ProviderRequiredError} The wallet must be connected to a provider.
   */
  async quoteDeploy (memberCount = DEFAULT.memberCount) {
    this._validateMemberCount(memberCount)

    if (!this._rpc) {
      throw new ProviderRequiredError('The wallet must be connected to a provider to quote deploy operations.')
    }

    const [programConfig, rent] = await Promise.all([
      this._getProgramConfig(),
      this._rpc
        .getMinimumBalanceForRentExemption(BigInt(this._multisigAccountSize(memberCount)))
        .send()
    ])

    return { fee: this._quoteDeployFrom(programConfig.creationFee, rent) }
  }

  /**
   * Quotes the costs of a propose operation.
   *
   * @param {SolanaTransaction} tx - The transaction to quote, either arm of `SolanaTransaction`.
   * @param {MultisigSquadsWalletConfig} [config] - An optional config override, merged over this account's configuration.
   * @returns {Promise<Omit<TransactionResult, 'hash'>>} The transaction quote, in lamports. Sized from the message the proposal would store, so it is exact for any transaction `propose` accepts.
   * @throws {ProviderRequiredError} The wallet must be connected to a provider.
   * @throws {NoSuchElementError} The multisig must exist.
   */
  async quotePropose (tx, config) {
    const account = await this._withConfig(config)

    if (!account._rpc) {
      throw new ProviderRequiredError('The wallet must be connected to a provider to quote transactions.')
    }

    const { address: multisigPda, members, isCreated } = await account._getMultisigAccount()

    if (!isCreated) {
      throw new NoSuchElementError(
        `The multisig account ${multisigPda} does not exist. Deploy it before quoting transactions.`
      )
    }

    const vaultPda = address(await account.getVaultAddress(DEFAULT.vaultIndex))
    const compiled = account._compileTransactionMessage(
      vaultPda,
      account._toProposedInstructions(vaultPda, tx)
    )

    const { fee } = await account._quoteProposal(
      account._vaultTransactionSize(compiled.storedSize),
      members.length
    )

    return { fee }
  }

  /**
   * Quotes the costs of a transfer operation.
   *
   * @param {TransferOptions} transferOptions - The transfer options.
   * @param {MultisigSquadsWalletConfig} [config] - An optional config override, merged over this account's configuration.
   * @returns {Promise<Omit<TransactionResult, 'hash'>>} The transfer quote, in lamports.
   * @throws {ProviderRequiredError} The wallet must be connected to a provider.
   * @throws {NoSuchElementError} The multisig must exist.
   * @todo Support Token-2022 (Token Extensions Program).
   */
  async quoteTransfer (transferOptions, config) {
    address(transferOptions.token)
    address(transferOptions.recipient)

    const account = await this._withConfig(config)

    if (!account._rpc) {
      throw new ProviderRequiredError('The wallet must be connected to a provider to quote transfer operations.')
    }

    const { address: multisigPda, members, isCreated } = await account._getMultisigAccount()

    if (!isCreated) {
      throw new NoSuchElementError(
        `The multisig account ${multisigPda} does not exist. Deploy it before quoting transfers.`
      )
    }

    const vaultPda = address(await account.getVaultAddress(DEFAULT.vaultIndex))
    const compiled = account._compileTransactionMessage(
      vaultPda,
      await account._toTransferInstructions(vaultPda, transferOptions)
    )

    const { fee } = await account._quoteProposal(
      account._vaultTransactionSize(compiled.storedSize),
      members.length
    )

    return { fee }
  }

  /**
   * Quotes the costs of an execute proposal operation.
   *
   * @param {number | bigint | string} proposalId - The proposal (transaction index) id.
   * @returns {Promise<Omit<TransactionResult, 'hash'>>} The execution quote, in lamports.
   * @throws {NoSuchElementError} A proposal must exist at that id.
   */
  async quoteExecuteProposal (proposalId) {
    const index = this._toProposalIndex(proposalId)
    const { multisig, proposal } = await this._getProposal(
      index,
      PROPOSAL_DATA_MASK.multisig | PROPOSAL_DATA_MASK.proposal
    )

    if (!proposal.exists) {
      throw new NoSuchElementError(
        `The multisig ${multisig.address} has no proposal at index ${index}.`
      )
    }

    return { fee: SIGNATURE_BASE_FEE }
  }

  /**
   * Reads and decodes the multisig account, keeping every field it holds.
   *
   * @protected
   * @returns {Promise<SquadsMultisigAccount>} The decoded account.
   * @throws {ProviderRequiredError} The wallet must be connected to a provider.
   */
  async _getMultisigAccount () {
    if (!this._rpc) {
      throw new ProviderRequiredError('The wallet must be connected to a provider to read the multisig account.')
    }

    const multisigPda = await this.getAddress()

    const { value } = await this._rpc
      .getAccountInfo(address(multisigPda), {
        commitment: this._commitment,
        encoding: 'base64'
      })
      .send()

    return this._decodeMultisigAccount(multisigPda, value)
  }

  /**
   * Reads a proposal's whole context in one request.
   *
   * @overload
   * @param {bigint} index - The proposal (transaction index) id.
   * @returns {Promise<SquadsProposalContext>} The multisig, the proposal, its transaction and the cluster clock.
   * @throws {ProviderRequiredError} The wallet must be connected to a provider.
   * @throws {ProviderError} The provider must serve the cluster clock.
   */
  /**
   * Reads a proposal's context in one request, the parts `mask` names.
   *
   * @overload
   * @param {bigint} index - The proposal (transaction index) id. Read only for the parts that need it.
   * @param {number} mask - The parts to read, as the bits `[multisig, proposal, transaction, now]`.
   * @returns {Promise<Partial<SquadsProposalContext>>} The parts asked for, and nothing else.
   * @throws {ProviderRequiredError} The wallet must be connected to a provider.
   * @throws {ProviderError} The provider must serve the cluster clock, when `now` is asked for.
   */
  /** @protected */
  async _getProposal (index, mask = PROPOSAL_DATA_MASK.all) {
    if (!this._rpc) {
      throw new ProviderRequiredError('The wallet must be connected to a provider to read the multisig and its proposals.')
    }

    const multisigPda = await this.getAddress()
    const parts = []

    if (mask & PROPOSAL_DATA_MASK.multisig) {
      parts.push({
        name: 'multisig',
        target: address(multisigPda),
        decode: (value) => this._decodeMultisigAccount(multisigPda, value)
      })
    }

    if (mask & PROPOSAL_DATA_MASK.proposal) {
      const proposalPda = this._getProposalPda(multisigPda, index)

      parts.push({
        name: 'proposal',
        target: proposalPda,
        decode: (value) => this._decodeProposalAccount(proposalPda, value)
      })
    }

    if (mask & PROPOSAL_DATA_MASK.transaction) {
      const transactionPda = this._getTransactionPda(multisigPda, index)

      parts.push({
        name: 'transaction',
        target: transactionPda,
        decode: (value) => this._decodeTransactionAccount(transactionPda, value)
      })
    }

    if (mask & PROPOSAL_DATA_MASK.now) {
      parts.push({
        name: 'now',
        target: SYSVAR_CLOCK_ADDRESS,
        decode: (value) => {
          if (!value) {
            throw new ProviderError(
              `The clock sysvar ${SYSVAR_CLOCK_ADDRESS} could not be read.`,
              { reason: ProviderErrorReason.INTERNAL_SERVER_ERROR }
            )
          }

          return ACCOUNT.clock.decode(getBase64Encoder().encode(value.data[0])).unixTimestamp
        }
      })
    }

    const { value } = await this._rpc
      .getMultipleAccounts(parts.map(({ target }) => target), {
        commitment: this._commitment,
        encoding: 'base64'
      })
      .send()

    return Object.fromEntries(
      parts.map(({ name, decode }, slot) => [name, decode(value[slot])])
    )
  }

  /**
   * Reads the Squads program config account.
   *
   * @protected
   * @returns {Promise<SquadsProgramConfig>} The program config address, its multisig creation fee, and its treasury address.
   * @throws {ProviderRequiredError} The wallet must be connected to a provider.
   * @throws {NoSuchElementError} The account must exist and must be a program config.
   */
  async _getProgramConfig () {
    if (!this._rpc) {
      throw new ProviderRequiredError('The wallet must be connected to a provider to read the Squads program config.')
    }

    const [programConfigPda] = getProgramDerivedAddressSync({
      programAddress: this._programId,
      seeds: [SEED.prefix, SEED.programConfig]
    })

    const { value } = await this._rpc
      .getAccountInfo(programConfigPda, {
        commitment: this._commitment,
        encoding: 'base64'
      })
      .send()

    const data = value && getBase64Encoder().encode(value.data[0])

    if (!data || !this._hasDiscriminator(data, ACCOUNT_DISCRIMINATOR.programConfig)) {
      throw new NoSuchElementError(
        `The Squads program config account ${programConfigPda} could not be read.`
      )
    }

    const { creationFee, treasury } = ACCOUNT.programConfig.decode(data)

    return { programConfigPda, creationFee, treasury }
  }

  /**
   * Normalizes a proposed transaction into the instruction list a vault transaction executes. A
   * `{ to, value }` transaction becomes a single SOL transfer; a message is taken as it stands,
   * minus the lifetime and version a stored message has no room for.
   *
   * @protected
   * @param {Address} vaultPda - The vault the instructions execute from.
   * @param {SolanaTransaction} tx - The transaction to propose.
   * @returns {CompilableInstruction[]} The instructions, in kit's shape.
   * @throws {ValueError} The transaction must be one arm of `SolanaTransaction`, must carry at least one instruction, must name the vault as its fee payer, and must require no signature the vault cannot give.
   */
  _toProposedInstructions (vaultPda, tx) {
    if (tx && tx.to !== undefined && tx.value !== undefined) {
      return [
        {
          programAddress: SYSTEM_PROGRAM_ADDRESS,
          accounts: [
            { address: vaultPda, role: AccountRole.WRITABLE_SIGNER },
            { address: address(tx.to), role: AccountRole.WRITABLE }
          ],
          data: getTransferSolInstructionDataEncoder().encode({ amount: BigInt(tx.value) })
        }
      ]
    }

    if (!tx || !Array.isArray(tx.instructions)) {
      throw new ValueError(
        'A proposed transaction must be either `{ to, value }` or a message carrying `instructions`.'
      )
    }

    if (tx.instructions.length === 0) {
      throw new ValueError('A proposed transaction must carry at least one instruction.')
    }

    const feePayer = typeof tx.feePayer === 'string' ? tx.feePayer : tx.feePayer?.address

    if (feePayer !== undefined && feePayer !== vaultPda) {
      throw new ValueError(
        `The transaction pays from ${feePayer}, but a proposal executes from the vault ${vaultPda}.`
      )
    }

    return tx.instructions.map((instruction) => {
      const accounts = (instruction.accounts ?? []).map((account) => ({
        address: address(account.address),
        role: account.role
      }))

      for (const account of accounts) {
        const signs = account.role === AccountRole.READONLY_SIGNER ||
          account.role === AccountRole.WRITABLE_SIGNER

        if (signs && account.address !== vaultPda) {
          throw new ValueError(
            `The instruction needs ${account.address} to sign, which the vault ${vaultPda} cannot do.`
          )
        }
      }

      return {
        programAddress: address(instruction.programAddress),
        accounts,
        data: instruction.data ?? new Uint8Array()
      }
    })
  }

  /**
   * Builds the instructions an SPL transfer executes from a vault: the idempotent creation of the
   * recipient's associated token account when it does not hold one yet, then the transfer. The
   * quote and the proposal both go through this, so neither can price a message the other would
   * not build.
   *
   * @protected
   * @param {Address} vaultPda - The vault the transfer executes from, and the payer of the account it may create.
   * @param {TransferOptions} transferOptions - The transfer options.
   * @returns {Promise<CompilableInstruction[]>} The instructions, in kit's shape.
   * @throws {InvalidTokenError} The token must be an existing mint.
   */
  async _toTransferInstructions (vaultPda, transferOptions) {
    const mint = address(transferOptions.token)
    const recipient = address(transferOptions.recipient)

    const [[source], [destination]] = await Promise.all([
      findAssociatedTokenPda({ mint, owner: vaultPda, tokenProgram: TOKEN_PROGRAM_ADDRESS }),
      findAssociatedTokenPda({ mint, owner: recipient, tokenProgram: TOKEN_PROGRAM_ADDRESS })
    ])

    const { value } = await this._rpc
      .getMultipleAccounts([mint, destination], {
        commitment: this._commitment,
        encoding: 'base64'
      })
      .send()

    const [mintAccount, destinationAccount] = value

    if (!mintAccount) {
      throw new InvalidTokenError(`The token mint ${mint} does not exist.`)
    }

    const instructions = []

    if (!destinationAccount) {
      instructions.push(
        getCreateAssociatedTokenIdempotentInstruction({
          ata: destination,
          mint,
          owner: recipient,
          payer: vaultPda
        })
      )
    }

    instructions.push(
      getTransferInstruction({
        source,
        destination,
        authority: vaultPda,
        amount: BigInt(transferOptions.amount)
      })
    )

    return instructions
  }

  /**
   * Compiles instructions into the message a vault transaction stores, in both the form the
   * create instruction carries and the size the account will be allocated at.
   *
   * @protected
   * @param {Address} payer - The vault the message is executed from, which is its first key.
   * @param {CompilableInstruction[]} instructions - The instructions, in kit's shape.
   * @returns {CompiledTransactionMessage} The compiled message.
   */
  _compileTransactionMessage (payer, instructions) {
    const roles = new Map()
    const note = (candidate, signer, writable) => {
      const current = roles.get(candidate) ?? { signer: false, writable: false }

      roles.set(candidate, {
        signer: current.signer || signer,
        writable: current.writable || writable
      })
    }

    note(payer, true, true)

    for (const instruction of instructions) {
      note(instruction.programAddress, false, false)

      for (const account of instruction.accounts) {
        note(
          account.address,
          account.role === AccountRole.READONLY_SIGNER || account.role === AccountRole.WRITABLE_SIGNER,
          account.role === AccountRole.WRITABLE || account.role === AccountRole.WRITABLE_SIGNER
        )
      }
    }

    const entries = [...roles.entries()]
    const group = (signer, writable) => entries
      .filter(([, role]) => role.signer === signer && role.writable === writable)
      .map(([candidate]) => candidate)

    const keys = [
      ...group(true, true),
      ...group(true, false),
      ...group(false, true),
      ...group(false, false)
    ]

    const compiled = instructions.map((instruction) => ({
      programIdIndex: keys.indexOf(instruction.programAddress),
      accountIndexes: instruction.accounts.map((account) => keys.indexOf(account.address)),
      data: instruction.data
    }))

    const header = {
      numSigners: entries.filter(([, role]) => role.signer).length,
      numWritableSigners: group(true, true).length,
      numWritableNonSigners: group(false, true).length
    }

    const message = {
      ...header,
      accountKeys: keys,
      instructions: compiled,
      addressTableLookups: []
    }

    return {
      bytes: TRANSACTION_MESSAGE.encode(message),
      storedSize: STORED_TRANSACTION_MESSAGE.getSizeFromValue(message),
      accountKeys: keys,
      ...header
    }
  }

  /**
   * Validates a multisig's membership size against what the program can hold.
   *
   * @protected
   * @param {number} memberCount - How many members the multisig would hold.
   * @returns {void} Nothing; throws when the count is out of range.
   * @throws {ValueError} The count must be an integer between 1 and 65,535.
   */
  _validateMemberCount (memberCount) {
    if (!Number.isInteger(memberCount) || memberCount < 1 || memberCount > MAX.memberCount) {
      throw new ValueError(
        `Invalid member count ${memberCount}. It must be an integer between 1 and ${MAX.memberCount}.`
      )
    }
  }

  /**
   * Returns the size of the `Multisig` account a multisig of the given membership is stored in.
   *
   * @protected
   * @param {number} memberCount - How many members the multisig holds.
   * @returns {number} The account's size, in bytes.
   */
  _multisigAccountSize (memberCount) {
    return SIZE.multisigBase + SIZE.member * memberCount
  }

  /**
   * Adds up what creating a multisig costs: the account's rent, the protocol's creation fee, and
   * the two signatures `multisigCreateV2` needs.
   *
   * @protected
   * @param {bigint} creationFee - The protocol's multisig creation fee.
   * @param {bigint} rent - The multisig account's rent-exempt minimum.
   * @returns {bigint} The whole cost, in lamports.
   */
  _quoteDeployFrom (creationFee, rent) {
    return rent + creationFee + SIGNATURE_BASE_FEE * COUNT.multisigCreateSignatures
  }

  /**
   * Returns the size of the `VaultTransaction` account a message of the given size is stored in.
   *
   * @protected
   * @param {number} messageSize - The size of the compiled transaction message, in bytes.
   * @returns {number} The account's size, in bytes.
   */
  _vaultTransactionSize (messageSize) {
    return SIZE.vaultTransactionBase + SIZE.vecPrefix + messageSize
  }

  /**
   * Returns the size of the `ConfigTransaction` account the given actions are stored in.
   *
   * @protected
   * @param {number} actionsSize - The size of the encoded action list, its length prefix included.
   * @returns {number} The account's size, in bytes.
   */
  _configTransactionSize (actionsSize) {
    return SIZE.configTransactionBase + actionsSize
  }

  /**
   * Quotes a proposal of a message of the given size: the rent of the two accounts it creates,
   * and that rent plus the proposer's signature, which is what the caller is debited.
   *
   * @protected
   * @param {number} transactionSize - The size of the transaction account, in bytes.
   * @param {number} memberCount - How many members the multisig holds.
   * @returns {Promise<{ rent: bigint, fee: bigint }>} The rent alone, and the whole cost.
   */
  async _quoteProposal (transactionSize, memberCount) {
    const rent = await this._quoteProposalRent(transactionSize, memberCount)

    return { rent, fee: rent + SIGNATURE_BASE_FEE }
  }

  /**
   * Quotes the rent of the two accounts a proposal creates, the transaction and the proposal.
   *
   * @protected
   * @param {number} transactionSize - The size of the transaction account, in bytes.
   * @param {number} memberCount - How many members the multisig holds.
   * @returns {Promise<bigint>} The rent both accounts lock up, in lamports.
   * @throws {ProviderRequiredError} The wallet must be connected to a provider.
   */
  async _quoteProposalRent (transactionSize, memberCount) {
    if (!this._rpc) {
      throw new ProviderRequiredError('The wallet must be connected to a provider to quote account rent.')
    }

    const proposalSize = SIZE.proposalBase + SIZE.proposalMember * memberCount

    const [transactionRent, proposalRent] = await Promise.all([
      this._rpc.getMinimumBalanceForRentExemption(BigInt(transactionSize)).send(),
      this._rpc.getMinimumBalanceForRentExemption(BigInt(proposalSize)).send()
    ])

    return transactionRent + proposalRent
  }

  /**
   * Normalizes a proposal id into the Squads transaction index it refers to.
   *
   * @protected
   * @param {number | bigint | string} proposalId - The proposal (transaction index) id.
   * @returns {bigint} The transaction index.
   * @throws {ValueError} The id must be an integer between 0 and `MAX.proposalIndex`.
   */
  _toProposalIndex (proposalId) {
    const invalid = new ValueError(
      `Invalid proposal id ${String(proposalId)}. It must be an integer between 0 and ${MAX.proposalIndex}.`
    )

    // `BigInt()` reads far more than the accepted `number | bigint | string`: '' and [] are 0,
    // true is 1, and '0x1f' is 31. The shape is checked first so only those three types pass.
    if (typeof proposalId === 'string' && !/^\d+$/.test(proposalId)) {
      throw invalid
    }

    if (typeof proposalId !== 'string' && typeof proposalId !== 'number' && typeof proposalId !== 'bigint') {
      throw invalid
    }

    let index = null

    try {
      index = BigInt(proposalId)
    } catch {}

    if (index === null || index < 0n || index > MAX.proposalIndex) {
      throw invalid
    }

    return index
  }

  /**
   * Derives the address of the transaction account stored at the given index.
   *
   * @protected
   * @param {string} multisigPda - The multisig address the transaction belongs to.
   * @param {bigint} index - The transaction index.
   * @returns {Address} The transaction address.
   */
  _getTransactionPda (multisigPda, index) {
    const [transactionPda] = getProgramDerivedAddressSync({
      programAddress: this._programId,
      seeds: this._getTransactionSeeds(multisigPda, index)
    })

    return transactionPda
  }

  /**
   * Derives the address of the proposal account that votes on the transaction at the given
   * index.
   *
   * @protected
   * @param {string} multisigPda - The multisig address the proposal belongs to.
   * @param {bigint} index - The transaction index the proposal votes on.
   * @returns {Address} The proposal address.
   */
  _getProposalPda (multisigPda, index) {
    const [proposalPda] = getProgramDerivedAddressSync({
      programAddress: this._programId,
      seeds: [...this._getTransactionSeeds(multisigPda, index), SEED.proposal]
    })

    return proposalPda
  }

  /**
   * Derives the ephemeral signer addresses a stored transaction's message expects.
   *
   * @protected
   * @param {string} transactionPda - The transaction address the signers are derived from.
   * @param {number} count - How many the message needs.
   * @returns {Address[]} The ephemeral signer addresses, in index order.
   */
  _getEphemeralSignerPdas (transactionPda, count) {
    const encoder = getAddressEncoder()

    return Array.from({ length: count }, (_unused, index) => {
      const [pda] = getProgramDerivedAddressSync({
        programAddress: this._programId,
        seeds: [
          SEED.prefix,
          encoder.encode(address(transactionPda)),
          SEED.ephemeralSigner,
          Uint8Array.of(index)
        ]
      })

      return pda
    })
  }

  /**
   * Derives a spending limit's address from the create key its action carries.
   *
   * @protected
   * @param {string} multisigPda - The multisig address.
   * @param {string} createKey - The action's `createKey`.
   * @returns {Address} The spending limit address.
   */
  _getSpendingLimitPda (multisigPda, createKey) {
    const [spendingLimitPda] = getProgramDerivedAddressSync({
      programAddress: this._programId,
      seeds: [
        SEED.prefix,
        getAddressEncoder().encode(address(multisigPda)),
        SEED.spendingLimit,
        getAddressEncoder().encode(address(createKey))
      ]
    })

    return spendingLimitPda
  }

  /** @private */
  _hasDiscriminator (data, discriminator) {
    if (data.length < discriminator.length) {
      return false
    }

    return discriminator.every((byte, i) => byte === data[i])
  }

  /** @private */
  async _withConfig (config) {
    if (!config) {
      return this
    }

    let identity = {}

    if (!config.multisigPdaOrCreateKey) {
      identity = {
        multisigPdaOrCreateKey: this._config.multisigPdaOrCreateKey ?? await this.getAddress()
      }
    }

    const account = new WalletAccountReadOnlyMultisigSquads({
      ...this._config,
      ...identity,
      ...config
    })

    return account
  }

  /** @private */
  _getVaultPda (multisigPda, vaultIndex) {
    const [vaultPda] = getProgramDerivedAddressSync({
      programAddress: this._programId,
      seeds: [
        SEED.prefix,
        getAddressEncoder().encode(address(multisigPda)),
        SEED.vault,
        Uint8Array.of(vaultIndex)
      ]
    })

    return vaultPda
  }

  /** @private */
  _getTransactionSeeds (multisigPda, index) {
    return [
      SEED.prefix,
      getAddressEncoder().encode(address(multisigPda)),
      SEED.transaction,
      getU64Encoder().encode(index)
    ]
  }

  /** @private */
  _decodeMultisigAccount (multisigPda, account) {
    if (!account) {
      return {
        address: multisigPda,
        isCreated: false,
        configAuthority: null,
        threshold: 0,
        timeLock: 0,
        transactionIndex: 0n,
        staleTransactionIndex: 0n,
        rentCollector: null,
        members: []
      }
    }

    const data = getBase64Encoder().encode(account.data[0])

    if (
      account.owner !== this._programId ||
      !this._hasDiscriminator(data, ACCOUNT_DISCRIMINATOR.multisig)
    ) {
      throw new ValueError(`The account ${multisigPda} is not a Squads multisig.`)
    }

    const {
      configAuthority,
      threshold,
      timeLock,
      transactionIndex,
      staleTransactionIndex,
      rentCollector,
      members
    } = ACCOUNT.multisig.decode(data)

    return {
      address: multisigPda,
      isCreated: true,
      // Squads writes the default address rather than an option when the multisig governs itself.
      configAuthority: configAuthority === DEFAULT.authority ? null : configAuthority,
      threshold,
      timeLock,
      transactionIndex,
      staleTransactionIndex,
      rentCollector,
      members
    }
  }

  /** @private */
  _decodeProposalAccount (proposalPda, account) {
    const absent = {
      address: proposalPda,
      exists: false,
      status: -1,
      statusName: null,
      statusPhrase: null,
      statusTimestamp: null,
      approved: [],
      rejected: [],
      cancelled: []
    }

    if (!account) {
      return absent
    }

    const data = getBase64Encoder().encode(account.data[0])

    if (
      account.owner !== this._programId ||
      !this._hasDiscriminator(data, ACCOUNT_DISCRIMINATOR.proposal)
    ) {
      return absent
    }

    const {
      status: { status, timestamp },
      approved,
      rejected,
      cancelled
    } = ACCOUNT.proposal.decode(data)

    return {
      address: proposalPda,
      exists: true,
      status,
      statusName: PROPOSAL_STATUS_LABELS[status]?.name ?? `Unknown(${status})`,
      statusPhrase: PROPOSAL_STATUS_LABELS[status]?.phrase ?? `in an unknown status (${status})`,
      statusTimestamp: timestamp,
      approved,
      rejected,
      cancelled
    }
  }

  /** @private */
  _decodeTransactionAccount (transactionPda, account) {
    const absent = {
      address: transactionPda,
      exists: false,
      kind: null,
      vaultIndex: 0,
      ephemeralSignerCount: 0,
      message: null,
      actions: []
    }

    if (!account || account.owner !== this._programId) {
      return absent
    }

    const data = getBase64Encoder().encode(account.data[0])

    if (this._hasDiscriminator(data, ACCOUNT_DISCRIMINATOR.vaultTransaction)) {
      const { vaultIndex, ephemeralSignerBumps, message } = ACCOUNT.vaultTransaction.decode(data)

      return {
        ...absent,
        exists: true,
        kind: TRANSACTION_KIND.vault,
        vaultIndex,
        ephemeralSignerCount: ephemeralSignerBumps.length,
        message: {
          numSigners: message.numSigners,
          numWritableSigners: message.numWritableSigners,
          numWritableNonSigners: message.numWritableNonSigners,
          accountKeys: message.accountKeys,
          addressTableLookups: message.addressTableLookups
        }
      }
    }

    if (this._hasDiscriminator(data, ACCOUNT_DISCRIMINATOR.configTransaction)) {
      return {
        ...absent,
        exists: true,
        kind: TRANSACTION_KIND.config,
        actions: ACCOUNT.configTransaction.decode(data).actions.map((action) => ({
          kind: action.__kind,
          // The only two actions whose spending limit the executor has to pass through.
          createKey: action.__kind === 'AddSpendingLimit' ? action.createKey : null,
          spendingLimit: action.__kind === 'RemoveSpendingLimit' ? action.spendingLimit : null
        }))
      }
    }

    if (this._hasDiscriminator(data, ACCOUNT_DISCRIMINATOR.batch)) {
      return { ...absent, exists: true, kind: TRANSACTION_KIND.batch }
    }

    return { ...absent, exists: true }
  }
}
