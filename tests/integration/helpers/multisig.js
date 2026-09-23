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

import { randomBytes } from 'node:crypto'

import { createSolanaRpc } from '@solana/rpc'

import WalletManagerMultisigSquads from '@tetherto/wdk-wallet-multisig-squads'

import { LAMPORTS_PER_SOL, airdrop, confirmTransaction } from './chain.js'

const SEED_PHRASE =
  'test walk nut penalty hip pave soap entry language right filter choice'

const TEST_RPC_URL = 'http://127.0.0.1:8899'

const CREATE_KEY_SIZE = 32
const SIGNER_FUNDING = LAMPORTS_PER_SOL

/**
 * @param {string[]} addresses
 * @returns {string[]}
 */
export function sorted (addresses) {
  return [...addresses].sort()
}

/**
 * @param {{ members?: number, config?: object }} [options]
 * @returns {Promise<{ manager: object, accounts: object[], signers: string[] }>}
 */
export async function createWallet (options = {}) {
  const { members = 1, config: extraConfig = {} } = options

  const manager = new WalletManagerMultisigSquads(SEED_PHRASE, {
    provider: TEST_RPC_URL,
    commitment: 'confirmed',
    createKeySecret: new Uint8Array(randomBytes(CREATE_KEY_SIZE)),
    ...extraConfig
  })
  const accounts = []

  for (let index = 0; index < members; index++) {
    accounts.push(await manager.getAccount(index))
  }

  const signers = await Promise.all(accounts.map((account) => account.getSignerAddress()))

  return { manager, accounts, signers }
}

/**
 * @param {{ members?: number, threshold?: number, fundVault?: bigint, fundSigners?: bigint, config?: object }} [options]
 * @returns {Promise<{ manager: object, accounts: object[], signers: string[], multisigPda: string, vaultPda: string, rpc: object, deployHash: string }>}
 */
export async function deployMultisig (options = {}) {
  const {
    members = 2,
    threshold = members,
    fundVault = 0n,
    fundSigners = SIGNER_FUNDING,
    config = {}
  } = options

  const rpc = createSolanaRpc(TEST_RPC_URL)
  const wallet = await createWallet({ members, config })

  if (fundSigners > 0n) {
    for (const signer of wallet.signers) {
      await airdrop(rpc, signer, fundSigners)
    }
  }

  const [deployer] = wallet.accounts
  const { hash } = await deployer.deploy(wallet.signers, threshold)

  await confirmTransaction(rpc, hash)

  const multisigPda = await deployer.getAddress()
  const vaultPda = await deployer.getVaultAddress(0)

  if (fundVault > 0n) {
    await airdrop(rpc, vaultPda, fundVault)
  }

  return { ...wallet, multisigPda, vaultPda, rpc, deployHash: hash }
}

/**
 * @param {object[]} accounts
 * @param {string | number | bigint} proposalId
 * @param {object} rpc
 * @returns {Promise<object[]>}
 */
export async function approveWithAll (accounts, proposalId, rpc) {
  const results = []

  for (const account of accounts) {
    const result = await account.approveProposal(proposalId)

    await confirmTransaction(rpc, result.transaction.hash)
    results.push(result)
  }

  return results
}
