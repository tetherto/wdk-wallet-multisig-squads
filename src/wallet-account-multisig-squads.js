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

import { MaximumFeeExceededError, NoSuchElementError, NotImplementedError, ProviderRequiredError, UnsupportedOperationError, ValueError } from '@tetherto/wdk-wallet'

import { AccountNotOwnerError, ThresholdNotMetError } from '@tetherto/wdk-wallet/multisig'

import { WalletAccountSolana } from '@tetherto/wdk-wallet-solana'

import WalletAccountReadOnlyMultisigSquads, {
  PROPOSAL_DATA_MASK,
  SECRET_SIZE,
  SIGNATURE_BASE_FEE,
  TRANSACTION_KIND
} from './wallet-account-read-only-multisig-squads.js'
import { address, getAddressEncoder } from '@solana/addresses'
import { getBase58Decoder, getBase64Decoder, getBase64Encoder } from '@solana/codecs'
import { AccountRole } from '@solana/instructions'
import { SYSTEM_PROGRAM_ADDRESS, getAdvanceNonceAccountDiscriminatorBytes } from '@solana-program/system'
import { ADDRESS_LOOKUP_TABLE_PROGRAM_ADDRESS } from '@solana-program/address-lookup-table'
import { COMPUTE_BUDGET_PROGRAM_ADDRESS } from '@solana-program/compute-budget'
import { MEMO_PROGRAM_ADDRESS } from '@solana-program/memo'
import { createKeyPairFromPrivateKeyBytes } from '@solana/keys'
import { createKeyPairSignerFromBytes, createKeyPairSignerFromPrivateKeyBytes } from '@solana/signers'
import { getCompiledTransactionMessageDecoder } from '@solana/transaction-messages'
import { getBase64EncodedWireTransaction, isFullySignedTransaction, partiallySignTransaction } from '@solana/transactions'

import {
  ACCOUNT,
  CONFIG_ACTION,
  CONFIG_ACTIONS_ENCODER,
  INSTRUCTION,
  INSTRUCTION_DISCRIMINATOR,
  PROPOSAL_STATUS
} from './helpers/layouts.js'

import { getProgramDerivedAddressSync } from './helpers/program-derived-address.js'

/** @typedef {import('./coordinators/index.js').IMultisigCoordinator} IMultisigCoordinator */

/** @typedef {import('@tetherto/wdk-wallet/multisig').IWalletAccountMultisig} IWalletAccountMultisig */
/** @typedef {import('@tetherto/wdk-wallet/multisig').IMultisigOwnerManagement} IMultisigOwnerManagement */
/** @typedef {import('@tetherto/wdk-wallet/multisig').MultisigInteractionResult} MultisigInteractionResult */
/** @typedef {import('@tetherto/wdk-wallet/multisig').MultisigProposal} MultisigProposal */
/**
 * `MultisigProposal` widened with `transaction` from `MultisigInteractionResult`, and with the
 * approvals a coordinator holds. `transaction` is undefined when an approval only circulates
 * through a coordinator. When the call broadcasts, it carries the execution when `status` is
 * `'executed'`, and the call's own submission when it is `'pending'`. `confirmations` counts what
 * the chain holds or is being sent, and `pendingConfirmations` what a coordinator has gathered
 * but not sent, which is 0 for every call that broadcasts.
 *
 * @typedef {MultisigProposal & MultisigInteractionResult & { pendingConfirmations: number }} MultisigSquadsProposalResult
 */
/** @typedef {import('@tetherto/wdk-wallet/multisig').MultisigTransactionOptions} MultisigTransactionOptions */
/**
 * `MultisigTransactionOptions` widened with the vault the proposal spends from and the note the
 * call records. `vaultIndex` is an index between 0 and 255, which the stored transaction carries
 * so the program signs with the same vault the message was compiled against, defaulting to the
 * main vault, 0. `memo` is an optional note recorded on chain with the instruction, where an empty
 * string is a present-but-empty memo rather than none.
 *
 * @typedef {MultisigTransactionOptions & { vaultIndex?: number, memo?: string }} MultisigSquadsTransactionOptions
 */
/** @typedef {import('@tetherto/wdk-wallet/multisig').MultisigOptions} MultisigOptions */
/**
 * `MultisigOptions` widened with the Squads permission mask to grant the member being added: a
 * bitwise OR of `PERMISSION.initiate`, `PERMISSION.vote` and `PERMISSION.execute`. Both fields
 * are optional; the threshold and the mask each keep their default when omitted.
 *
 * @typedef {Partial<MultisigOptions> & { mask?: number }} MultisigSquadsAddOwnerOptions
 */
/** @typedef {import('@tetherto/wdk-wallet').TransactionResult} TransactionResult */
/** @typedef {import('@tetherto/wdk-wallet').TransferOptions} TransferOptions */
/** @typedef {import('@tetherto/wdk-wallet').KeyPair} KeyPair */
/** @typedef {import('@solana/signers').KeyPairSigner} KeyPairSigner */

/** @typedef {import('@tetherto/wdk-wallet-solana').SolanaTransaction} SolanaTransaction */

/** @typedef {import('./wallet-account-read-only-multisig-squads.js').MultisigSquadsWalletConfig} MultisigSquadsWalletConfig */

/**
 * The Squads member permissions, as the bits of a member's mask.
 *
 * @type {{ initiate: 1, vote: 2, execute: 4 }}
 */
export const PERMISSION = { initiate: 1, vote: 2, execute: 4 }

const ALMIGHTY_PERMISSIONS = PERMISSION.initiate | PERMISSION.vote | PERMISSION.execute

const SEED = { prefix: 'multisig', multisig: 'multisig' }

const DEFAULT = { threshold: 1, timeLock: 0, vaultIndex: 0 }

const NO_EPHEMERAL_SIGNERS = 0
const ONE_APPROVAL = 1
const NO_MEMO = null

const BUNDLE_INSTRUCTION = [
  { discriminator: INSTRUCTION_DISCRIMINATOR.proposalApprove, proposal: 2, approver: 1 },
  { discriminator: INSTRUCTION_DISCRIMINATOR.vaultTransactionExecute, proposal: 1 },
  { discriminator: INSTRUCTION_DISCRIMINATOR.configTransactionExecute, proposal: 2 }
]

/**
 * Solana Squads multisig wallet account implementation.
 *
 * @implements {IWalletAccountMultisig}
 * @implements {IMultisigOwnerManagement}
 */
export default class WalletAccountMultisigSquads extends WalletAccountReadOnlyMultisigSquads {
  /**
   * Creates a new Solana Squads multisig wallet account.
   *
   * @param {string | Uint8Array} seed - A [BIP-39](https://github.com/bitcoin/bips/blob/master/bip-0039.mediawiki) mnemonic seed phrase, or a raw BIP-32 master seed (16-64 bytes).
   * @param {string} path - The SLIP-0010 derivation path (e.g. "0'/0'").
   * @param {MultisigSquadsWalletConfig} config - The configuration object.
   */
  constructor (seed, path, config) {
    const signerAccount = new WalletAccountSolana(seed, path, config)

    super(config)

    /**
     * The underlying Solana signer account.
     *
     * @protected
     * @type {WalletAccountSolana}
     */
    this._signerAccount = signerAccount

    /**
     * The coordinator the approvals are circulated through, undefined when the configuration names
     * none.
     *
     * @protected
     * @type {IMultisigCoordinator | undefined}
     */
    this._coordinator = config.coordinator?.({ signerAddress: signerAccount._address })
  }

  /**
   * Builds the signer a multisig is created with, from the secret its create key derives from.
   *
   * @param {string | Uint8Array} createKeySecret - The create key's secret. Base58 or raw bytes, either a 32-byte private key or a 64-byte keypair.
   * @returns {Promise<KeyPairSigner>} The create key signer.
   */
  static async getCreateKeySigner (createKeySecret) {
    const bytes = this.toCreateKeySecretBytes(createKeySecret)

    return bytes.length === SECRET_SIZE.privateKey
      ? createKeyPairSignerFromPrivateKeyBytes(bytes)
      : createKeyPairSignerFromBytes(bytes)
  }

  /**
   * The derivation path's index of this account.
   *
   * @type {number}
   */
  get index () {
    return this._signerAccount.index
  }

  /**
   * The derivation path of this account (see [SLIP-0010](https://slips.readthedocs.io/en/latest/slip-0010/)).
   *
   * @type {string}
   */
  get path () {
    return this._signerAccount.path
  }

  /**
   * The key pair of the signer account.
   *
   * @type {KeyPair}
   */
  get keyPair () {
    return this._signerAccount.keyPair
  }

  /**
   * Returns the address of the member this account votes and proposes as.
   *
   * @returns {Promise<string>} The signer's address.
   */
  async getSignerAddress () {
    return this._signerAccount.getAddress()
  }

  /**
   * Signs a message with the signer account.
   *
   * @param {string} message - The message to sign.
   * @returns {Promise<string>} The signature.
   */
  async sign (message) {
    return this._signerAccount.sign(message)
  }

  /**
   * Signs a transaction with the signer account. Not supported by Squads.
   *
   * @param {SolanaTransaction} tx - The transaction to sign.
   * @returns {Promise<SolanaTransaction>} The signed transaction.
   * @throws {UnsupportedOperationError} A multisig is a program-derived address and cannot sign.
   */
  async signTransaction (tx) {
    throw new UnsupportedOperationError('signTransaction(tx)')
  }

  /**
   * Sends a transaction from the multisig. Not supported by Squads.
   *
   * @param {SolanaTransaction} tx - The transaction to send.
   * @returns {Promise<TransactionResult>} The transaction's result.
   * @throws {UnsupportedOperationError} A multisig proposes transactions rather than submitting them.
   */
  async sendTransaction (tx) {
    throw new UnsupportedOperationError('sendTransaction(tx)')
  }

  /**
   * Creates the multisig account on-chain, deriving its address from the configured
   * `createKeySecret`.
   *
   * @param {string[]} [owners] - The member addresses. Defaults to this account's signer.
   * @param {number} [threshold] - The approvals a proposal needs (default: 1).
   * @returns {Promise<Pick<TransactionResult, 'hash'>>} The creation transaction's signature.
   * @throws {ValueError} The configured multisig must derive from `createKeySecret`, the owners must be non-empty and unique, and the multisig must not exist yet.
   * @throws {MaximumFeeExceededError} The quote must stay within `createMaxFee`.
   */
  async deploy (owners, threshold = DEFAULT.threshold) {
    const createKeySigner = await WalletAccountMultisigSquads.getCreateKeySigner(
      this._config.createKeySecret
    )
    const [expectedPda] = getProgramDerivedAddressSync({
      programAddress: this._programId,
      seeds: [SEED.prefix, SEED.multisig, getAddressEncoder().encode(createKeySigner.address)]
    })

    if (this._address && this._address !== expectedPda) {
      throw new ValueError(
        `The configured multisig ${this._address} does not derive from the configured createKeySecret (${expectedPda}).`
      )
    }

    const signerAddress = await this.getSignerAddress()
    const members = owners ?? [signerAddress]

    if (!Array.isArray(members) || !members.length) {
      throw new ValueError('At least one owner is required to create a multisig.')
    }

    this._validateMemberCount(members.length)

    if (new Set(members).size !== members.length) {
      throw new ValueError('The owners of a multisig must be unique.')
    }

    for (const member of members) {
      address(member)
    }

    this._validateThreshold(threshold, members.length)

    if (await this.isDeployed()) {
      throw new ValueError(`The multisig account ${expectedPda} already exists.`)
    }

    const [{ programConfigPda, treasury, creationFee }, rent] = await Promise.all([
      this._getProgramConfig(),
      this._rpc
        .getMinimumBalanceForRentExemption(BigInt(this._multisigAccountSize(members.length)))
        .send()
    ])

    const fee = this._quoteDeployFrom(creationFee, rent)
    const { createMaxFee } = this._config

    if (createMaxFee !== undefined && fee > BigInt(createMaxFee)) {
      throw new MaximumFeeExceededError('Exceeded maximum fee cost for the deploy operation.')
    }

    const instruction = {
      programAddress: this._programId,
      accounts: [
        { address: address(programConfigPda), role: AccountRole.READONLY },
        { address: address(treasury), role: AccountRole.WRITABLE },
        { address: address(expectedPda), role: AccountRole.WRITABLE },
        {
          address: createKeySigner.address,
          role: AccountRole.READONLY_SIGNER,
          signer: createKeySigner
        },
        this._getRentPayerAccount(signerAddress),
        { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY }
      ],
      data: INSTRUCTION.multisigCreateV2.encode({
        configAuthority: null,
        threshold,
        members: members.map((member) => ({
          address: address(member),
          mask: ALMIGHTY_PERMISSIONS
        })),
        timeLock: DEFAULT.timeLock,
        rentCollector: null,
        memo: NO_MEMO
      })
    }

    const { hash } = await this._signerAccount.sendTransaction({ instructions: [instruction] })

    return { hash }
  }

  /**
   * Proposes a transaction to the multisig, open for voting. `tx` is either `{ to, value }` for a
   * SOL transfer or a message carrying `instructions`, which the vault executes as they stand.
   *
   * @param {SolanaTransaction} tx - The transaction to propose.
   * @param {MultisigSquadsTransactionOptions} [transactionOptions] - The multisig transaction's options. `vaultIndex` names the vault to spend from (default: 0). `autoExecute` executes the proposal in the same transaction only when it can: threshold 1, no time lock, and a signer holding both vote and execute. Where it cannot, it goes inert and the result's `status` stays `'pending'` rather than throwing. `memo` is recorded on chain with the creation.
   * @returns {Promise<MultisigSquadsProposalResult>} The proposal result. `transaction.fee` is the network fee plus the rent the transaction and proposal accounts lock up, the same basis the quotes use.
   */
  async propose (tx, { vaultIndex = DEFAULT.vaultIndex, ...transactionOptions } = {}) {
    const vaultPda = address(await this.getVaultAddress(vaultIndex))
    const compiled = this._compileTransactionMessage(
      vaultPda,
      this._toProposedInstructions(vaultPda, tx)
    )

    return this._proposeVaultTransaction(compiled, { vaultIndex, ...transactionOptions })
  }

  /**
   * Proposes an SPL token transfer to the multisig.
   *
   * @param {TransferOptions} transferOptions - The transfer options.
   * @param {MultisigSquadsTransactionOptions} [transactionOptions] - The multisig transaction's options. `vaultIndex` names the vault to spend from (default: 0). `autoExecute` executes the proposal in the same transaction only when it can: threshold 1, no time lock, and a signer holding both vote and execute. Where it cannot, it goes inert and the result's `status` stays `'pending'` rather than throwing. `memo` is recorded on chain with the creation.
   * @returns {Promise<MultisigSquadsProposalResult>} The transfer proposal result. `transaction.fee` is the network fee plus the rent the transaction and proposal accounts lock up, the same basis the quotes use.
   * @throws {ProviderRequiredError} The wallet must be connected to a provider.
   * @throws {MaximumFeeExceededError} The quote must stay within `transferMaxFee`.
   * @todo Support Token-2022 (Token Extensions Program), whose associated token accounts this method does not derive.
   */
  async proposeTransfer (transferOptions, { vaultIndex = DEFAULT.vaultIndex, ...transactionOptions } = {}) {
    if (!this._rpc) {
      throw new ProviderRequiredError('The wallet must be connected to a provider to propose transfers.')
    }

    const vaultPda = address(await this.getVaultAddress(vaultIndex))
    const instructions = await this._toTransferInstructions(vaultPda, transferOptions)
    const multisig = await this._getMultisigAccount()
    const compiled = this._compileTransactionMessage(vaultPda, instructions)
    const { rent, fee } = await this._quoteProposal(
      this._vaultTransactionSize(compiled.storedSize),
      multisig.members.length
    )
    const { transferMaxFee } = this._config

    if (transferMaxFee !== undefined && fee > BigInt(transferMaxFee)) {
      throw new MaximumFeeExceededError('Exceeded maximum fee cost for the transfer operation.')
    }

    return this._proposeVaultTransaction(compiled, { vaultIndex, ...transactionOptions, multisig, rent })
  }

  /**
   * Approves a pending transaction proposal.
   *
   * @param {number | bigint | string} proposalId - The proposal (transaction index) id.
   * @param {MultisigSquadsTransactionOptions} [transactionOptions] - The multisig transaction's options. `memo` is the note recorded on chain with the vote. `autoExecute` executes the proposal in the same transaction only when it can: this approval reaching the threshold, no time lock, and a signer holding execute on top of the vote. Where it does not apply, it goes inert and the result's `status` stays `'pending'` rather than throwing. `vaultIndex` does not bear on a vote. None of the three applies to a coordinator's bundle, which has decided them already.
   * @returns {Promise<MultisigSquadsProposalResult>} The approval result. `status` is `'executed'` when the execution ran in the same transaction, in which case `transaction` is that execution rather than a bare submission. Through a coordinator, `fee` is what the bundle's own fee payer is charged. A vote that only circulated adds nothing to `confirmations`, which the chain still governs; it counts in `pendingConfirmations`, with the other approvals the bundle has collected a signature for, and reports `transaction: undefined`.
   * @throws {ValueError} The signer must not have approved the proposal already, and a coordinator's bundle must carry this signer's approval and no member's twice.
   * @throws {MaximumFeeExceededError} A coordinator's bundle must quote within `approveMaxFee`.
   */
  async approveProposal (proposalId, { memo, autoExecute } = {}) {
    const index = this._toProposalIndex(proposalId)
    const { multisig, proposal, transaction } = await this._getProposal(
      index,
      autoExecute
        ? PROPOSAL_DATA_MASK.all
        : PROPOSAL_DATA_MASK.multisig | PROPOSAL_DATA_MASK.proposal
    )
    const signerAddress = await this._requireVotableProposal(multisig, proposal, index)

    if (proposal.approved.includes(signerAddress)) {
      throw new ValueError(`The signer ${signerAddress} has already approved the proposal ${index}.`)
    }

    const bundle = await this._coordinator?.getProposal(index.toString())

    if (bundle) {
      const { approvers, executes } =
        await this._decodeBundle(bundle, multisig.address, proposal.address)
      const twice = approvers.find((member, at) => approvers.indexOf(member) !== at)

      if (twice) {
        throw new ValueError(
          `The bundle the coordinator holds for the proposal ${index} carries more than one approval by the member ${twice}, which Squads rejects, so it can never land.`
        )
      }

      if (!approvers.includes(signerAddress)) {
        throw new ValueError(
          `The bundle the coordinator holds for the proposal ${index} does not carry an approval by the signer ${signerAddress}.`
        )
      }

      const { approveMaxFee } = this._config
      const quoted = approveMaxFee === undefined ? null : await this._quoteMessage(bundle)

      if (quoted !== null && quoted > BigInt(approveMaxFee)) {
        throw new MaximumFeeExceededError('Exceeded maximum fee cost for the approve operation.')
      }

      const signed = await partiallySignTransaction(
        [await createKeyPairFromPrivateKeyBytes(this._signerAccount.keyPair.privateKey)], bundle
      )
      const complete = isFullySignedTransaction(signed)

      await this._coordinator.confirmProposal(
        index.toString(), getBase58Decoder().decode(signed.signatures[signerAddress])
      )

      const transactionResult = complete
        ? await this._sendSignedTransaction(signed, quoted ?? await this._quoteMessage(signed))
        : undefined
      const gathered = approvers.filter((member) => signed.signatures[member])

      return {
        proposalId: index.toString(),
        confirmations: complete
          ? new Set([...proposal.approved, ...approvers]).size
          : proposal.approved.length,
        pendingConfirmations: complete ? 0 : gathered.length,
        threshold: multisig.threshold,
        status: complete && executes ? 'executed' : 'pending',
        transaction: transactionResult
      }
    }

    const confirmations = proposal.approved.length + 1
    const instructions = [
      this._buildProposalVoteInstruction(
        INSTRUCTION.proposalApprove,
        multisig.address,
        signerAddress,
        proposal.address,
        memo
      )
    ]
    const execution = autoExecute
      ? await this._buildVoteExecuteInstruction(
        multisig, proposal, transaction, signerAddress, index, confirmations
      )
      : null

    if (execution) {
      instructions.push(execution)
    }

    const { hash, fee } = await this._signerAccount.sendTransaction({ instructions })

    return {
      proposalId: index.toString(),
      confirmations,
      pendingConfirmations: 0,
      threshold: multisig.threshold,
      status: execution ? 'executed' : 'pending',
      transaction: { hash, fee }
    }
  }

  /** @private */
  async _decodeBundle (bundle, multisigAddress, proposalAddress) {
    const { instructions, staticAccounts, addressTableLookups } =
      getCompiledTransactionMessageDecoder().decode(bundle.messageBytes)
    const lookups = addressTableLookups ?? []
    const accounts = [...staticAccounts]

    if (lookups.length) {
      const tables = await this._getLookupTableAddresses(
        lookups.map(({ lookupTableAddress }) => ({ accountKey: lookupTableAddress }))
      )
      const borrowed = (indexesOf) => lookups.flatMap((lookup) => {
        const addresses = tables.get(lookup.lookupTableAddress)

        return indexesOf(lookup).map((i) => {
          if (!addresses[i]) {
            throw new NoSuchElementError(
              `The address lookup table ${lookup.lookupTableAddress} holds no address at index ${i}, so the transaction's accounts cannot be resolved.`
            )
          }

          return addresses[i]
        })
      })

      const writable = borrowed((lookup) => lookup.writableIndexes)
      const readonly = borrowed((lookup) => lookup.readonlyIndexes)

      accounts.push(...writable, ...readonly)
    }

    const named = (instruction, slot) => accounts[instruction.accountIndices?.[slot]]
    const approvers = []
    let executes = false

    for (const instruction of instructions) {
      const program = accounts[instruction.programAddressIndex]

      if (program !== this._programId) {
        if (
          program === COMPUTE_BUDGET_PROGRAM_ADDRESS ||
          program === MEMO_PROGRAM_ADDRESS ||
          (program === SYSTEM_PROGRAM_ADDRESS && this._leads(instruction, getAdvanceNonceAccountDiscriminatorBytes()))
        ) {
          continue
        }

        throw new ValueError(
          `The bundle the coordinator holds for the proposal ${proposalAddress} carries an instruction for the program ${program}, and a member signs every instruction in it. Only Squads votes on that proposal ride along, beside a compute budget, a memo and a nonce advance.`
        )
      }

      const kind = BUNDLE_INSTRUCTION.find(({ discriminator }) => this._leads(instruction, discriminator))

      if (!kind || named(instruction, 0) !== multisigAddress || named(instruction, kind.proposal) !== proposalAddress) {
        throw new ValueError(
          `The bundle the coordinator holds for the proposal ${proposalAddress} carries a Squads instruction that neither approves nor executes it on the multisig ${multisigAddress}, and a member signs every instruction in it.`
        )
      }

      if (kind.approver === undefined) {
        executes = true
      } else {
        approvers.push(named(instruction, kind.approver))
      }
    }

    return { approvers, executes }
  }

  /** @private */
  _leads (instruction, discriminator) {
    return instruction.data?.length >= discriminator.length &&
      discriminator.every((byte, offset) => instruction.data[offset] === byte)
  }

  /** @private */
  async _quoteMessage (transaction) {
    const { value } = await this._rpc
      .getFeeForMessage(getBase64Decoder().decode(transaction.messageBytes), {
        commitment: this._commitment
      })
      .send()

    return value ?? SIGNATURE_BASE_FEE * BigInt(Object.keys(transaction.signatures).length)
  }

  /** @private */
  async _sendSignedTransaction (signed, fee) {
    const hash = await this._rpc
      .sendTransaction(getBase64EncodedWireTransaction(signed), { encoding: 'base64' })
      .send()

    return { hash, fee }
  }

  /**
   * Rejects a pending transaction proposal.
   *
   * @param {number | bigint | string} proposalId - The proposal (transaction index) id.
   * @param {MultisigSquadsTransactionOptions} [transactionOptions] - The multisig transaction's options. Only `memo` bears on a rejection, as the note recorded on chain with it: a rejected proposal executes nothing, so `autoExecute` is inert here. A rejection is the member's own transaction and never reaches a coordinator.
   * @returns {Promise<MultisigSquadsProposalResult>} The rejection result.
   * @throws {ValueError} The signer must not have rejected the proposal already.
   */
  async rejectProposal (proposalId, { memo } = {}) {
    const index = this._toProposalIndex(proposalId)
    const { multisig, proposal } = await this._getProposal(
      index,
      PROPOSAL_DATA_MASK.multisig | PROPOSAL_DATA_MASK.proposal
    )
    const signerAddress = await this._requireVotableProposal(multisig, proposal, index)

    if (proposal.rejected.includes(signerAddress)) {
      throw new ValueError(`The signer ${signerAddress} has already rejected the proposal ${index}.`)
    }

    const instruction = this._buildProposalVoteInstruction(
      INSTRUCTION.proposalReject,
      multisig.address,
      signerAddress,
      proposal.address,
      memo
    )

    const { hash, fee } = await this._signerAccount.sendTransaction({
      instructions: [instruction]
    })

    return {
      proposalId: index.toString(),
      confirmations: proposal.approved.length - (proposal.approved.includes(signerAddress) ? 1 : 0),
      pendingConfirmations: 0,
      threshold: multisig.threshold,
      status: 'pending',
      transaction: { hash, fee }
    }
  }

  /**
   * Submits an approved proposal for on-chain execution.
   *
   * @param {number | bigint | string} proposalId - The proposal (transaction index) id.
   * @returns {Promise<TransactionResult>} The execution transaction's result.
   * @throws {NoSuchElementError} The multisig and a proposal at that id must exist.
   * @throws {ThresholdNotMetError} The proposal must have reached the approval threshold.
   * @throws {ValueError} The proposal must be approved rather than in another status, its time lock must have elapsed, and its transaction account must still be open.
   */
  async executeProposal (proposalId) {
    const index = this._toProposalIndex(proposalId)
    const { multisig, proposal, transaction, now } = await this._getProposal(index)

    if (!multisig.isCreated) {
      throw new NoSuchElementError(
        `The multisig account ${multisig.address} does not exist. Deploy it before executing proposals.`
      )
    }

    const signerAddress = await this.getSignerAddress()

    this._requirePermission(multisig, signerAddress, PERMISSION.execute)

    if (!proposal.exists) {
      throw new NoSuchElementError(
        `The multisig ${multisig.address} has no proposal at index ${index}.`
      )
    }

    if (proposal.status === PROPOSAL_STATUS.active) {
      throw new ThresholdNotMetError(
        `The proposal ${index} holds ${proposal.approved.length} of the ${multisig.threshold} approvals it needs to execute.`
      )
    }

    if (proposal.status !== PROPOSAL_STATUS.approved) {
      throw new ValueError(
        `The proposal ${index} is ${proposal.statusPhrase} rather than approved and ready to execute.`
      )
    }

    const remaining = BigInt(multisig.timeLock) - (now - proposal.statusTimestamp)

    if (remaining > 0n) {
      throw new ValueError(
        `The proposal ${index} is under a time lock for another ${remaining} seconds.`
      )
    }

    if (!transaction.exists) {
      throw new ValueError(
        `The transaction account ${transaction.address} behind proposal ${index} has been closed.`
      )
    }

    const instruction = transaction.kind === TRANSACTION_KIND.config
      ? await this._buildConfigExecuteInstruction(multisig, proposal, transaction, signerAddress, index)
      : await this._buildVaultExecuteInstruction(multisig, proposal, transaction, signerAddress)

    return this._signerAccount.sendTransaction({ instructions: [instruction] })
  }

  /**
   * Proposes adding a new member to the multisig.
   *
   * @param {string} ownerAddress - The address of the member to add.
   * @param {MultisigSquadsAddOwnerOptions} [options] - The operation options. `mask` is the member's Squads permissions (default: all three).
   * @returns {Promise<MultisigSquadsProposalResult>} The proposal result. `transaction.fee` is the network fee plus the rent the transaction and proposal accounts lock up, the same basis the quotes use.
   * @throws {ValueError} The permission mask must be valid, and the address must not already be a member.
   */
  async addOwner (ownerAddress, { mask = ALMIGHTY_PERMISSIONS, threshold } = {}) {
    const newOwner = address(ownerAddress)

    if (!Number.isInteger(mask) || mask < PERMISSION.initiate || mask > ALMIGHTY_PERMISSIONS) {
      throw new ValueError(
        `Invalid permission mask ${mask}. It must be an integer between ${PERMISSION.initiate} and ${ALMIGHTY_PERMISSIONS}, a bitwise OR of initiate (${PERMISSION.initiate}), vote (${PERMISSION.vote}) and execute (${PERMISSION.execute}).`
      )
    }

    const multisig = await this._getMultisigAccount()

    this._requireDeployed(multisig, 'proposing configuration changes')
    this._requireAutonomous(multisig)
    this._requirePermission(multisig, await this.getSignerAddress(), PERMISSION.initiate)

    if (multisig.members.some((member) => member.address === newOwner)) {
      throw new ValueError(
        `The address ${newOwner} is already a member of the multisig ${multisig.address}.`
      )
    }

    const resulting = [...multisig.members, { address: newOwner, mask }]

    this._requireViableMembers(resulting, threshold ?? multisig.threshold, multisig.address)

    const actions = [CONFIG_ACTION.addMember(newOwner, mask)]

    if (threshold !== undefined) {
      actions.push(CONFIG_ACTION.changeThreshold(threshold))
    }

    return this._proposeConfigTransaction(multisig, actions)
  }

  /**
   * Proposes removing a member from the multisig.
   *
   * @param {string} ownerAddress - The address of the member to remove.
   * @param {Partial<MultisigOptions>} [options] - The operation options.
   * @returns {Promise<MultisigSquadsProposalResult>} The proposal result. `transaction.fee` is the network fee plus the rent the transaction and proposal accounts lock up, the same basis the quotes use.
   * @throws {ValueError} The address must be a member of the multisig.
   */
  async removeOwner (ownerAddress, { threshold } = {}) {
    const owner = address(ownerAddress)
    const multisig = await this._getMultisigAccount()

    this._requireDeployed(multisig, 'proposing configuration changes')
    this._requireAutonomous(multisig)
    this._requirePermission(multisig, await this.getSignerAddress(), PERMISSION.initiate)

    if (!multisig.members.some((member) => member.address === owner)) {
      throw new ValueError(
        `The address ${owner} is not a member of the multisig ${multisig.address}.`
      )
    }

    const remaining = multisig.members.filter((member) => member.address !== owner)

    this._requireViableMembers(remaining, threshold ?? multisig.threshold, multisig.address)

    const actions = [CONFIG_ACTION.removeMember(owner)]

    if (threshold !== undefined) {
      actions.push(CONFIG_ACTION.changeThreshold(threshold))
    }

    return this._proposeConfigTransaction(multisig, actions)
  }

  /**
   * Proposes swapping one member for another, the new member inheriting the old one's
   * permissions.
   *
   * @param {string} oldOwnerAddress - The address of the member to replace.
   * @param {string} newOwnerAddress - The address of the new member.
   * @param {Partial<MultisigOptions>} [options] - The operation options.
   * @returns {Promise<MultisigSquadsProposalResult>} The proposal result. `transaction.fee` is the network fee plus the rent the transaction and proposal accounts lock up, the same basis the quotes use.
   * @throws {ValueError} The two addresses must differ, the old one must be a member, and the new one must not be.
   */
  async swapOwner (oldOwnerAddress, newOwnerAddress, { threshold } = {}) {
    const oldOwner = address(oldOwnerAddress)
    const newOwner = address(newOwnerAddress)

    if (oldOwner === newOwner) {
      throw new ValueError(`Cannot swap the member ${oldOwner} of the multisig for itself.`)
    }

    const multisig = await this._getMultisigAccount()

    this._requireDeployed(multisig, 'proposing configuration changes')
    this._requireAutonomous(multisig)
    this._requirePermission(multisig, await this.getSignerAddress(), PERMISSION.initiate)

    const replaced = multisig.members.find((member) => member.address === oldOwner)

    if (!replaced) {
      throw new ValueError(
        `The address ${oldOwner} is not a member of the multisig ${multisig.address}.`
      )
    }

    if (multisig.members.some((member) => member.address === newOwner)) {
      throw new ValueError(
        `The address ${newOwner} is already a member of the multisig ${multisig.address}.`
      )
    }

    const resulting = [
      ...multisig.members.filter((member) => member.address !== oldOwner),
      { address: newOwner, mask: replaced.mask }
    ]

    this._requireViableMembers(resulting, threshold ?? multisig.threshold, multisig.address)

    const actions = [
      CONFIG_ACTION.removeMember(oldOwner),
      CONFIG_ACTION.addMember(newOwner, replaced.mask)
    ]

    if (threshold !== undefined) {
      actions.push(CONFIG_ACTION.changeThreshold(threshold))
    }

    return this._proposeConfigTransaction(multisig, actions)
  }

  /**
   * Proposes changing the approval threshold of the multisig.
   *
   * @param {number} newThreshold - The new threshold.
   * @returns {Promise<MultisigSquadsProposalResult>} The proposal result. `transaction.fee` is the network fee plus the rent the transaction and proposal accounts lock up, the same basis the quotes use.
   * @throws {ValueError} The threshold must not already be in force.
   */
  async changeThreshold (newThreshold) {
    const multisig = await this._getMultisigAccount()

    this._requireDeployed(multisig, 'proposing configuration changes')
    this._requireAutonomous(multisig)
    this._requirePermission(multisig, await this.getSignerAddress(), PERMISSION.initiate)

    if (newThreshold === multisig.threshold) {
      throw new ValueError(
        `The multisig ${multisig.address} already requires ${newThreshold} approvals.`
      )
    }

    this._requireViableMembers(multisig.members, newThreshold, multisig.address)

    return this._proposeConfigTransaction(multisig, [
      CONFIG_ACTION.changeThreshold(newThreshold)
    ])
  }

  /**
   * Returns a read-only copy of the account. The multisig address is resolved first, since the
   * copy carries no `createKeySecret` to resolve it from.
   *
   * @returns {Promise<WalletAccountReadOnlyMultisigSquads>} The read-only account.
   */
  async toReadOnlyAccount () {
    const multisigPdaOrCreateKey = await this.getAddress()
    const { createKeySecret, ...config } = this._config

    return new WalletAccountReadOnlyMultisigSquads({
      ...config,
      multisigPdaOrCreateKey
    })
  }

  /**
   * Disposes the wallet account, erasing the private key from the memory.
   *
   * @returns {void} Nothing; the account cannot sign once disposed.
   */
  dispose () {
    this._signerAccount.dispose()
  }

  /** @private */
  async _proposeVaultTransaction (compiled, options) {
    const multisig = options.multisig ?? await this._getMultisigAccount()

    return this._proposeTransaction(
      multisig,
      INSTRUCTION.vaultTransactionCreate.encode({
        vaultIndex: options.vaultIndex,
        ephemeralSigners: NO_EPHEMERAL_SIGNERS,
        transactionMessage: compiled.bytes,
        memo: this._toMemo(options.memo)
      }),
      this._vaultTransactionSize(compiled.storedSize),
      {
        buildExtraInstructions: options.autoExecute
          ? (context) => this._buildAutoExecuteInstructions(multisig, compiled, options.vaultIndex, context)
          : null,
        rent: options.rent
      }
    )
  }

  /** @private */
  _getRentPayerAccount (signerAddress) {
    return {
      address: address(this._config.rentPayer ?? signerAddress),
      role: AccountRole.WRITABLE_SIGNER
    }
  }

  /** @private */
  async _proposeConfigTransaction (multisig, actions) {
    return this._proposeTransaction(
      multisig,
      INSTRUCTION.configTransactionCreate.encode({ actions, memo: NO_MEMO }),
      this._configTransactionSize(CONFIG_ACTIONS_ENCODER.getSizeFromValue(actions))
    )
  }

  /** @private */
  _requireDeployed (multisig, action) {
    if (!multisig.isCreated) {
      throw new NoSuchElementError(
        `The multisig account ${multisig.address} does not exist. Deploy it before ${action}.`
      )
    }
  }

  /** @private */
  async _proposeTransaction (multisig, data, transactionSize, options = {}) {
    const { address: multisigPda, threshold, transactionIndex, members } = multisig

    this._requireDeployed(multisig, 'proposing transactions')

    const signerAddress = await this.getSignerAddress()

    this._requirePermission({ address: multisigPda, members }, signerAddress, PERMISSION.initiate)

    const index = transactionIndex + 1n
    const transactionPda = this._getTransactionPda(multisigPda, index)
    const proposalPda = this._getProposalPda(multisigPda, index)

    const rentPayer = this._getRentPayerAccount(signerAddress)
    const creator = rentPayer.address === signerAddress
      ? rentPayer
      : { address: address(signerAddress), role: AccountRole.READONLY_SIGNER }
    const systemProgram = { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY }

    const instructions = [
      {
        programAddress: this._programId,
        accounts: [
          { address: address(multisigPda), role: AccountRole.WRITABLE },
          { address: transactionPda, role: AccountRole.WRITABLE },
          creator,
          rentPayer,
          systemProgram
        ],
        data
      },
      {
        programAddress: this._programId,
        accounts: [
          { address: address(multisigPda), role: AccountRole.READONLY },
          { address: proposalPda, role: AccountRole.WRITABLE },
          creator,
          rentPayer,
          systemProgram
        ],
        data: INSTRUCTION.proposalCreate.encode({ transactionIndex: index, draft: false })
      }
    ]

    const extra = options.buildExtraInstructions
      ? await options.buildExtraInstructions({ index, transactionPda, proposalPda, signerAddress })
      : []

    instructions.push(...extra)

    const rent = options.rent ?? await this._quoteProposalRent(transactionSize, members.length)
    const { hash, fee } = await this._signerAccount.sendTransaction({ instructions })
    const executed = extra.length > 0

    return {
      proposalId: index.toString(),
      confirmations: executed ? 1 : 0,
      pendingConfirmations: 0,
      threshold,
      status: executed ? 'executed' : 'pending',
      transaction: { hash, fee: fee + rent }
    }
  }

  /** @private */
  async _buildAutoExecuteInstructions (multisig, compiled, vaultIndex, context) {
    const { proposalPda, transactionPda, signerAddress } = context

    const votes = PERMISSION.vote | PERMISSION.execute

    if (!this._canAutoExecute(multisig, signerAddress, ONE_APPROVAL, votes)) {
      return []
    }

    const vaultPda = await this.getVaultAddress(vaultIndex)
    const transaction = {
      address: transactionPda,
      ephemeralSignerCount: NO_EPHEMERAL_SIGNERS,
      message: { ...compiled, addressTableLookups: [] }
    }

    return [
      this._buildProposalVoteInstruction(
        INSTRUCTION.proposalApprove, multisig.address, signerAddress, proposalPda
      ),
      {
        programAddress: this._programId,
        accounts: [
          { address: address(multisig.address), role: AccountRole.READONLY },
          { address: proposalPda, role: AccountRole.WRITABLE },
          { address: transactionPda, role: AccountRole.READONLY },
          { address: address(signerAddress), role: AccountRole.READONLY_SIGNER },
          ...await this._resolveExecutionAccounts(transaction, vaultPda)
        ],
        data: INSTRUCTION.vaultTransactionExecute.encode()
      }
    ]
  }

  /** @private */
  _requirePermission (multisig, signerAddress, mask) {
    const member = multisig.members.find((candidate) => candidate.address === signerAddress)

    if (!member) {
      throw new AccountNotOwnerError(
        `The signer ${signerAddress} is not a member of the multisig ${multisig.address}.`
      )
    }

    if (!(member.mask & mask)) {
      throw new AccountNotOwnerError(`The signer ${signerAddress} does not hold the permission.`)
    }

    return member
  }

  /** @private */
  async _requireVotableProposal (multisig, proposal, index) {
    if (!multisig.isCreated) {
      throw new NoSuchElementError(
        `The multisig account ${multisig.address} does not exist. Deploy it before voting on proposals.`
      )
    }

    const signerAddress = await this.getSignerAddress()

    this._requirePermission(multisig, signerAddress, PERMISSION.vote)

    if (!proposal.exists) {
      throw new NoSuchElementError(
        `The multisig ${multisig.address} has no proposal at index ${index}.`
      )
    }

    if (proposal.status !== PROPOSAL_STATUS.active) {
      throw new ValueError(
        `The proposal ${index} is ${proposal.statusPhrase} rather than open for voting.`
      )
    }

    if (index <= multisig.staleTransactionIndex) {
      throw new ValueError(
        `The proposal ${index} was invalidated by a later configuration change and can no longer be voted on.`
      )
    }

    return signerAddress
  }

  /** @private */
  _buildProposalVoteInstruction (vote, multisigPda, signerAddress, proposalPda, memo) {
    return {
      programAddress: this._programId,
      accounts: [
        { address: address(multisigPda), role: AccountRole.READONLY },
        { address: address(signerAddress), role: AccountRole.WRITABLE_SIGNER },
        { address: address(proposalPda), role: AccountRole.WRITABLE }
      ],
      data: vote.encode({ memo: this._toMemo(memo) })
    }
  }

  /** @private */
  _toMemo (memo) {
    if (memo === undefined || memo === null) {
      return NO_MEMO
    }

    if (typeof memo !== 'string') {
      throw new ValueError(`Invalid memo ${memo}. It must be a string.`)
    }

    return memo
  }

  /** @private */
  _canAutoExecute (multisig, signerAddress, confirmations, mask) {
    const signer = multisig.members.find((member) => member.address === signerAddress)

    return confirmations >= multisig.threshold && multisig.timeLock === 0 &&
      Boolean(signer && (signer.mask & mask) === mask)
  }

  /** @private */
  async _buildVoteExecuteInstruction (multisig, proposal, transaction, signerAddress, index, confirmations) {
    if (!this._canAutoExecute(multisig, signerAddress, confirmations, PERMISSION.execute)) {
      return null
    }

    if (transaction.kind === TRANSACTION_KIND.config) {
      return this._buildConfigExecuteInstruction(multisig, proposal, transaction, signerAddress, index)
    }

    if (transaction.kind === TRANSACTION_KIND.vault) {
      return this._buildVaultExecuteInstruction(multisig, proposal, transaction, signerAddress)
    }

    return null
  }

  /** @private */
  async _buildConfigExecuteInstruction (multisig, proposal, transaction, signerAddress, index) {
    if (index <= multisig.staleTransactionIndex) {
      throw new ValueError(
        `The config proposal ${index} was invalidated by a later configuration change and can no longer be executed.`
      )
    }

    const member = address(signerAddress)
    const spendingLimits = transaction.actions
      .filter((action) => action.createKey || action.spendingLimit)
      .map((action) => action.spendingLimit
        ? address(action.spendingLimit)
        : this._getSpendingLimitPda(multisig.address, action.createKey))

    return {
      programAddress: this._programId,
      accounts: [
        { address: address(multisig.address), role: AccountRole.WRITABLE },
        { address: member, role: AccountRole.READONLY_SIGNER },
        { address: address(proposal.address), role: AccountRole.WRITABLE },
        { address: address(transaction.address), role: AccountRole.READONLY },
        { address: member, role: AccountRole.WRITABLE_SIGNER },
        { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY },
        ...spendingLimits.map((spendingLimit) => ({ address: spendingLimit, role: AccountRole.WRITABLE }))
      ],
      data: INSTRUCTION.configTransactionExecute.encode()
    }
  }

  /** @private */
  async _buildVaultExecuteInstruction (multisig, proposal, transaction, signerAddress) {
    if (transaction.kind !== TRANSACTION_KIND.vault) {
      throw new NotImplementedError(
        `executeProposal(proposalId) for a ${transaction.kind ?? 'transaction of an unrecognized kind'}`
      )
    }

    const vaultPda = await this.getVaultAddress(transaction.vaultIndex)

    return {
      programAddress: this._programId,
      accounts: [
        { address: address(multisig.address), role: AccountRole.READONLY },
        { address: address(proposal.address), role: AccountRole.WRITABLE },
        { address: address(transaction.address), role: AccountRole.READONLY },
        { address: address(signerAddress), role: AccountRole.READONLY_SIGNER },
        ...await this._resolveExecutionAccounts(transaction, vaultPda)
      ],
      data: INSTRUCTION.vaultTransactionExecute.encode()
    }
  }

  /** @private */
  async _resolveExecutionAccounts (transaction, vaultPda) {
    const { message } = transaction
    const signedForByProgram = new Set([
      vaultPda,
      ...this._getEphemeralSignerPdas(transaction.address, transaction.ephemeralSignerCount)
    ])
    const lookups = message.addressTableLookups
    const accounts = lookups.map((lookup) => ({
      address: address(lookup.accountKey),
      role: AccountRole.READONLY
    }))

    message.accountKeys.forEach((key, i) => {
      const writable = i < message.numWritableSigners ||
        (i >= message.numSigners && i - message.numSigners < message.numWritableNonSigners)
      const signer = i < message.numSigners && !signedForByProgram.has(key)
      const role = signer
        ? (writable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER)
        : (writable ? AccountRole.WRITABLE : AccountRole.READONLY)

      accounts.push({ address: address(key), role })
    })

    if (!lookups.length) {
      return accounts
    }

    const tables = await this._getLookupTableAddresses(lookups)

    for (const lookup of lookups) {
      const addresses = tables.get(lookup.accountKey)

      for (const [indexes, role] of [
        [lookup.writableIndexes, AccountRole.WRITABLE],
        [lookup.readonlyIndexes, AccountRole.READONLY]
      ]) {
        for (const i of indexes) {
          if (!addresses[i]) {
            throw new NoSuchElementError(
              `The address lookup table ${lookup.accountKey} holds no address at index ${i}, so the proposal cannot be executed.`
            )
          }

          accounts.push({ address: addresses[i], role })
        }
      }
    }

    return accounts
  }

  /** @private */
  async _getLookupTableAddresses (lookups) {
    const keys = lookups.map((lookup) => address(lookup.accountKey))

    const { value } = await this._rpc
      .getMultipleAccounts(keys, { commitment: this._commitment, encoding: 'base64' })
      .send()

    const tables = new Map()

    value.forEach((account, i) => {
      if (!account || account.owner !== ADDRESS_LOOKUP_TABLE_PROGRAM_ADDRESS) {
        throw new NoSuchElementError(
          `The address lookup table ${keys[i]} does not exist, so the transaction's accounts cannot be resolved.`
        )
      }

      tables.set(
        keys[i],
        ACCOUNT.lookupTableAddresses.decode(getBase64Encoder().encode(account.data[0]))
      )
    })

    return tables
  }

  /** @private */
  _requireAutonomous (multisig) {
    if (multisig.configAuthority) {
      throw new ValueError(
        `The multisig ${multisig.address} is controlled by the configuration authority ${multisig.configAuthority}, which alone can change its members and threshold.`
      )
    }
  }

  /** @private */
  _validateThreshold (threshold, voterCount) {
    if (!Number.isInteger(threshold) || threshold < 1 || threshold > voterCount) {
      throw new ValueError(
        `Invalid threshold ${threshold}. It must be an integer between 1 and the number of owners able to vote (${voterCount}).`
      )
    }
  }

  /** @private */
  _requireViableMembers (members, threshold, multisigPda) {
    if (!members.length) {
      throw new ValueError(`The multisig ${multisigPda} would be left with no members.`)
    }

    const required = [
      [PERMISSION.vote, 'vote on proposals'],
      [PERMISSION.initiate, 'propose transactions'],
      [PERMISSION.execute, 'execute proposals']
    ]

    for (const [mask, permission] of required) {
      if (!members.some((member) => member.mask & mask)) {
        throw new ValueError(
          `The multisig ${multisigPda} would be left with no member able to ${permission}.`
        )
      }
    }

    this._validateThreshold(threshold, members.filter((member) => member.mask & PERMISSION.vote).length)
  }
}
