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
export const SQUADS_PROGRAM_ADDRESS: "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf";
/**
 * The transaction kinds a Squads proposal can back, keyed by kind.
 *
 * @type {{ [K in SquadsTransactionKind]: K }}
 */
export const TRANSACTION_KIND: { [K in SquadsTransactionKind]: K; };
export const SIGNATURE_BASE_FEE: bigint;
export namespace SECRET_SIZE {
    let privateKey: number;
    let keyPair: number;
}
/** @type {{ multisig: 8, proposal: 4, transaction: 2, now: 1, all: 15 }} */
export const PROPOSAL_DATA_MASK: {
    multisig: 8;
    proposal: 4;
    transaction: 2;
    now: 1;
    all: 15;
};
/**
 * Read-only Solana Squads multisig wallet account implementation.
 *
 * @implements {IWalletAccountReadOnlyMultisig}
 */
export default class WalletAccountReadOnlyMultisigSquads extends WalletAccountReadOnly implements IWalletAccountReadOnlyMultisig {
    /**
     * Normalizes a create key secret to bytes, rejecting what cannot be one. Both the address
     * derivation and the signer build read a secret through this, so they refuse the same inputs.
     *
     * @param {string | Uint8Array} createKeySecret - The secret, base58 or raw bytes.
     * @returns {Uint8Array} The secret's bytes, either 32 or 64 of them.
     * @throws {ValueError} The secret must be given, and must be 32 or 64 bytes.
     */
    static toCreateKeySecretBytes(createKeySecret: string | Uint8Array): Uint8Array;
    /**
     * Derives the create key's address from its secret, without building a signer. Synchronous, so a
     * multisig's address is known at construction rather than on the first call that needs it.
     *
     * @param {string | Uint8Array} createKeySecret - The create key's secret. Base58 or raw bytes, either a 32-byte private key or a 64-byte keypair.
     * @returns {string} The create key's address.
     */
    static getCreateKey(createKeySecret: string | Uint8Array): string;
    /**
     * Resolves what a config names, an address or a create key, to the multisig's address. A create
     * key is on the ed25519 curve and a multisig address is not, so the two need no disambiguation
     * beyond the value itself.
     *
     * @param {string} programId - The Squads program the multisig belongs to.
     * @param {string} [multisigPdaOrCreateKey] - The multisig address, or the create key it derives from.
     * @returns {Address | undefined} The multisig address, or undefined when neither is given.
     */
    static toMultisigPda(programId: string, multisigPdaOrCreateKey?: string): Address | undefined;
    /**
     * Builds the RPC client a configuration asks for: one client per URL behind a failover proxy
     * when it names a list, a single client when it names one URL, and none when it names neither.
     *
     * @param {MultisigSquadsWalletReadOnlyConfig} [config] - The configuration to read `provider` and `retries` from.
     * @returns {SolanaRpc | undefined} The client, or undefined when no provider is configured.
     */
    static createRpc({ provider, retries }?: MultisigSquadsWalletReadOnlyConfig): SolanaRpc | undefined;
    /**
     * The default poll cadence for `waitForTransaction`, one slot rather than the block time the
     * base class assumes.
     *
     * @type {number}
     */
    get defaultWaitInterval(): number;
    /**
     * Creates a new read-only Solana Squads multisig wallet account.
     *
     * @param {MultisigSquadsWalletReadOnlyConfig} config - The configuration object.
     */
    constructor(config: MultisigSquadsWalletReadOnlyConfig);
    /**
     * The multisig Squads configuration. It carries the signing fields too when a signing
     * account owns it, or when one derived this account through `_withConfig`.
     *
     * @protected
     * @type {MultisigSquadsWalletConfig}
     */
    protected _config: MultisigSquadsWalletConfig;
    /**
     * The address of the Squads program to operate against.
     *
     * @protected
     * @type {Address}
     */
    protected _programId: Address;
    /**
     * The commitment level for transactions.
     *
     * @protected
     * @type {Commitment}
     */
    protected _commitment: Commitment;
    /**
     * A Solana RPC client for HTTP requests.
     *
     * @protected
     * @type {SolanaRpc | undefined}
     */
    protected _rpc: SolanaRpc | undefined;
    /**
     * Returns whether the multisig account exists on-chain.
     *
     * @returns {Promise<boolean>} Whether the multisig account exists.
     * @throws {ProviderRequiredError} The wallet must be connected to a provider.
     */
    isDeployed(): Promise<boolean>;
    /**
     * Returns aggregated information about the multisig.
     *
     * @returns {Promise<MultisigSquadsInfo>} The multisig info.
     */
    getMultisigInfo(): Promise<MultisigSquadsInfo>;
    /**
     * Returns the transaction index of the most recently created transaction.
     *
     * @returns {Promise<bigint>} The transaction index.
     * @throws {ProviderRequiredError} The wallet must be connected to a provider.
     * @throws {NoSuchElementError} The multisig account must exist.
     * @throws {ValueError} The account must hold a Squads multisig.
     */
    getNonce(): Promise<bigint>;
    /**
     * Returns the address of one of the multisig's vaults, where its funds are held. An address is
     * accepted only when it derives from this multisig, so a vault of another multisig, or an
     * unrelated account, is rejected rather than read.
     *
     * @param {number | string} [vaultIndexOrAddress] - A vault index between 0 and `MAX.vaultIndex`, or the address of one of this multisig's vaults (default: 0).
     * @returns {Promise<string>} The vault address.
     * @throws {ValueError} The index must be in range, and the address must be valid base58 and belong to this multisig.
     */
    getVaultAddress(vaultIndexOrAddress?: number | string): Promise<string>;
    /**
     * Returns the native SOL balance of one of the multisig's vaults.
     *
     * @param {number | string} [vaultIndexOrAddress] - A vault index between 0 and `MAX.vaultIndex`, or a vault address to read as given (default: 0).
     * @returns {Promise<bigint>} The balance in lamports.
     * @throws {ProviderRequiredError} The wallet must be connected to a provider.
     */
    getBalance(vaultIndexOrAddress?: number | string): Promise<bigint>;
    /**
     * Returns the balance of an SPL token held by one of the multisig's vaults.
     *
     * @param {string} tokenAddress - The SPL token mint address.
     * @param {number | string} [vaultIndexOrAddress] - A vault index between 0 and `MAX.vaultIndex`, or a vault address to read as given (default: 0).
     * @returns {Promise<bigint>} The token balance (in base unit).
     * @throws {ProviderRequiredError} The wallet must be connected to a provider.
     * @todo Support Token-2022 (Token Extensions Program).
     */
    getTokenBalance(tokenAddress: string, vaultIndexOrAddress?: number | string): Promise<bigint>;
    /**
     * Retrieves a transaction receipt by its signature.
     *
     * @param {string} hash - The transaction signature.
     * @returns {Promise<SolanaTransactionReceipt | null>} The receipt, or null if the transaction was not found.
     * @throws {ProviderRequiredError} The wallet must be connected to a provider.
     * @throws {ValueError} The signature must be 64 base58-encoded bytes.
     */
    getTransactionReceipt(hash: string): Promise<SolanaTransactionReceipt | null>;
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
    getTransaction(hash: string): Promise<TransactionReceipt>;
    /**
     * Verifies a message's signature. Not supported by Squads.
     *
     * @param {string} message - The signed message.
     * @param {string} signature - The signature to verify.
     * @returns {Promise<boolean>} Whether the signature is valid.
     * @throws {UnsupportedOperationError} A multisig address has no private key to attribute a signature to.
     */
    verify(message: string, signature: string): Promise<boolean>;
    /**
     * Returns the proposals at the given ids, keyed by id in canonical decimal form.
     *
     * @param {(number | bigint | string)[]} proposalIds - The proposal (transaction index) ids.
     * @returns {Promise<Record<string, MultisigSquadsProposal | null>>} For each id, the proposal, or null if no proposal exists at that id.
     * @throws {ProviderRequiredError} The wallet must be connected to a provider.
     * @throws {NoSuchElementError} The multisig account must exist.
     */
    getProposals(proposalIds: (number | bigint | string)[]): Promise<Record<string, MultisigSquadsProposal | null>>;
    /**
     * Returns the proposal at the given id.
     *
     * @param {number | bigint | string} proposalId - The proposal (transaction index) id.
     * @returns {Promise<MultisigSquadsProposal | null>} The proposal, or null if no proposal exists at that id.
     */
    getProposal(proposalId: number | bigint | string): Promise<MultisigSquadsProposal | null>;
    /**
     * Returns whether a proposal can be executed right now, meaning `executeProposal` would submit
     * it rather than throw. A batch reads as not ready for that reason, though the program would
     * execute one.
     *
     * @param {number | bigint | string} proposalId - The proposal (transaction index) id.
     * @returns {Promise<boolean>} Whether the proposal can be executed.
     */
    isReadyToExecute(proposalId: number | bigint | string): Promise<boolean>;
    /**
     * Quotes the costs of a send transaction operation. Not supported by Squads.
     *
     * @param {SolanaTransaction} tx - The transaction to quote.
     * @returns {Promise<Omit<TransactionResult, 'hash'>>} The transaction's quote.
     * @throws {UnsupportedOperationError} A multisig proposes transactions rather than submitting them.
     */
    quoteSendTransaction(tx: SolanaTransaction): Promise<Omit<TransactionResult, "hash">>;
    /**
     * Quotes the costs of a deploy operation.
     *
     * @param {number} [memberCount] - The number of members the multisig will hold (default: 1).
     * @returns {Promise<Omit<TransactionResult, 'hash'>>} The deploy quote, in lamports.
     * @throws {ProviderRequiredError} The wallet must be connected to a provider.
     */
    quoteDeploy(memberCount?: number): Promise<Omit<TransactionResult, "hash">>;
    /**
     * Quotes the costs of a propose operation.
     *
     * @param {SolanaTransaction} tx - The transaction to quote, either arm of `SolanaTransaction`.
     * @param {MultisigSquadsWalletConfig} [config] - An optional config override, merged over this account's configuration.
     * @returns {Promise<Omit<TransactionResult, 'hash'>>} The transaction quote, in lamports. Sized from the message the proposal would store, so it is exact for any transaction `propose` accepts.
     * @throws {ProviderRequiredError} The wallet must be connected to a provider.
     * @throws {NoSuchElementError} The multisig must exist.
     */
    quotePropose(tx: SolanaTransaction, config?: MultisigSquadsWalletConfig): Promise<Omit<TransactionResult, "hash">>;
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
    quoteTransfer(transferOptions: TransferOptions, config?: MultisigSquadsWalletConfig): Promise<Omit<TransactionResult, "hash">>;
    /**
     * Quotes the costs of an execute proposal operation.
     *
     * @param {number | bigint | string} proposalId - The proposal (transaction index) id.
     * @returns {Promise<Omit<TransactionResult, 'hash'>>} The execution quote, in lamports.
     * @throws {NoSuchElementError} A proposal must exist at that id.
     */
    quoteExecuteProposal(proposalId: number | bigint | string): Promise<Omit<TransactionResult, "hash">>;
    /**
     * Reads and decodes the multisig account, keeping every field it holds.
     *
     * @protected
     * @returns {Promise<SquadsMultisigAccount>} The decoded account.
     * @throws {ProviderRequiredError} The wallet must be connected to a provider.
     */
    protected _getMultisigAccount(): Promise<SquadsMultisigAccount>;
    /**
     * Reads a proposal's whole context in one request.
     *
     * @overload
     * @param {bigint} index - The proposal (transaction index) id.
     * @returns {Promise<SquadsProposalContext>} The multisig, the proposal, its transaction and the cluster clock.
     * @throws {ProviderRequiredError} The wallet must be connected to a provider.
     * @throws {ProviderError} The provider must serve the cluster clock.
     */
    protected _getProposal(index: bigint): Promise<SquadsProposalContext>;
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
    protected _getProposal(index: bigint, mask: number): Promise<Partial<SquadsProposalContext>>;
    /**
     * Reads the Squads program config account.
     *
     * @protected
     * @returns {Promise<SquadsProgramConfig>} The program config address, its multisig creation fee, and its treasury address.
     * @throws {ProviderRequiredError} The wallet must be connected to a provider.
     * @throws {NoSuchElementError} The account must exist and must be a program config.
     */
    protected _getProgramConfig(): Promise<SquadsProgramConfig>;
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
    protected _toProposedInstructions(vaultPda: Address, tx: SolanaTransaction): CompilableInstruction[];
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
    protected _toTransferInstructions(vaultPda: Address, transferOptions: TransferOptions): Promise<CompilableInstruction[]>;
    /**
     * Compiles instructions into the message a vault transaction stores, in both the form the
     * create instruction carries and the size the account will be allocated at.
     *
     * @protected
     * @param {Address} payer - The vault the message is executed from, which is its first key.
     * @param {CompilableInstruction[]} instructions - The instructions, in kit's shape.
     * @returns {CompiledTransactionMessage} The compiled message.
     */
    protected _compileTransactionMessage(payer: Address, instructions: CompilableInstruction[]): CompiledTransactionMessage;
    /**
     * Validates a multisig's membership size against what the program can hold.
     *
     * @protected
     * @param {number} memberCount - How many members the multisig would hold.
     * @returns {void} Nothing; throws when the count is out of range.
     * @throws {ValueError} The count must be an integer between 1 and 65,535.
     */
    protected _validateMemberCount(memberCount: number): void;
    /**
     * Returns the size of the `Multisig` account a multisig of the given membership is stored in.
     *
     * @protected
     * @param {number} memberCount - How many members the multisig holds.
     * @returns {number} The account's size, in bytes.
     */
    protected _multisigAccountSize(memberCount: number): number;
    /**
     * Adds up what creating a multisig costs: the account's rent, the protocol's creation fee, and
     * the two signatures `multisigCreateV2` needs.
     *
     * @protected
     * @param {bigint} creationFee - The protocol's multisig creation fee.
     * @param {bigint} rent - The multisig account's rent-exempt minimum.
     * @returns {bigint} The whole cost, in lamports.
     */
    protected _quoteDeployFrom(creationFee: bigint, rent: bigint): bigint;
    /**
     * Returns the size of the `VaultTransaction` account a message of the given size is stored in.
     *
     * @protected
     * @param {number} messageSize - The size of the compiled transaction message, in bytes.
     * @returns {number} The account's size, in bytes.
     */
    protected _vaultTransactionSize(messageSize: number): number;
    /**
     * Returns the size of the `ConfigTransaction` account the given actions are stored in.
     *
     * @protected
     * @param {number} actionsSize - The size of the encoded action list, its length prefix included.
     * @returns {number} The account's size, in bytes.
     */
    protected _configTransactionSize(actionsSize: number): number;
    /**
     * Quotes a proposal of a message of the given size: the rent of the two accounts it creates,
     * and that rent plus the proposer's signature, which is what the caller is debited.
     *
     * @protected
     * @param {number} transactionSize - The size of the transaction account, in bytes.
     * @param {number} memberCount - How many members the multisig holds.
     * @returns {Promise<{ rent: bigint, fee: bigint }>} The rent alone, and the whole cost.
     */
    protected _quoteProposal(transactionSize: number, memberCount: number): Promise<{
        rent: bigint;
        fee: bigint;
    }>;
    /**
     * Quotes the rent of the two accounts a proposal creates, the transaction and the proposal.
     *
     * @protected
     * @param {number} transactionSize - The size of the transaction account, in bytes.
     * @param {number} memberCount - How many members the multisig holds.
     * @returns {Promise<bigint>} The rent both accounts lock up, in lamports.
     * @throws {ProviderRequiredError} The wallet must be connected to a provider.
     */
    protected _quoteProposalRent(transactionSize: number, memberCount: number): Promise<bigint>;
    /**
     * Normalizes a proposal id into the Squads transaction index it refers to.
     *
     * @protected
     * @param {number | bigint | string} proposalId - The proposal (transaction index) id.
     * @returns {bigint} The transaction index.
     * @throws {ValueError} The id must be an integer between 0 and `MAX.proposalIndex`.
     */
    protected _toProposalIndex(proposalId: number | bigint | string): bigint;
    /**
     * Derives the address of the transaction account stored at the given index.
     *
     * @protected
     * @param {string} multisigPda - The multisig address the transaction belongs to.
     * @param {bigint} index - The transaction index.
     * @returns {Address} The transaction address.
     */
    protected _getTransactionPda(multisigPda: string, index: bigint): Address;
    /**
     * Derives the address of the proposal account that votes on the transaction at the given
     * index.
     *
     * @protected
     * @param {string} multisigPda - The multisig address the proposal belongs to.
     * @param {bigint} index - The transaction index the proposal votes on.
     * @returns {Address} The proposal address.
     */
    protected _getProposalPda(multisigPda: string, index: bigint): Address;
    /**
     * Derives the ephemeral signer addresses a stored transaction's message expects.
     *
     * @protected
     * @param {string} transactionPda - The transaction address the signers are derived from.
     * @param {number} count - How many the message needs.
     * @returns {Address[]} The ephemeral signer addresses, in index order.
     */
    protected _getEphemeralSignerPdas(transactionPda: string, count: number): Address[];
    /**
     * Derives a spending limit's address from the create key its action carries.
     *
     * @protected
     * @param {string} multisigPda - The multisig address.
     * @param {string} createKey - The action's `createKey`.
     * @returns {Address} The spending limit address.
     */
    protected _getSpendingLimitPda(multisigPda: string, createKey: string): Address;
    /** @private */
    private _hasDiscriminator;
    /** @private */
    private _withConfig;
    /** @private */
    private _getVaultPda;
    /** @private */
    private _getTransactionSeeds;
    /** @private */
    private _decodeMultisigAccount;
    /** @private */
    private _decodeProposalAccount;
    /** @private */
    private _decodeTransactionAccount;
}
export type SolanaRpc = ReturnType<typeof import("@solana/rpc").createSolanaRpc>;
export type Commitment = import("@solana/rpc-types").Commitment;
export type Address = import("@solana/addresses").Address;
export type AccountMeta = import("@solana/instructions").AccountMeta;
export type Instruction = import("@solana/instructions").Instruction;
export type ReadonlyUint8Array = import("@solana/codecs-core").ReadonlyUint8Array;
/**
 * A kit instruction with the two halves kit leaves optional. Every instruction this package builds
 * carries both, and `_compileTransactionMessage` reads both.
 */
export type CompilableInstruction = Instruction & {
    accounts: readonly AccountMeta[];
    data: ReadonlyUint8Array;
};
/**
 * A transaction message compiled into the two forms the create instruction needs: the bytes it
 * carries, and the size the transaction account is allocated at.
 */
export type CompiledTransactionMessage = {
    /**
     * - The message as the create instruction carries it.
     */
    bytes: ReadonlyUint8Array;
    /**
     * - The size the transaction account is allocated at.
     */
    storedSize: number;
    /**
     * - The account keys, in message order.
     */
    accountKeys: Address[];
    /**
     * - How many leading keys are signers.
     */
    numSigners: number;
    /**
     * - How many of those signers are writable.
     */
    numWritableSigners: number;
    /**
     * - How many non-signers after them are writable.
     */
    numWritableNonSigners: number;
};
export type IWalletAccountReadOnlyMultisig = import("@tetherto/wdk-wallet/multisig").IWalletAccountReadOnlyMultisig;
export type MultisigInfo = import("@tetherto/wdk-wallet/multisig").MultisigInfo;
/**
 * `MultisigInfo` widened with each owner's Squads permission mask, aligned with `owners`.
 */
export type MultisigSquadsInfo = MultisigInfo & {
    masks: number[];
};
export type MultisigProposal = import("@tetherto/wdk-wallet/multisig").MultisigProposal;
/**
 * `MultisigProposal` widened with the proposal's Squads status and its vote lists.
 */
export type MultisigSquadsProposal = MultisigProposal & {
    statusName: string;
    approved: string[];
    rejected: string[];
    cancelled: string[];
};
export type TransactionResult = import("@tetherto/wdk-wallet").TransactionResult;
export type TransactionReceipt = import("@tetherto/wdk-wallet").TransactionReceipt;
export type Finality = import("@tetherto/wdk-wallet").Finality;
export type TransferOptions = import("@tetherto/wdk-wallet").TransferOptions;
export type MultisigCoordinatorFactory = import("./coordinators/index.js").MultisigCoordinatorFactory;
export type SolanaTransaction = import("@tetherto/wdk-wallet-solana").SolanaTransaction;
export type SolanaTransactionReceipt = import("@tetherto/wdk-wallet-solana").SolanaTransactionReceipt;
/**
 * The configuration a read-only Squads account takes: how to reach the cluster, and which
 * multisig to operate on. Two fields name the multisig: its address, or the create key it derives
 * from, or the secret that create key derives from. The first two never look alike. A multisig
 * address always sits off the ed25519 curve, and a create key always sits on it, because it has to
 * sign the multisig into being.
 */
export type MultisigSquadsWalletReadOnlyConfig = {
    /**
     * - A Solana RPC URL, or a list of URLs for failover. Omit it to derive addresses without reaching the cluster; every method that needs the cluster then throws.
     */
    provider?: string | string[];
    /**
     * - The commitment level for transactions (default: 'confirmed').
     */
    commitment?: Commitment;
    /**
     * - The number of retries for the failover provider (default: 3).
     */
    retries?: number;
    /**
     * - The Squads program to operate against, for a fork or a local deployment (default: `SQUADS_PROGRAM_ADDRESS`).
     */
    programId?: string;
    /**
     * - The address of an existing Squads multisig, or the create key its address derives from.
     */
    multisigPdaOrCreateKey?: string;
    /**
     * - The create key's secret, which the multisig address derives from when `multisigPdaOrCreateKey` is absent, and which deploying a multisig requires. Base58 or raw bytes, either a 32-byte private key or a 64-byte keypair.
     */
    createKeySecret?: string | Uint8Array;
};
/**
 * The extra configuration a signing account takes: the account that funds the rent Squads
 * charges, and the fee ceilings above which it refuses to submit.
 */
export type MultisigSquadsWalletSigningConfig = {
    /**
     * - Builds the coordinator the account votes through, from the address of the member it will vote as. Omit it and each vote is the member's own transaction.
     */
    coordinator?: MultisigCoordinatorFactory;
    /**
     * - The account charged for the rent the multisig, transaction and proposal accounts lock up (default: the signer). It must sign the transaction by other means, which nothing in this package currently provides.
     */
    rentPayer?: string;
    /**
     * - The maximum fee amount for the create/deploy operation.
     */
    createMaxFee?: number | bigint;
    /**
     * - The maximum fee amount for transfers.
     */
    transferMaxFee?: number | bigint;
    /**
     * - The maximum fee amount for approving through a coordinator, quoted before the member signs. A coordinator compiles the bundle, so it fixes the priority fee that vote carries.
     */
    approveMaxFee?: number | bigint;
};
export type MultisigSquadsWalletConfig = MultisigSquadsWalletReadOnlyConfig & MultisigSquadsWalletSigningConfig;
/**
 * A member of a Squads multisig, as stored on-chain.
 */
export type SquadsMember = {
    /**
     * - The member's address.
     */
    address: string;
    /**
     * - The member's permission bitmask: 1 initiate, 2 vote, 4 execute.
     */
    mask: number;
};
/**
 * A decoded Squads multisig account. When `isCreated` is false the account does not exist
 * on-chain and every other field holds a placeholder.
 */
export type SquadsMultisigAccount = {
    /**
     * - The multisig address the account was read from.
     */
    address: string;
    /**
     * - Whether the account exists on-chain.
     */
    isCreated: boolean;
    /**
     * - The authority that alone may change the members and threshold, or null when the multisig votes on its own configuration.
     */
    configAuthority: string | null;
    /**
     * - The number of approvals a proposal needs to be executable.
     */
    threshold: number;
    /**
     * - Seconds an approved proposal must wait before it can execute.
     */
    timeLock: number;
    /**
     * - The index of the most recently created transaction.
     */
    transactionIndex: bigint;
    /**
     * - Proposals at or below this index were invalidated by a later configuration change and can no longer be voted on or executed.
     */
    staleTransactionIndex: bigint;
    /**
     * - The address that reclaims rent when a proposal's accounts are closed, or null when the multisig collects none.
     */
    rentCollector: string | null;
    /**
     * - The members, in on-chain order.
     */
    members: SquadsMember[];
};
/**
 * A decoded Squads proposal account. When `exists` is false no proposal has been created at
 * that transaction index and every other field holds a placeholder.
 */
export type SquadsProposalAccount = {
    /**
     * - The proposal's program-derived address.
     */
    address: Address;
    /**
     * - Whether a proposal has been created at that index.
     */
    exists: boolean;
    /**
     * - The raw status discriminant, or -1 when the proposal is absent.
     */
    status: number;
    /**
     * - The status as a name, e.g. `'Active'`.
     */
    statusName: string | null;
    /**
     * - The status as a sentence fragment, for error messages.
     */
    statusPhrase: string | null;
    /**
     * - The Unix timestamp the status was set at, or null while the proposal is executing, the one status Squads stores without a timestamp.
     */
    statusTimestamp: bigint | null;
    /**
     * - The members that have approved.
     */
    approved: string[];
    /**
     * - The members that have rejected.
     */
    rejected: string[];
    /**
     * - The members that have cancelled.
     */
    cancelled: string[];
};
/**
 * A lookup a stored transaction message makes into an address lookup table.
 */
export type SquadsAddressTableLookup = {
    /**
     * - The lookup table's address.
     */
    accountKey: string;
    /**
     * - The table indexes loaded as writable accounts.
     */
    writableIndexes: number[];
    /**
     * - The table indexes loaded as read-only accounts.
     */
    readonlyIndexes: number[];
};
/**
 * The message a vault transaction executes, decoded far enough to rebuild its account list.
 */
export type SquadsTransactionMessage = {
    /**
     * - How many leading account keys are signers.
     */
    numSigners: number;
    /**
     * - How many of those leading signers are writable.
     */
    numWritableSigners: number;
    /**
     * - How many non-signers after them are writable.
     */
    numWritableNonSigners: number;
    /**
     * - The statically listed addresses, in message order.
     */
    accountKeys: string[];
    /**
     * - The lookup table references.
     */
    addressTableLookups: SquadsAddressTableLookup[];
};
export type SquadsTransactionKind = "vault" | "config" | "batch";
export type SquadsConfigActionKind = "AddMember" | "RemoveMember" | "ChangeThreshold" | "SetTimeLock" | "AddSpendingLimit" | "RemoveSpendingLimit" | "SetRentCollector";
/**
 * A configuration change a config transaction applies. `createKey` and `spendingLimit` name the
 * spending limit account the executor has to pass through, and are null for every other kind.
 */
export type SquadsConfigAction = {
    /**
     * - The change the action applies.
     */
    kind: SquadsConfigActionKind;
    /**
     * - The key the spending limit to create derives from.
     */
    createKey: string | null;
    /**
     * - The address of the spending limit to close.
     */
    spendingLimit: string | null;
};
/**
 * A decoded Squads transaction account backing a proposal. When `exists` is false no
 * transaction has been created at that index and every other field holds a placeholder.
 */
export type SquadsTransactionAccount = {
    /**
     * - The transaction's program-derived address.
     */
    address: Address;
    /**
     * - Whether a transaction has been created at that index.
     */
    exists: boolean;
    /**
     * - The transaction kind, null when the account is absent or holds a kind this package cannot decode.
     */
    kind: SquadsTransactionKind | null;
    /**
     * - The vault the message spends from; 0 for non-vault kinds.
     */
    vaultIndex: number;
    /**
     * - The ephemeral signers the message expects.
     */
    ephemeralSignerCount: number;
    /**
     * - The stored message, vault kind only.
     */
    message: SquadsTransactionMessage | null;
    /**
     * - The configuration actions, config kind only.
     */
    actions: SquadsConfigAction[];
};
/**
 * The Squads program config: the fee it charges to create a multisig, and the treasury that
 * collects it.
 */
export type SquadsProgramConfig = {
    /**
     * - The program config's program-derived address.
     */
    programConfigPda: Address;
    /**
     * - The fee charged per multisig creation, in lamports.
     */
    creationFee: bigint;
    /**
     * - The address the creation fee is paid to.
     */
    treasury: string;
};
/**
 * A multisig, one of its proposals, the transaction that proposal backs, and the cluster clock,
 * read together so an execution can be checked against a single consistent snapshot.
 */
export type SquadsProposalContext = {
    /**
     * - The decoded multisig account.
     */
    multisig: SquadsMultisigAccount;
    /**
     * - The decoded proposal account.
     */
    proposal: SquadsProposalAccount;
    /**
     * - The decoded transaction account.
     */
    transaction: SquadsTransactionAccount;
    /**
     * - The cluster's current Unix timestamp, read from the clock sysvar.
     */
    now: bigint;
};
import { WalletAccountReadOnly } from '@tetherto/wdk-wallet';
