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

import WalletManager, { ProviderRequiredError } from '@tetherto/wdk-wallet'

import { SeedSignerSolana } from '@tetherto/wdk-wallet-solana/signers'

import WalletAccountMultisigSquads from './wallet-account-multisig-squads.js'

import { SIGNATURE_BASE_FEE } from './wallet-account-read-only-multisig-squads.js'

/** @typedef {ReturnType<typeof import('@solana/rpc').createSolanaRpc>} SolanaRpc */

/** @typedef {import('@tetherto/wdk-wallet').FeeRates} FeeRates */

/** @typedef {import('@tetherto/wdk-wallet-solana/signers').ISignerSolana} ISignerSolana */

/** @typedef {import('./wallet-account-read-only-multisig-squads.js').MultisigSquadsWalletConfig} MultisigSquadsWalletConfig */

const FEE_RATE_MULTIPLIER = { normal: 110n, fast: 200n }

/**
 * Wallet manager for Solana Squads multisig wallets.
 *
 * @extends {WalletManager<ISignerSolana>}
 */
export default class WalletManagerMultisigSquads extends WalletManager {
  /**
   * Creates a new wallet manager for Solana Squads multisig wallets from a seed. The manager wraps
   * the seed in a signer at "m/44'/501'", owns it, and wipes it on {@link dispose}.
   *
   * @overload
   * @param {string | Uint8Array} seed - A [BIP-39](https://github.com/bitcoin/bips/blob/master/bip-0039.mediawiki) mnemonic seed phrase, or a raw BIP-32 master seed (16-64 bytes).
   * @param {MultisigSquadsWalletConfig} [config] - The configuration object (default: {}).
   */

  /**
   * Creates a new wallet manager for Solana Squads multisig wallets from a derivable default
   * signer, which the manager never disposes.
   *
   * @overload
   * @param {ISignerSolana} signer - The default root signer.
   * @param {MultisigSquadsWalletConfig} [config] - The configuration object (default: {}).
   */
  constructor (seedOrSigner, config = {}) {
    const isSeed = typeof seedOrSigner === 'string' || seedOrSigner instanceof Uint8Array

    super(isSeed ? new SeedSignerSolana(seedOrSigner) : seedOrSigner, config)

    /** @private */
    this._shouldWipeDefaultSignerOnDisposal = isSeed

    /**
     * The multisig Squads configuration.
     *
     * @protected
     * @type {MultisigSquadsWalletConfig}
     */
    this._config = config

    /**
     * A Solana RPC client for HTTP requests.
     *
     * @protected
     * @type {SolanaRpc | undefined}
     */
    this._rpc = WalletAccountMultisigSquads.createRpc(config)
  }

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
  async getAccount (indexOrSignerName = 0, options = {}) {
    if (typeof indexOrSignerName === 'string') {
      if (!this._accounts[indexOrSignerName]) {
        this._accounts[indexOrSignerName] =
          new WalletAccountMultisigSquads(this.getSigner(indexOrSignerName), this._config)
      }

      return this._accounts[indexOrSignerName]
    }

    return await this.getAccountByPath(`${indexOrSignerName}'/0'`, options)
  }

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
  async getAccountByPath (path, options = {}) {
    const { signerName } = options
    const key = signerName === undefined ? path : `${signerName}:${path}`

    if (!this._accounts[key]) {
      const signer = await this.getSigner(signerName).derive(path)

      this._accounts[key] = new WalletAccountMultisigSquads(
        signer, { ...this._config, shouldWipeSignerOnDisposal: true }
      )
    }

    return this._accounts[key]
  }

  /**
   * Returns the current fee rates.
   *
   * @returns {Promise<FeeRates>} The fee rates (in lamports).
   * @throws {ProviderRequiredError} A provider must be configured.
   */
  async getFeeRates () {
    if (!this._rpc) {
      throw new ProviderRequiredError('The wallet must be connected to a provider to get fee rates.')
    }

    const fees = await this._rpc.getRecentPrioritizationFees().send()

    const nonZeroFees = fees
      .filter((fee) => fee.prioritizationFee > 0)
      .map((fee) => BigInt(fee.prioritizationFee))

    const fee =
      nonZeroFees.length > 0
        ? nonZeroFees.reduce((max, fee) => (fee > max ? fee : max), 0n)
        : SIGNATURE_BASE_FEE

    return {
      normal: (fee * FEE_RATE_MULTIPLIER.normal) / 100n,
      fast: (fee * FEE_RATE_MULTIPLIER.fast) / 100n
    }
  }

  /**
   * Disposes all wallet accounts, and the default signer if the manager built it from a seed.
   */
  dispose () {
    if (this._shouldWipeDefaultSignerOnDisposal) {
      this._defaultSigner.dispose()
    }

    super.dispose()
  }
}
