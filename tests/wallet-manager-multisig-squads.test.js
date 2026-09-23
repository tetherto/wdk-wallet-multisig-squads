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

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals'

import { ProviderRequiredError, ValueError } from '@tetherto/wdk-wallet'

import WalletManagerMultisigSquads, {
  WalletAccountMultisigSquads
} from '@tetherto/wdk-wallet-multisig-squads'

import { stubSolanaRpc } from './helpers/rpc.js'

const TEST_SEED_PHRASE =
  'test walk nut penalty hip pave soap entry language right filter choice'
const TEST_RPC_URL = 'https://dummy-url.com'
const TEST_RPC_URL_FALLBACK = 'https://dummy-url-fallback.com'

const DUMMY_FEES = [{ slot: 1, prioritizationFee: 1000 }]

// The signer key TEST_SEED_PHRASE derives at 0'/0', which three suites need.
const SIGNER_0 = '3uXqWpwgqKVdiHAwF6Vmu4G4vdQzpR66xjPkz1G7zMKE'

describe('WalletManagerMultisigSquads', () => {
  let wallet

  beforeEach(() => {
    wallet = new WalletManagerMultisigSquads(TEST_SEED_PHRASE, {
      provider: TEST_RPC_URL,
      commitment: 'confirmed'
    })
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  describe('Constructor', () => {
    it('should send requests to the configured provider', async () => {
      const fetchMock = stubSolanaRpc({ getRecentPrioritizationFees: () => DUMMY_FEES })

      expect(await wallet.getFeeRates()).toEqual({ normal: 1100n, fast: 2000n })
      expect(String(fetchMock.mock.calls[0][0])).toBe(TEST_RPC_URL)
    })

    it('should create wallet manager with string seed phrase', () => {
      const newWallet = new WalletManagerMultisigSquads(TEST_SEED_PHRASE, {
        provider: TEST_RPC_URL
      })

      expect(newWallet).toBeInstanceOf(WalletManagerMultisigSquads)
    })

    it('should reject an invalid seed phrase', () => {
      expect(() => new WalletManagerMultisigSquads('not a seed phrase', {
        provider: TEST_RPC_URL
      })).toThrow(new ValueError('Invalid seed phrase.'))
    })

    it('should send requests to the first of several providers', async () => {
      const newWallet = new WalletManagerMultisigSquads(TEST_SEED_PHRASE, {
        provider: [TEST_RPC_URL, TEST_RPC_URL_FALLBACK]
      })
      const fetchMock = stubSolanaRpc({ getRecentPrioritizationFees: () => DUMMY_FEES })

      await newWallet.getFeeRates()

      expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([TEST_RPC_URL])
    })

    // The failover proxy wraps the request builder, not the `.send()` that performs the call, so
    // the second provider is never tried. Delete the `.failing` when that is fixed: this test then
    // reports the fix by failing.
    it.failing('should fall back when the first provider is unreachable', async () => {
      const newWallet = new WalletManagerMultisigSquads(TEST_SEED_PHRASE, {
        provider: [TEST_RPC_URL, TEST_RPC_URL_FALLBACK]
      })

      jest.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
        if (String(url) === TEST_RPC_URL) {
          throw new Error('the first provider is unreachable')
        }

        return Response.json({ jsonrpc: '2.0', id: JSON.parse(init.body).id, result: DUMMY_FEES })
      })

      expect(await newWallet.getFeeRates()).toEqual({ normal: 1100n, fast: 2000n })
    })
  })

  describe('getAccount', () => {
    const SIGNER_1 = 'CfGcujEkPVDx7yGyn1PUjxn2e353MXbLk8ixzwuJUktK'

    it('should return account at index 0', async () => {
      const account = await wallet.getAccount(0)

      expect(account).toBeInstanceOf(WalletAccountMultisigSquads)
      expect(account.index).toBe(0)
      expect(account.path).toBe("m/44'/501'/0'/0'")
    })

    it('should default to index 0', async () => {
      const account = await wallet.getAccount()

      expect(account.path).toBe("m/44'/501'/0'/0'")
    })

    it('should derive a different signer for each index', async () => {
      expect(await (await wallet.getAccount(0)).getSignerAddress()).toBe(SIGNER_0)
      expect(await (await wallet.getAccount(1)).getSignerAddress()).toBe(SIGNER_1)
    })

    it('should handle large index numbers', async () => {
      const account = await wallet.getAccount(999)

      expect(account.index).toBe(999)
      expect(account.path).toBe("m/44'/501'/999'/0'")
    })

    it('should return the same account for the same index', async () => {
      expect(await wallet.getAccount(0)).toBe(await wallet.getAccount(0))
    })
  })

  describe('getAccountByPath', () => {
    const SIGNER_0_0 = 'DPGHHHMaayXkaThUJCUnUAJCdgc9sxNh1UEGa6vJximM'
    const SIGNER_0_1 = 'jbhYXhWfRPqPvaKqaWCJEgBdZMquFxUvjWaWLEH3YCz'

    it("should return account for path \"0'/0'/0'\"", async () => {
      const account = await wallet.getAccountByPath("0'/0'/0'")

      expect(account).toBeInstanceOf(WalletAccountMultisigSquads)
      expect(account.path).toBe("m/44'/501'/0'/0'/0'")
    })

    it('should return the same account for the same path', async () => {
      expect(await wallet.getAccountByPath("0'/0'")).toBe(await wallet.getAccountByPath("0'/0'"))
    })

    it('should derive a different signer for each path', async () => {
      expect(await (await wallet.getAccountByPath("0'/0'/0'")).getSignerAddress())
        .toBe(SIGNER_0_0)
      expect(await (await wallet.getAccountByPath("0'/0'/1'")).getSignerAddress())
        .toBe(SIGNER_0_1)
    })
  })

  describe('getFeeRates', () => {
    const DUMMY_ASCENDING_FEES = [
      { slot: 1, prioritizationFee: 1000 },
      { slot: 2, prioritizationFee: 2000 },
      { slot: 3, prioritizationFee: 3000 }
    ]

    // The highest fee is in the middle, so taking the last one would look right at a glance.
    const DUMMY_UNSORTED_FEES = [
      { slot: 1, prioritizationFee: 1000 },
      { slot: 2, prioritizationFee: 5000 },
      { slot: 3, prioritizationFee: 3000 }
    ]

    const DUMMY_ZERO_FEES = [
      { slot: 1, prioritizationFee: 0 },
      { slot: 2, prioritizationFee: 0 }
    ]

    it('should return fee rates with normal and fast', async () => {
      const fetchMock = stubSolanaRpc({ getRecentPrioritizationFees: () => DUMMY_ASCENDING_FEES })

      // The highest of the three fees, at 110% and 200%.
      expect(await wallet.getFeeRates()).toEqual({ normal: 3300n, fast: 6000n })

      // …from one query for the whole cluster's recent fees, not a per-account one.
      expect(fetchMock).toHaveBeenCalledTimes(1)

      const { method, params } = JSON.parse(fetchMock.mock.calls[0][1].body)

      expect({ method, params }).toEqual({ method: 'getRecentPrioritizationFees', params: [] })
    })

    it('should use highest prioritization fee when multiple fees returned', async () => {
      stubSolanaRpc({ getRecentPrioritizationFees: () => DUMMY_UNSORTED_FEES })

      const feeRates = await wallet.getFeeRates()

      expect(feeRates.normal).toBe(5500n)
      expect(feeRates.fast).toBe(10000n)
    })

    // The only test that shows the zero filter doing anything: with any non-zero fee present
    // the maximum is the same filtered or not, so a fixture like [0, 0, 2000] cannot tell.
    it('should use default fee when all fees are zero', async () => {
      stubSolanaRpc({ getRecentPrioritizationFees: () => DUMMY_ZERO_FEES })

      const feeRates = await wallet.getFeeRates()

      expect(feeRates.normal).toBe(5500n)
      expect(feeRates.fast).toBe(10000n)
    })

    it('should use default fee when no fees returned', async () => {
      stubSolanaRpc({ getRecentPrioritizationFees: () => [] })

      const feeRates = await wallet.getFeeRates()

      expect(feeRates.normal).toBe(5500n)
      expect(feeRates.fast).toBe(10000n)
    })

    it('should throw error when no RPC connection', async () => {
      const noRpcWallet = new WalletManagerMultisigSquads(TEST_SEED_PHRASE)

      await expect(noRpcWallet.getFeeRates()).rejects.toThrow(ProviderRequiredError)
      await expect(noRpcWallet.getFeeRates()).rejects.toThrow(
        'The wallet must be connected to a provider to get fee rates'
      )
    })

    it('should handle RPC errors gracefully', async () => {
      stubSolanaRpc({
        getRecentPrioritizationFees: () => { throw new Error('RPC connection failed') }
      })

      await expect(wallet.getFeeRates()).rejects.toThrow('RPC connection failed')
    })
  })

  describe('dispose', () => {
    // Ed25519 is deterministic, so SIGNER_0 signing 'after dispose' is a fixed value.
    const SIGNATURE_0 =
      '5dfaad6f72a44da4eb77af48def5476a64aeaa720be3a2be87151c6f08537a9b' +
      'd63c7f4ffa218d93b36a4457b2ba0d64907c1bc5ed31a2fdc3c1bd990dffa70c'

    it('should dispose the accounts it derived', async () => {
      const account = await wallet.getAccount()

      wallet.dispose()

      await expect(account.sign('after dispose'))
        .rejects.toThrow('The wallet account has been disposed.')
    })

    it('should clear the account cache', async () => {
      await wallet.getAccount()

      wallet.dispose()

      // A cached account would be the disposed one, and signing with it throws rather than
      // returning this signature.
      expect(await (await wallet.getAccount()).sign('after dispose')).toBe(SIGNATURE_0)
    })
  })
})
