/**
 * Wallet manager for Solana Squads multisig wallets.
 *
 * @extends {WalletManager<ISignerSolana>}
 */
export default class WalletManagerMultisigSquads extends WalletManager<import("@tetherto/wdk-wallet-solana/signers").ISignerSolana> {
    /**
     * Creates a new wallet manager for Solana Squads multisig wallets from a seed. The manager wraps
     * the seed in a signer at "m/44'/501'", owns it, and wipes it on {@link dispose}.
     *
     * @overload
     * @param {string | Uint8Array} seed - A [BIP-39](https://github.com/bitcoin/bips/blob/master/bip-0039.mediawiki) mnemonic seed phrase, or a raw BIP-32 master seed (16-64 bytes).
     * @param {MultisigSquadsWalletConfig} [config] - The configuration object (default: {}).
     */
    constructor(seed: string | Uint8Array, config?: MultisigSquadsWalletConfig);
    /**
     * Creates a new wallet manager for Solana Squads multisig wallets from a derivable default
     * signer, which the manager never disposes.
     *
     * @overload
     * @param {ISignerSolana} signer - The default root signer.
     * @param {MultisigSquadsWalletConfig} [config] - The configuration object (default: {}).
     */
    constructor(signer: ISignerSolana, config?: MultisigSquadsWalletConfig);
    /** @private */
    private _shouldWipeDefaultSignerOnDisposal;
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
     * @overload
     * @param {number} [index] - The index of the account to get (default: 0).
     * @param {Object} [options] - Account options.
     * @param {string} [options.signerName] - The signer name. Omit to use the default signer.
     * @returns {Promise<WalletAccountMultisigSquads>} The account.
     */
    getAccount(index?: number, options?: {
        signerName?: string;
    }): Promise<WalletAccountMultisigSquads>;
    /**
     * Returns the wallet account backed by a registered signer, without further derivation.
     *
     * @example
     * wallet.addSigner('treasury', new PrivateKeySignerSolana(privateKey))
     * const account = await wallet.getAccount('treasury');
     * @overload
     * @param {string} signerName - The signer name registered via {@link addSigner}.
     * @returns {Promise<WalletAccountMultisigSquads>} The account.
     */
    getAccount(signerName: string): Promise<WalletAccountMultisigSquads>;
    /**
     * Returns the wallet account at a specific SLIP-0010 derivation path.
     *
     * @example
     * // Returns the account with derivation path m/44'/501'/0'/0'/1'
     * const account = await wallet.getAccountByPath("0'/0'/1'");
     * @param {string} path - The derivation path (e.g. "0'/0'").
     * @param {Object} [options] - Account options.
     * @param {string} [options.signerName] - The signer name. Omit to use the default signer.
     * @returns {Promise<WalletAccountMultisigSquads>} The account.
     */
    getAccountByPath(path: string, options?: {
        signerName?: string;
    }): Promise<WalletAccountMultisigSquads>;
}
export type SolanaRpc = ReturnType<typeof import("@solana/rpc").createSolanaRpc>;
export type FeeRates = import("@tetherto/wdk-wallet").FeeRates;
export type ISignerSolana = import("@tetherto/wdk-wallet-solana/signers").ISignerSolana;
export type MultisigSquadsWalletConfig = import("./wallet-account-read-only-multisig-squads.js").MultisigSquadsWalletConfig;
import WalletManager from '@tetherto/wdk-wallet';
import WalletAccountMultisigSquads from './wallet-account-multisig-squads.js';
