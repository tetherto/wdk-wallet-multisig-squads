/** @typedef {import('./coordinators/index.js').IMultisigCoordinator} IMultisigCoordinator */
/** @typedef {import('@tetherto/wdk-wallet/multisig').IWalletAccountMultisig} IWalletAccountMultisig */
/** @typedef {import('@tetherto/wdk-wallet/multisig').IMultisigOwnerManagement} IMultisigOwnerManagement */
/** @typedef {import('@tetherto/wdk-wallet/multisig').MultisigInteractionResult} MultisigInteractionResult */
/** @typedef {import('@tetherto/wdk-wallet/multisig').MultisigProposal} MultisigProposal */
/**
 * `MultisigProposal` widened with `transaction` from `MultisigInteractionResult`, and with the
 * approvals a coordinator holds. On Solana every call is its own on-chain transaction, so
 * `transaction` is always set: it carries the execution when `status` is `'executed'`, and the
 * call's own submission when it is `'pending'`. `confirmations` counts what the chain holds or is
 * being sent, and `pendingConfirmations` what a coordinator has gathered but not sent, which is 0
 * for every call that broadcasts.
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
export const PERMISSION: {
    initiate: 1;
    vote: 2;
    execute: 4;
};
/**
 * Solana Squads multisig wallet account implementation.
 *
 * @implements {IWalletAccountMultisig}
 * @implements {IMultisigOwnerManagement}
 */
export default class WalletAccountMultisigSquads extends WalletAccountReadOnlyMultisigSquads implements IWalletAccountMultisig, IMultisigOwnerManagement {
    /**
     * Builds the signer a multisig is created with, from the secret its create key derives from.
     *
     * @param {string | Uint8Array} createKeySecret - The create key's secret. Base58 or raw bytes, either a 32-byte private key or a 64-byte keypair.
     * @returns {Promise<KeyPairSigner>} The create key signer.
     */
    static getCreateKeySigner(createKeySecret: string | Uint8Array): Promise<KeyPairSigner>;
    /**
     * Creates a new Solana Squads multisig wallet account.
     *
     * @param {string | Uint8Array} seed - A [BIP-39](https://github.com/bitcoin/bips/blob/master/bip-0039.mediawiki) mnemonic seed phrase, or a raw BIP-32 master seed (16-64 bytes).
     * @param {string} path - The SLIP-0010 derivation path (e.g. "0'/0'").
     * @param {MultisigSquadsWalletConfig} config - The configuration object.
     */
    constructor(seed: string | Uint8Array, path: string, config: MultisigSquadsWalletConfig);
    /**
     * The underlying Solana signer account.
     *
     * @protected
     * @type {WalletAccountSolana}
     */
    protected _signerAccount: WalletAccountSolana;
    /**
     * The coordinator the approvals are circulated through, undefined when the configuration names
     * none.
     *
     * @protected
     * @type {IMultisigCoordinator | undefined}
     */
    protected _coordinator: IMultisigCoordinator | undefined;
    /**
     * The derivation path's index of this account.
     *
     * @type {number}
     */
    get index(): number;
    /**
     * The derivation path of this account (see [SLIP-0010](https://slips.readthedocs.io/en/latest/slip-0010/)).
     *
     * @type {string}
     */
    get path(): string;
    /**
     * The key pair of the signer account.
     *
     * @type {KeyPair}
     */
    get keyPair(): KeyPair;
    /**
     * Returns the address of the member this account votes and proposes as.
     *
     * @returns {Promise<string>} The signer's address.
     */
    getSignerAddress(): Promise<string>;
    /**
     * Signs a message with the signer account.
     *
     * @param {string} message - The message to sign.
     * @returns {Promise<string>} The signature.
     */
    sign(message: string): Promise<string>;
    /**
     * Signs a transaction with the signer account. Not supported by Squads.
     *
     * @param {SolanaTransaction} tx - The transaction to sign.
     * @returns {Promise<SolanaTransaction>} The signed transaction.
     * @throws {UnsupportedOperationError} A multisig is a program-derived address and cannot sign.
     */
    signTransaction(tx: SolanaTransaction): Promise<SolanaTransaction>;
    /**
     * Sends a transaction from the multisig. Not supported by Squads.
     *
     * @param {SolanaTransaction} tx - The transaction to send.
     * @returns {Promise<TransactionResult>} The transaction's result.
     * @throws {UnsupportedOperationError} A multisig proposes transactions rather than submitting them.
     */
    sendTransaction(tx: SolanaTransaction): Promise<TransactionResult>;
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
    deploy(owners?: string[], threshold?: number): Promise<Pick<TransactionResult, "hash">>;
    /**
     * Proposes a transaction to the multisig, open for voting. `tx` is either `{ to, value }` for a
     * SOL transfer or a message carrying `instructions`, which the vault executes as they stand.
     *
     * @param {SolanaTransaction} tx - The transaction to propose.
     * @param {MultisigSquadsTransactionOptions} [transactionOptions] - The multisig transaction's options. `vaultIndex` names the vault to spend from (default: 0). `autoExecute` executes the proposal in the same transaction only when it can: threshold 1, no time lock, and a signer holding both vote and execute. Where it cannot, it goes inert and the result's `status` stays `'pending'` rather than throwing. `memo` is recorded on chain with the creation.
     * @returns {Promise<MultisigSquadsProposalResult>} The proposal result. `transaction.fee` is the network fee plus the rent the transaction and proposal accounts lock up, the same basis the quotes use.
     */
    propose(tx: SolanaTransaction, { vaultIndex, ...transactionOptions }?: MultisigSquadsTransactionOptions): Promise<MultisigSquadsProposalResult>;
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
    proposeTransfer(transferOptions: TransferOptions, { vaultIndex, ...transactionOptions }?: MultisigSquadsTransactionOptions): Promise<MultisigSquadsProposalResult>;
    /**
     * Approves a pending transaction proposal.
     *
     * @param {number | bigint | string} proposalId - The proposal (transaction index) id.
     * @param {MultisigSquadsTransactionOptions} [transactionOptions] - The multisig transaction's options. `memo` is the note recorded on chain with the vote. `autoExecute` executes the proposal in the same transaction only when it can: this approval reaching the threshold, no time lock, and a signer holding execute on top of the vote. Where it does not apply, it goes inert and the result's `status` stays `'pending'` rather than throwing. `vaultIndex` does not bear on a vote. None of the three applies to a coordinator's bundle, which has decided them already.
     * @returns {Promise<MultisigSquadsProposalResult>} The approval result. `status` is `'executed'` when the execution ran in the same transaction, in which case `transaction` is that execution rather than a bare submission. Through a coordinator, `fee` is what the bundle's own fee payer is charged. A vote that only circulated adds nothing to `confirmations`, which the chain still governs; it counts in `pendingConfirmations`, with the other approvals the bundle has collected a signature for, and reports `{ hash: '', fee: 0n }`.
     * @throws {ValueError} The signer must not have approved the proposal already, and a coordinator's bundle must carry this signer's approval and no member's twice.
     * @throws {MaximumFeeExceededError} A coordinator's bundle must quote within `approveMaxFee`.
     */
    approveProposal(proposalId: number | bigint | string, { memo, autoExecute }?: MultisigSquadsTransactionOptions): Promise<MultisigSquadsProposalResult>;
    /** @private */
    private _decodeBundle;
    /** @private */
    private _leads;
    /** @private */
    private _quoteMessage;
    /** @private */
    private _sendSignedTransaction;
    /**
     * Rejects a pending transaction proposal.
     *
     * @param {number | bigint | string} proposalId - The proposal (transaction index) id.
     * @param {MultisigSquadsTransactionOptions} [transactionOptions] - The multisig transaction's options. Only `memo` bears on a rejection, as the note recorded on chain with it: a rejected proposal executes nothing, so `autoExecute` is inert here. A rejection is the member's own transaction and never reaches a coordinator.
     * @returns {Promise<MultisigSquadsProposalResult>} The rejection result.
     * @throws {ValueError} The signer must not have rejected the proposal already.
     */
    rejectProposal(proposalId: number | bigint | string, { memo }?: MultisigSquadsTransactionOptions): Promise<MultisigSquadsProposalResult>;
    /**
     * Submits an approved proposal for on-chain execution.
     *
     * @param {number | bigint | string} proposalId - The proposal (transaction index) id.
     * @returns {Promise<TransactionResult>} The execution transaction's result.
     * @throws {NoSuchElementError} The multisig and a proposal at that id must exist.
     * @throws {ThresholdNotMetError} The proposal must have reached the approval threshold.
     * @throws {ValueError} The proposal must be approved rather than in another status, its time lock must have elapsed, and its transaction account must still be open.
     */
    executeProposal(proposalId: number | bigint | string): Promise<TransactionResult>;
    /**
     * Proposes adding a new member to the multisig.
     *
     * @param {string} ownerAddress - The address of the member to add.
     * @param {MultisigSquadsAddOwnerOptions} [options] - The operation options. `mask` is the member's Squads permissions (default: all three).
     * @returns {Promise<MultisigSquadsProposalResult>} The proposal result. `transaction.fee` is the network fee plus the rent the transaction and proposal accounts lock up, the same basis the quotes use.
     * @throws {ValueError} The permission mask must be valid, and the address must not already be a member.
     */
    addOwner(ownerAddress: string, { mask, threshold }?: MultisigSquadsAddOwnerOptions): Promise<MultisigSquadsProposalResult>;
    /**
     * Proposes removing a member from the multisig.
     *
     * @param {string} ownerAddress - The address of the member to remove.
     * @param {Partial<MultisigOptions>} [options] - The operation options.
     * @returns {Promise<MultisigSquadsProposalResult>} The proposal result. `transaction.fee` is the network fee plus the rent the transaction and proposal accounts lock up, the same basis the quotes use.
     * @throws {ValueError} The address must be a member of the multisig.
     */
    removeOwner(ownerAddress: string, { threshold }?: Partial<MultisigOptions>): Promise<MultisigSquadsProposalResult>;
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
    swapOwner(oldOwnerAddress: string, newOwnerAddress: string, { threshold }?: Partial<MultisigOptions>): Promise<MultisigSquadsProposalResult>;
    /**
     * Proposes changing the approval threshold of the multisig.
     *
     * @param {number} newThreshold - The new threshold.
     * @returns {Promise<MultisigSquadsProposalResult>} The proposal result. `transaction.fee` is the network fee plus the rent the transaction and proposal accounts lock up, the same basis the quotes use.
     * @throws {ValueError} The threshold must not already be in force.
     */
    changeThreshold(newThreshold: number): Promise<MultisigSquadsProposalResult>;
    /**
     * Returns a read-only copy of the account. The multisig address is resolved first, since the
     * copy carries no `createKeySecret` to resolve it from.
     *
     * @returns {Promise<WalletAccountReadOnlyMultisigSquads>} The read-only account.
     */
    toReadOnlyAccount(): Promise<WalletAccountReadOnlyMultisigSquads>;
    /**
     * Disposes the wallet account, erasing the private key from the memory.
     *
     * @returns {void} Nothing; the account cannot sign once disposed.
     */
    dispose(): void;
    /** @private */
    private _proposeVaultTransaction;
    /** @private */
    private _getRentPayerAccount;
    /** @private */
    private _proposeConfigTransaction;
    /** @private */
    private _requireDeployed;
    /** @private */
    private _proposeTransaction;
    /** @private */
    private _buildAutoExecuteInstructions;
    /** @private */
    private _requirePermission;
    /** @private */
    private _requireVotableProposal;
    /** @private */
    private _buildProposalVoteInstruction;
    /** @private */
    private _toMemo;
    /** @private */
    private _canAutoExecute;
    /** @private */
    private _buildVoteExecuteInstruction;
    /** @private */
    private _buildConfigExecuteInstruction;
    /** @private */
    private _buildVaultExecuteInstruction;
    /** @private */
    private _resolveExecutionAccounts;
    /** @private */
    private _getLookupTableAddresses;
    /** @private */
    private _requireAutonomous;
    /** @private */
    private _validateThreshold;
    /** @private */
    private _requireViableMembers;
}
export type IMultisigCoordinator = import("./coordinators/index.js").IMultisigCoordinator;
export type IWalletAccountMultisig = import("@tetherto/wdk-wallet/multisig").IWalletAccountMultisig;
export type IMultisigOwnerManagement = import("@tetherto/wdk-wallet/multisig").IMultisigOwnerManagement;
export type MultisigInteractionResult = import("@tetherto/wdk-wallet/multisig").MultisigInteractionResult;
export type MultisigProposal = import("@tetherto/wdk-wallet/multisig").MultisigProposal;
/**
 * `MultisigProposal` widened with `transaction` from `MultisigInteractionResult`, and with the
 * approvals a coordinator holds. On Solana every call is its own on-chain transaction, so
 * `transaction` is always set: it carries the execution when `status` is `'executed'`, and the
 * call's own submission when it is `'pending'`. `confirmations` counts what the chain holds or is
 * being sent, and `pendingConfirmations` what a coordinator has gathered but not sent, which is 0
 * for every call that broadcasts.
 */
export type MultisigSquadsProposalResult = MultisigProposal & MultisigInteractionResult & {
    pendingConfirmations: number;
};
export type MultisigTransactionOptions = import("@tetherto/wdk-wallet/multisig").MultisigTransactionOptions;
/**
 * `MultisigTransactionOptions` widened with the vault the proposal spends from and the note the
 * call records. `vaultIndex` is an index between 0 and 255, which the stored transaction carries
 * so the program signs with the same vault the message was compiled against, defaulting to the
 * main vault, 0. `memo` is an optional note recorded on chain with the instruction, where an empty
 * string is a present-but-empty memo rather than none.
 */
export type MultisigSquadsTransactionOptions = MultisigTransactionOptions & {
    vaultIndex?: number;
    memo?: string;
};
export type MultisigOptions = import("@tetherto/wdk-wallet/multisig").MultisigOptions;
/**
 * `MultisigOptions` widened with the Squads permission mask to grant the member being added: a
 * bitwise OR of `PERMISSION.initiate`, `PERMISSION.vote` and `PERMISSION.execute`. Both fields
 * are optional; the threshold and the mask each keep their default when omitted.
 */
export type MultisigSquadsAddOwnerOptions = Partial<MultisigOptions> & {
    mask?: number;
};
export type TransactionResult = import("@tetherto/wdk-wallet").TransactionResult;
export type TransferOptions = import("@tetherto/wdk-wallet").TransferOptions;
export type KeyPair = import("@tetherto/wdk-wallet").KeyPair;
export type KeyPairSigner = import("@solana/signers").KeyPairSigner;
export type SolanaTransaction = import("@tetherto/wdk-wallet-solana").SolanaTransaction;
export type MultisigSquadsWalletConfig = import("./wallet-account-read-only-multisig-squads.js").MultisigSquadsWalletConfig;
import WalletAccountReadOnlyMultisigSquads from './wallet-account-read-only-multisig-squads.js';
import { WalletAccountSolana } from '@tetherto/wdk-wallet-solana';
