/**
 * Wallet manager for Solana Squads multisig wallets.
 */
export default class WalletManagerMultisigSquads extends WalletManager {
    /**
     * Creates a new wallet manager for Solana Squads multisig wallets.
     *
     * @param {string | Uint8Array} seed - The wallet's [BIP-39](https://github.com/bitcoin/bips/blob/master/bip-0039.mediawiki) seed phrase.
     * @param {MultisigSquadsWalletConfig} [config] - The configuration object (default: {}).
     */
    constructor(seed: string | Uint8Array, config?: MultisigSquadsWalletConfig);
    /**
     * A Solana RPC client for HTTP requests.
     *
     * @protected
     * @type {SolanaRpc | undefined}
     */
    protected _rpc: SolanaRpc | undefined;
    /**
     * Returns the wallet account at a specific index (see [SLIP-0010](https://slips.readthedocs.io/en/latest/slip-0010/)).
     *
     * @example
     * // Returns the account with derivation path m/44'/501'/1'/0'
     * const account = await wallet.getAccount(1);
     * @param {number | string} [indexOrSignerName] - The index of the account to get (default: 0). A registered signer name is not supported.
     * @returns {Promise<WalletAccountMultisigSquads>} The account.
     * @throws {UnsupportedOperationError} The signer name must be omitted: this wallet keeps no signer registry.
     */
    getAccount(indexOrSignerName?: number | string): Promise<WalletAccountMultisigSquads>;
    /**
     * Returns the wallet account at a specific SLIP-0010 derivation path.
     *
     * @example
     * // Returns the account with derivation path m/44'/501'/0'/0'/1'
     * const account = await wallet.getAccountByPath("0'/0'/1'");
     * @param {string} path - The derivation path (e.g. "0'/0'").
     * @returns {Promise<WalletAccountMultisigSquads>} The account.
     */
    getAccountByPath(path: string): Promise<WalletAccountMultisigSquads>;
    /**
     * Returns the current fee rates.
     *
     * @returns {Promise<FeeRates>} The fee rates (in lamports).
     * @throws {ProviderRequiredError} A provider must be configured.
     */
    getFeeRates(): Promise<FeeRates>;
}
export type SolanaRpc = ReturnType<typeof import("@solana/rpc").createSolanaRpc>;
export type FeeRates = import("@tetherto/wdk-wallet").FeeRates;
export type MultisigSquadsWalletConfig = import("./wallet-account-read-only-multisig-squads.js").MultisigSquadsWalletConfig;
import WalletManager from '@tetherto/wdk-wallet';
import WalletAccountMultisigSquads from './wallet-account-multisig-squads.js';
