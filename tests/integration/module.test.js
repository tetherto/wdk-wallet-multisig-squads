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

import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals'

import { ed25519 } from '@noble/curves/ed25519'
import { address, getAddressEncoder } from '@solana/addresses'
import { createSolanaRpc } from '@solana/rpc'
import { generateKeyPairSigner } from '@solana/signers'

import { NoSuchElementError, UnsupportedOperationError } from '@tetherto/wdk-wallet'
import { WalletAccountReadOnlySolana } from '@tetherto/wdk-wallet-solana'

import WalletManagerMultisigSquads, {
  SQUADS_PROGRAM_ADDRESS,
  WalletAccountReadOnlyMultisigSquads
} from '@tetherto/wdk-wallet-multisig-squads'

import {
  LAMPORTS_PER_SOL,
  airdrop,
  confirmTransaction,
  deployTestToken,
  sendTestTokensTo
} from './helpers/chain.js'
import { approveWithAll, createWallet, deployMultisig, sorted } from './helpers/multisig.js'
import { SQUADS_PROGRAM_CONFIG_ADDRESS, startSolanaTestValidator } from './helpers/validator.js'

jest.setTimeout(180_000)

const TEST_RPC_URL = 'http://127.0.0.1:8899'

// The signer keys the suite's seed phrase derives, and the rent the multisig account pays:
// measured against the validator, which is what `quoteDeploy` reads at run time.
const SIGNER_0 = '3uXqWpwgqKVdiHAwF6Vmu4G4vdQzpR66xjPkz1G7zMKE'
const SIGNER_1 = 'CfGcujEkPVDx7yGyn1PUjxn2e353MXbLk8ixzwuJUktK'
const MULTISIG_RENT = 2039280n

// What SIGNER_0's key signs 'hello' into: 64 bytes, lowercase hex, fixed by the seed phrase.
const SIGNED_HELLO =
  '484d6ed3113c38833d66d9fc6e4f31f9e71f146c781739ce8103a9ea6d671f92' +
  '63dd43b53be7f9dddfafed4d671fbd6e64b0c1599fdfa68a8f8e8d73b49e780c'

/**
 * Verifies a `sign()` result against an address, without going through the account: `verify` is
 * unsupported on a multisig, so the check has to come from outside the code under test.
 *
 * @param {string} signature - The signature, hex-encoded.
 * @param {string} message - The message that was signed.
 * @param {string} signerAddress - The address to verify against.
 * @returns {boolean} Whether the address signed the message.
 */
function verifyEd25519 (signature, message, signerAddress) {
  return ed25519.verify(
    Buffer.from(signature, 'hex'),
    new TextEncoder().encode(message),
    new Uint8Array(getAddressEncoder().encode(address(signerAddress)))
  )
}

/** @param {string} target */
function solanaAccount (target) {
  return new WalletAccountReadOnlySolana(target, {
    provider: TEST_RPC_URL,
    commitment: 'confirmed'
  })
}

describe('@tetherto/wdk-wallet-multisig-squads', () => {
  const rpc = createSolanaRpc(TEST_RPC_URL)

  let stopSolanaTestValidator

  beforeAll(async () => {
    stopSolanaTestValidator = await startSolanaTestValidator(rpc)
  })

  afterAll(async () => {
    if (stopSolanaTestValidator) {
      await stopSolanaTestValidator()
      stopSolanaTestValidator = undefined
    }
  })

  describe('module and localnet', () => {
    it('runs against a validator hosting the Squads program', async () => {
      const { value } = await rpc
        .getMultipleAccounts(
          [address(SQUADS_PROGRAM_ADDRESS), address(SQUADS_PROGRAM_CONFIG_ADDRESS)],
          { commitment: 'confirmed', encoding: 'base64' }
        )
        .send()

      const [program, programConfig] = value

      expect(program.executable).toBe(true)
      expect(programConfig.owner).toBe(SQUADS_PROGRAM_ADDRESS)
      expect(SQUADS_PROGRAM_ADDRESS).toBe('SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf')
    })

    it('derives an account per index from one manager', async () => {
      const wallet = new WalletManagerMultisigSquads(
        'test walk nut penalty hip pave soap entry language right filter choice',
        { provider: TEST_RPC_URL }
      )

      const [first, second] = await Promise.all([wallet.getAccount(0), wallet.getAccount(1)])

      // The keys TEST_SEED_PHRASE derives at 0'/0' and 1'/0'.
      expect(await first.getSignerAddress()).toBe(SIGNER_0)
      expect(await second.getSignerAddress()).toBe(SIGNER_1)
    })
  })

  describe('deploy', () => {
    it('creates a multisig at the address derived from the create key', async () => {
      const { accounts, signers } = await createWallet({ members: 1 })
      const [account] = accounts

      const derived = await account.getAddress()

      expect(await account.isDeployed()).toBe(false)

      await airdrop(rpc, signers[0], LAMPORTS_PER_SOL)

      const { hash } = await account.deploy(signers, 1)

      await confirmTransaction(rpc, hash)

      expect(await account.getAddress()).toBe(derived)
      expect(await account.isDeployed()).toBe(true)
      expect(await account.getMultisigInfo()).toMatchObject({
        owners: expect.arrayContaining(signers),
        threshold: 1
      })
      expect(await account.getNonce()).toBe(0n)
    })

    it('reports the same multisig from every member account', async () => {
      const { accounts, multisigPda } = await deployMultisig({ members: 3, threshold: 2 })

      const addresses = await Promise.all(accounts.map((account) => account.getAddress()))

      expect(addresses).toEqual([multisigPda, multisigPda, multisigPda])
    })

    it('gives every owner full permissions and reports them', async () => {
      const { accounts, signers } = await deployMultisig({ members: 2, threshold: 2 })

      const info = await accounts[0].getMultisigInfo()

      expect(sorted(info.owners)).toEqual(sorted(signers))
      expect(info).toMatchObject({ masks: [7, 7], threshold: 2 })
    })

    it('holds funds in the vault rather than the multisig account', async () => {
      const { accounts, multisigPda, vaultPda } = await deployMultisig({
        members: 1,
        threshold: 1,
        fundVault: LAMPORTS_PER_SOL
      })

      // The airdrop landed in the vault; the multisig account holds only its own rent.
      expect(await accounts[0].getBalance()).toBe(LAMPORTS_PER_SOL)
      expect(await solanaAccount(vaultPda).getBalance()).toBe(LAMPORTS_PER_SOL)
      expect(await solanaAccount(multisigPda).getBalance()).toBe(MULTISIG_RENT)
    })

    it('quotes a deploy that covers what the creator is actually debited', async () => {
      const { accounts, signers } = await createWallet({ members: 1 })
      const [account] = accounts

      await airdrop(rpc, signers[0], LAMPORTS_PER_SOL)

      const before = await solanaAccount(signers[0]).getBalance()
      const { fee } = await account.quoteDeploy(1)

      const { hash } = await account.deploy(signers, 1)

      await confirmTransaction(rpc, hash)

      const spent = before - (await solanaAccount(signers[0]).getBalance())

      expect(spent).toBe(fee)
    })

    it('quotes more rent for a larger member set', async () => {
      const { accounts } = await createWallet({ members: 1 })

      const [one, five] = await Promise.all([
        accounts[0].quoteDeploy(1),
        accounts[0].quoteDeploy(5)
      ])

      // Four more members at 33 bytes each, at the validator's 6960 lamports per byte.
      expect(five.fee - one.fee).toBe(4n * 33n * 6960n)
    })

    it('refuses to deploy the same multisig twice', async () => {
      const { accounts, signers } = await deployMultisig({ members: 1, threshold: 1 })

      await expect(accounts[0].deploy(signers, 1)).rejects.toThrow(/already exists/)
    })

    it('refuses a threshold above the number of owners', async () => {
      const { accounts, signers } = await createWallet({ members: 2 })

      await expect(accounts[0].deploy(signers, 3)).rejects.toThrow(
        'Invalid threshold 3. It must be an integer between 1 and the number of owners able to vote (2).'
      )
    })

    it('refuses to deploy without a create key secret', async () => {
      const { accounts, signers } = await createWallet({
        members: 1,
        config: { createKeySecret: undefined }
      })

      await expect(accounts[0].deploy(signers, 1)).rejects.toThrow(/createKeySecret/)
    })

    it('reads an existing multisig from its address alone', async () => {
      const { multisigPda, signers } = await deployMultisig({ members: 2, threshold: 2 })

      const { accounts } = await createWallet({
        members: 1,
        config: { multisigPdaOrCreateKey: multisigPda, createKeySecret: undefined }
      })

      expect(await accounts[0].getAddress()).toBe(multisigPda)
      expect(await accounts[0].isDeployed()).toBe(true)
      expect(sorted((await accounts[0].getMultisigInfo()).owners)).toEqual(sorted(signers))
    })
  })

  describe('SOL transfers', () => {
    const TRANSFER_AMOUNT = LAMPORTS_PER_SOL / 10n

    it('moves SOL out of the vault through the full proposal lifecycle', async () => {
      const multisig = await deployMultisig({
        members: 2,
        threshold: 2,
        fundVault: LAMPORTS_PER_SOL
      })
      const { accounts, signers, vaultPda } = multisig
      const recipient = (await generateKeyPairSigner()).address

      const proposal = await accounts[0].propose({
        to: recipient,
        value: TRANSFER_AMOUNT
      })

      await confirmTransaction(rpc, proposal.transaction.hash)

      expect(proposal).toEqual({
        proposalId: '1',
        confirmations: 0,
        pendingConfirmations: 0,
        threshold: 2,
        status: 'pending',
        // The signature fee plus the rent the transaction and proposal accounts lock up, which
        // is what a proposal actually costs. Exact for this message size and member count.
        transaction: { hash: proposal.transaction.hash, fee: 5000n + 5143440n }
      })
      expect(await accounts[0].getNonce()).toBe(1n)

      const created = await accounts[0].getProposal(proposal.proposalId)

      expect(created).toMatchObject({
        proposalId: '1',
        status: 'pending',
        statusName: 'Active',
        confirmations: 0,
        approved: [],
        rejected: []
      })
      expect(await accounts[0].isReadyToExecute(proposal.proposalId)).toBe(false)

      const [first, second] = await approveWithAll(accounts, proposal.proposalId, rpc)

      expect(first.confirmations).toBe(1)
      expect(second.confirmations).toBe(2)
      expect(second.status).toBe('pending')

      const approved = await accounts[0].getProposal(proposal.proposalId)

      expect(approved).toMatchObject({ status: 'pending', statusName: 'Approved', confirmations: 2 })
      expect(sorted(approved.approved)).toEqual(sorted(signers))
      expect(await accounts[0].isReadyToExecute(proposal.proposalId)).toBe(true)

      const vaultBefore = await solanaAccount(vaultPda).getBalance()
      const execution = await accounts[1].executeProposal(proposal.proposalId)

      await confirmTransaction(rpc, execution.hash)

      expect(await solanaAccount(recipient).getBalance()).toBe(TRANSFER_AMOUNT)
      expect(await solanaAccount(vaultPda).getBalance()).toBe(vaultBefore - TRANSFER_AMOUNT)

      const executed = await accounts[0].getProposal(proposal.proposalId)

      expect(executed.statusName).toBe('Executed')
      expect(await accounts[0].isReadyToExecute(proposal.proposalId)).toBe(false)
    })

    it('charges the executing member rather than the vault for the execution fee', async () => {
      const { accounts, signers, vaultPda } = await deployMultisig({
        members: 1,
        threshold: 1,
        fundVault: LAMPORTS_PER_SOL
      })
      const recipient = (await generateKeyPairSigner()).address

      const proposal = await accounts[0].propose({ to: recipient, value: TRANSFER_AMOUNT })

      await confirmTransaction(rpc, proposal.transaction.hash)
      await approveWithAll(accounts, proposal.proposalId, rpc)

      const signerBefore = await solanaAccount(signers[0]).getBalance()
      const vaultBefore = await solanaAccount(vaultPda).getBalance()

      const execution = await accounts[0].executeProposal(proposal.proposalId)

      await confirmTransaction(rpc, execution.hash)

      expect(await solanaAccount(vaultPda).getBalance()).toBe(vaultBefore - TRANSFER_AMOUNT)
      expect(await solanaAccount(signers[0]).getBalance()).toBe(signerBefore - execution.fee)
    })

    it('executes without a second round trip when autoExecute applies', async () => {
      const { accounts, vaultPda } = await deployMultisig({
        members: 1,
        threshold: 1,
        fundVault: LAMPORTS_PER_SOL
      })
      const recipient = (await generateKeyPairSigner()).address

      const proposal = await accounts[0].propose(
        { to: recipient, value: TRANSFER_AMOUNT },
        { autoExecute: true }
      )

      await confirmTransaction(rpc, proposal.transaction.hash)

      expect(proposal.status).toBe('executed')
      expect(proposal.confirmations).toBe(1)
      expect(await solanaAccount(recipient).getBalance()).toBe(TRANSFER_AMOUNT)
      expect(await solanaAccount(vaultPda).getBalance()).toBe(LAMPORTS_PER_SOL - TRANSFER_AMOUNT)

      const executed = await accounts[0].getProposal(proposal.proposalId)

      expect(executed.statusName).toBe('Executed')
    })

    it('ignores autoExecute when the threshold cannot be met by the proposer alone', async () => {
      const { accounts } = await deployMultisig({
        members: 2,
        threshold: 2,
        fundVault: LAMPORTS_PER_SOL
      })
      const recipient = (await generateKeyPairSigner()).address

      const proposal = await accounts[0].propose(
        { to: recipient, value: TRANSFER_AMOUNT },
        { autoExecute: true }
      )

      await confirmTransaction(rpc, proposal.transaction.hash)

      expect(proposal.status).toBe('pending')
      expect(await solanaAccount(recipient).getBalance()).toBe(0n)

      const pending = await accounts[0].getProposal(proposal.proposalId)

      expect(pending.statusName).toBe('Active')
    })

    it('numbers proposals by the multisig transaction index', async () => {
      const { accounts } = await deployMultisig({
        members: 1,
        threshold: 1,
        fundVault: LAMPORTS_PER_SOL
      })
      const recipient = (await generateKeyPairSigner()).address

      const first = await accounts[0].propose({ to: recipient, value: TRANSFER_AMOUNT })

      await confirmTransaction(rpc, first.transaction.hash)

      const second = await accounts[0].propose({ to: recipient, value: TRANSFER_AMOUNT })

      await confirmTransaction(rpc, second.transaction.hash)

      expect(first.proposalId).toBe('1')
      expect(second.proposalId).toBe('2')
      expect(await accounts[0].getNonce()).toBe(2n)

      const proposals = await accounts[0].getProposals(['1', '2', '3'])

      expect(proposals[1].statusName).toBe('Active')
      expect(proposals[2].statusName).toBe('Active')
      expect(proposals[3]).toBeNull()
    })

    it('quotes a transfer proposal before it is created', async () => {
      const { accounts } = await deployMultisig({ members: 2, threshold: 2 })
      const recipient = (await generateKeyPairSigner()).address

      const { fee } = await accounts[0].quotePropose({
        to: recipient,
        value: TRANSFER_AMOUNT
      })

      const before = await solanaAccount(await accounts[0].getSignerAddress()).getBalance()
      const proposal = await accounts[0].propose({ to: recipient, value: TRANSFER_AMOUNT })

      await confirmTransaction(rpc, proposal.transaction.hash)

      const after = await solanaAccount(await accounts[0].getSignerAddress()).getBalance()

      // The quote covers the rent for both accounts plus the signature, which is exactly what
      // the proposer pays.
      expect(before - after).toBe(fee)
    })

    it('fails execution when the vault cannot cover the transfer', async () => {
      const { accounts } = await deployMultisig({ members: 1, threshold: 1 })
      const recipient = (await generateKeyPairSigner()).address

      const proposal = await accounts[0].propose({ to: recipient, value: TRANSFER_AMOUNT })

      await confirmTransaction(rpc, proposal.transaction.hash)
      await approveWithAll(accounts, proposal.proposalId, rpc)

      // Preflight rejects it at send time, and a node without preflight would reject it at
      // confirmation — either way the proposal stays approved and nothing leaves the vault.
      const error = await accounts[0].executeProposal(proposal.proposalId)
        .then((result) => confirmTransaction(rpc, result.hash))
        .catch((thrown) => thrown)

      // The vault holds no lamports, so the inner transfer cannot be simulated. The node
      // rejects it before it reaches a block, which is what keeps the vault intact below.
      expect(String(error)).toMatch(/Transaction simulation failed/)

      expect(await solanaAccount(recipient).getBalance()).toBe(0n)

      const stillApproved = await accounts[0].getProposal(proposal.proposalId)

      expect(stillApproved.statusName).toBe('Approved')
    })
  })

  describe('SPL token transfers', () => {
    const MINT_AMOUNT = 1_000_000n
    const TRANSFER_AMOUNT = 250_000n

    let testToken

    // A mint per test: the four tests below each move tokens, and a shared mint authority is
    // shared mutable state. Deploying one costs a couple of transactions against a localnet.
    beforeEach(async () => {
      testToken = await deployTestToken(rpc)
    })

    it('reads a vault token balance from its associated token account', async () => {
      const { accounts, vaultPda } = await deployMultisig({ members: 1, threshold: 1 })

      expect(await accounts[0].getTokenBalance(testToken.mint)).toBe(0n)

      await sendTestTokensTo(rpc, testToken, vaultPda, MINT_AMOUNT)

      expect(await accounts[0].getTokenBalance(testToken.mint)).toBe(MINT_AMOUNT)
    })

    it('transfers tokens out of the vault through the full proposal lifecycle', async () => {
      const { accounts, vaultPda } = await deployMultisig({
        members: 2,
        threshold: 2,
        fundVault: LAMPORTS_PER_SOL
      })
      const recipient = (await generateKeyPairSigner()).address

      await sendTestTokensTo(rpc, testToken, vaultPda, MINT_AMOUNT)

      const proposal = await accounts[0].proposeTransfer({
        token: testToken.mint,
        recipient,
        amount: TRANSFER_AMOUNT
      })

      await confirmTransaction(rpc, proposal.transaction.hash)

      expect(proposal).toEqual({
        proposalId: '1',
        confirmations: 0,
        pendingConfirmations: 0,
        threshold: 2,
        status: 'pending',
        // The signature fee plus the rent the transaction and proposal accounts lock up. Larger
        // than the SOL case because an SPL transfer stores a longer message.
        transaction: { hash: proposal.transaction.hash, fee: 5000n + 6354480n }
      })

      await approveWithAll(accounts, proposal.proposalId, rpc)

      expect(await accounts[0].isReadyToExecute(proposal.proposalId)).toBe(true)

      const execution = await accounts[1].executeProposal(proposal.proposalId)

      await confirmTransaction(rpc, execution.hash)

      // Both sides read through the sibling package, so the SUT does not confirm its own work.
      expect(await solanaAccount(vaultPda).getTokenBalance(testToken.mint))
        .toBe(MINT_AMOUNT - TRANSFER_AMOUNT)
      expect(await solanaAccount(recipient).getTokenBalance(testToken.mint)).toBe(TRANSFER_AMOUNT)
    })

    it('creates the recipient token account at execution, paid by the vault', async () => {
      const { accounts, vaultPda } = await deployMultisig({
        members: 1,
        threshold: 1,
        fundVault: LAMPORTS_PER_SOL
      })
      const recipient = (await generateKeyPairSigner()).address

      await sendTestTokensTo(rpc, testToken, vaultPda, MINT_AMOUNT)

      expect(await solanaAccount(recipient).getTokenBalance(testToken.mint)).toBe(0n)

      const proposal = await accounts[0].proposeTransfer(
        { token: testToken.mint, recipient, amount: TRANSFER_AMOUNT },
        { autoExecute: true }
      )

      await confirmTransaction(rpc, proposal.transaction.hash)

      expect(proposal.status).toBe('executed')
      expect(await solanaAccount(recipient).getTokenBalance(testToken.mint)).toBe(TRANSFER_AMOUNT)
    })

    it('quotes a token transfer', async () => {
      const { accounts } = await deployMultisig({ members: 2, threshold: 2 })
      const recipient = (await generateKeyPairSigner()).address

      const { fee } = await accounts[0].quoteTransfer({
        token: testToken.mint,
        recipient,
        amount: TRANSFER_AMOUNT
      })

      const before = await solanaAccount(await accounts[0].getSignerAddress()).getBalance()
      const proposal = await accounts[0].proposeTransfer({
        token: testToken.mint,
        recipient,
        amount: TRANSFER_AMOUNT
      })

      await confirmTransaction(rpc, proposal.transaction.hash)

      const after = await solanaAccount(await accounts[0].getSignerAddress()).getBalance()

      expect(before - after).toBe(fee)
    })

    it('refuses to propose a transfer of a mint that does not exist', async () => {
      const { accounts } = await deployMultisig({ members: 1, threshold: 1 })
      const missing = (await generateKeyPairSigner()).address
      const recipient = (await generateKeyPairSigner()).address

      await expect(
        accounts[0].proposeTransfer({ token: missing, recipient, amount: TRANSFER_AMOUNT })
      ).rejects.toThrow(/does not exist/)
    })
  })

  describe('voting', () => {
    const TRANSFER_AMOUNT = LAMPORTS_PER_SOL / 100n

    async function propose (multisig, proposer = 0) {
      const recipient = (await generateKeyPairSigner()).address
      const proposal = await multisig.accounts[proposer].propose({
        to: recipient,
        value: TRANSFER_AMOUNT
      })

      await confirmTransaction(multisig.rpc, proposal.transaction.hash)

      return { ...proposal, recipient }
    }

    it('counts approvals and lists the members who cast them', async () => {
      const multisig = await deployMultisig({
        members: 3,
        threshold: 2,
        fundVault: LAMPORTS_PER_SOL
      })
      const { accounts, signers } = multisig
      const proposal = await propose(multisig)

      const first = await accounts[0].approveProposal(proposal.proposalId)

      await confirmTransaction(rpc, first.transaction.hash)

      const afterOne = await accounts[0].getProposal(proposal.proposalId)

      expect(afterOne).toMatchObject({
        status: 'pending',
        statusName: 'Active',
        confirmations: 1,
        approved: [signers[0]]
      })

      const second = await accounts[1].approveProposal(proposal.proposalId)

      await confirmTransaction(rpc, second.transaction.hash)

      const afterTwo = await accounts[0].getProposal(proposal.proposalId)

      expect(afterTwo).toMatchObject({ status: 'pending', statusName: 'Approved', confirmations: 2 })
      expect(sorted(afterTwo.approved)).toEqual(sorted([signers[0], signers[1]]))
    })

    it('records a rejection and ends the proposal once approval is unreachable', async () => {
      const multisig = await deployMultisig({
        members: 2,
        threshold: 2,
        fundVault: LAMPORTS_PER_SOL
      })
      const { accounts, signers } = multisig
      const proposal = await propose(multisig)

      const rejection = await accounts[1].rejectProposal(proposal.proposalId)

      await confirmTransaction(rpc, rejection.transaction.hash)

      expect(rejection.confirmations).toBe(0)

      const rejected = await accounts[0].getProposal(proposal.proposalId)

      expect(rejected).toMatchObject({ statusName: 'Rejected', rejected: [signers[1]] })
      expect(await accounts[0].isReadyToExecute(proposal.proposalId)).toBe(false)
      await expect(accounts[0].executeProposal(proposal.proposalId)).rejects.toThrow(/rejected/)
    })

    it('lets a member replace an approval with a rejection', async () => {
      const multisig = await deployMultisig({
        members: 3,
        threshold: 3,
        fundVault: LAMPORTS_PER_SOL
      })
      const { accounts, signers } = multisig
      const proposal = await propose(multisig)

      const approval = await accounts[0].approveProposal(proposal.proposalId)

      await confirmTransaction(rpc, approval.transaction.hash)

      const rejection = await accounts[0].rejectProposal(proposal.proposalId)

      await confirmTransaction(rpc, rejection.transaction.hash)

      // The rejection withdraws the approval, so the count goes down rather than up.
      expect(rejection.confirmations).toBe(0)

      const voted = await accounts[0].getProposal(proposal.proposalId)

      expect(voted.approved).toEqual([])
      expect(voted.rejected).toEqual([signers[0]])
    })

    it('records a memo alongside a vote', async () => {
      const multisig = await deployMultisig({
        members: 2,
        threshold: 2,
        fundVault: LAMPORTS_PER_SOL
      })
      const { accounts } = multisig
      const proposal = await propose(multisig)

      const approval = await accounts[0].approveProposal(proposal.proposalId, { memo: 'looks good' })

      await confirmTransaction(rpc, approval.transaction.hash)

      const voted = await accounts[0].getProposal(proposal.proposalId)

      expect(voted.confirmations).toBe(1)
    })

    it('refuses a second approval from the same member', async () => {
      const multisig = await deployMultisig({
        members: 2,
        threshold: 2,
        fundVault: LAMPORTS_PER_SOL
      })
      const { accounts } = multisig
      const proposal = await propose(multisig)

      const approval = await accounts[0].approveProposal(proposal.proposalId)

      await confirmTransaction(rpc, approval.transaction.hash)

      await expect(accounts[0].approveProposal(proposal.proposalId)).rejects.toThrow(/already approved/)
    })

    it('refuses a vote from a non-member', async () => {
      const multisig = await deployMultisig({
        members: 1,
        threshold: 1,
        fundVault: LAMPORTS_PER_SOL
      })
      const proposal = await propose(multisig)

      // Account 1 shares the create key, so it addresses the same multisig, but its signer
      // was never made a member.
      const outsider = await multisig.manager.getAccount(1)

      const outsiderAddress = await outsider.getSignerAddress()

      await expect(outsider.approveProposal(proposal.proposalId))
        .rejects.toThrow(`The signer ${outsiderAddress} is not a member of the multisig`)
      await expect(outsider.propose({ to: proposal.recipient, value: 1n }))
        .rejects.toThrow(`The signer ${outsiderAddress} is not a member of the multisig`)
    })

    it('refuses to execute a proposal that has not been approved', async () => {
      const multisig = await deployMultisig({
        members: 2,
        threshold: 2,
        fundVault: LAMPORTS_PER_SOL
      })
      const { accounts } = multisig
      const proposal = await propose(multisig)

      await expect(accounts[0].executeProposal(proposal.proposalId)).rejects.toThrow(/holds 0 of the 2 approvals it needs to execute/)
    })

    it('refuses to execute a proposal twice', async () => {
      const multisig = await deployMultisig({
        members: 1,
        threshold: 1,
        fundVault: LAMPORTS_PER_SOL
      })
      const { accounts } = multisig
      const proposal = await propose(multisig)

      await approveWithAll(accounts, proposal.proposalId, rpc)

      const execution = await accounts[0].executeProposal(proposal.proposalId)

      await confirmTransaction(rpc, execution.hash)

      await expect(accounts[0].executeProposal(proposal.proposalId)).rejects.toThrow(/executed/)
    })

    it('reports nothing for a proposal id that was never used', async () => {
      const { accounts } = await deployMultisig({ members: 1, threshold: 1 })

      expect(await accounts[0].getProposal(99)).toBeNull()
      expect(await accounts[0].isReadyToExecute(99)).toBe(false)
      await expect(accounts[0].executeProposal(99)).rejects.toThrow(/no proposal/)
    })
  })

  describe('configuration changes', () => {
    async function settle (multisig, proposalId, voters = multisig.accounts) {
      await approveWithAll(voters, proposalId, multisig.rpc)

      const execution = await voters[0].executeProposal(proposalId)

      await confirmTransaction(multisig.rpc, execution.hash)

      return execution
    }

    it('adds an owner once the proposal is approved and executed', async () => {
      const multisig = await deployMultisig({ members: 1, threshold: 1 })
      const { accounts, signers } = multisig
      const newOwner = (await generateKeyPairSigner()).address

      const proposal = await accounts[0].addOwner(newOwner)

      await confirmTransaction(rpc, proposal.transaction.hash)

      // Proposing is not applying: the member set is unchanged until execution.
      expect(sorted((await accounts[0].getMultisigInfo()).owners)).toEqual(sorted(signers))

      await settle(multisig, proposal.proposalId)

      const info = await accounts[0].getMultisigInfo()

      expect(sorted(info.owners)).toEqual(sorted([...signers, newOwner]))
      expect(info.masks).toEqual([7, 7])
      expect(info.threshold).toBe(1)
    })

    it('adds an owner and raises the threshold in one proposal', async () => {
      const multisig = await deployMultisig({ members: 1, threshold: 1 })
      const { accounts, signers } = multisig
      const newOwner = (await generateKeyPairSigner()).address

      const proposal = await accounts[0].addOwner(newOwner, { threshold: 2 })

      await confirmTransaction(rpc, proposal.transaction.hash)
      await settle(multisig, proposal.proposalId)

      const info = await accounts[0].getMultisigInfo()

      expect(sorted(info.owners)).toEqual(sorted([...signers, newOwner]))
      expect(info.threshold).toBe(2)
    })

    it('removes an owner and lowers the threshold in one proposal', async () => {
      const multisig = await deployMultisig({ members: 3, threshold: 3 })
      const { accounts, signers } = multisig

      const proposal = await accounts[0].removeOwner(signers[2], { threshold: 2 })

      await confirmTransaction(rpc, proposal.transaction.hash)
      await settle(multisig, proposal.proposalId)

      const info = await accounts[0].getMultisigInfo()

      expect(sorted(info.owners)).toEqual(sorted([signers[0], signers[1]]))
      expect(info.threshold).toBe(2)
    })

    it('swaps one owner for another atomically', async () => {
      const multisig = await deployMultisig({ members: 2, threshold: 2 })
      const { accounts, signers } = multisig
      const newOwner = (await generateKeyPairSigner()).address

      const proposal = await accounts[0].swapOwner(signers[1], newOwner)

      await confirmTransaction(rpc, proposal.transaction.hash)
      await settle(multisig, proposal.proposalId)

      const info = await accounts[0].getMultisigInfo()

      expect(info.owners).toContain(signers[0])
      expect(info.owners).toContain(newOwner)
      expect(info.owners).not.toContain(signers[1])
      expect(info.threshold).toBe(2)
    })

    it('changes the threshold', async () => {
      const multisig = await deployMultisig({ members: 3, threshold: 3 })
      const { accounts } = multisig

      const proposal = await accounts[0].changeThreshold(2)

      await confirmTransaction(rpc, proposal.transaction.hash)
      await settle(multisig, proposal.proposalId)

      expect((await accounts[0].getMultisigInfo()).threshold).toBe(2)
    })

    it('executes a config proposal through executeProposal without a kind hint', async () => {
      const multisig = await deployMultisig({ members: 1, threshold: 1 })
      const { accounts } = multisig
      const recipient = (await generateKeyPairSigner()).address
      const newOwner = (await generateKeyPairSigner()).address

      // A vault proposal and a config proposal share one index space, so executeProposal has to
      // discriminate them from the account data alone.
      const vault = await accounts[0].propose({ to: recipient, value: 1n })

      await confirmTransaction(rpc, vault.transaction.hash)

      const config = await accounts[0].addOwner(newOwner)

      await confirmTransaction(rpc, config.transaction.hash)

      expect(config.proposalId).toBe('2')

      await settle(multisig, config.proposalId)

      const executed = await accounts[0].getProposal(config.proposalId)

      expect(executed.statusName).toBe('Executed')
    })

    it('invalidates pending proposals when a config change executes', async () => {
      const multisig = await deployMultisig({
        members: 2,
        threshold: 2,
        fundVault: LAMPORTS_PER_SOL
      })
      const { accounts } = multisig
      const recipient = (await generateKeyPairSigner()).address

      const pending = await accounts[0].propose({ to: recipient, value: 1n })

      await confirmTransaction(rpc, pending.transaction.hash)

      const config = await accounts[0].changeThreshold(1)

      await confirmTransaction(rpc, config.transaction.hash)
      await settle(multisig, config.proposalId)

      // The executed config change bumped staleTransactionIndex past the pending proposal,
      // so it can no longer collect votes.
      await expect(accounts[0].approveProposal(pending.proposalId)).rejects.toThrow(
        'was invalidated by a later configuration change and can no longer be voted on'
      )

      const stale = await accounts[0].getProposal(pending.proposalId)

      expect(stale.statusName).toBe('Active')
      expect(await accounts[0].isReadyToExecute(pending.proposalId)).toBe(false)
    })

    it('refuses to add an owner that is already a member', async () => {
      const { accounts, signers } = await deployMultisig({ members: 2, threshold: 2 })

      await expect(accounts[0].addOwner(signers[1]))
        .rejects.toThrow(`The address ${signers[1]} is already a member of the multisig`)
    })

    it('refuses to remove an owner that is not a member', async () => {
      const { accounts } = await deployMultisig({ members: 2, threshold: 2 })
      const outsider = (await generateKeyPairSigner()).address

      await expect(accounts[0].removeOwner(outsider))
        .rejects.toThrow(`The address ${outsider} is not a member of the multisig`)
    })

    it('refuses a threshold above the voter count', async () => {
      const { accounts } = await deployMultisig({ members: 2, threshold: 2 })

      await expect(accounts[0].changeThreshold(3)).rejects.toThrow(
        'Invalid threshold 3. It must be an integer between 1 and the number of owners able to vote (2).'
      )
    })

    it('refuses a removal that would leave the threshold unreachable', async () => {
      const { accounts, signers } = await deployMultisig({ members: 2, threshold: 2 })

      await expect(accounts[0].removeOwner(signers[1])).rejects.toThrow(
        'Invalid threshold 2. It must be an integer between 1 and the number of owners able to vote (1).'
      )
    })

    it('refuses a config change on a multisig that does not exist', async () => {
      const { accounts } = await createWallet({ members: 1 })
      const outsider = (await generateKeyPairSigner()).address

      expect(await accounts[0].isDeployed()).toBe(false)
      await expect(accounts[0].addOwner(outsider)).rejects.toThrow(/does not exist/)
      await expect(accounts[0].changeThreshold(1)).rejects.toThrow(/does not exist/)
    })
  })

  describe('account surface', () => {
    it('signs a message with the member key rather than the multisig', async () => {
      const { accounts, multisigPda } = await deployMultisig({ members: 1, threshold: 1 })

      const signature = await accounts[0].sign('hello')

      expect(signature).toBe(SIGNED_HELLO)
      expect(verifyEd25519(signature, 'hello', SIGNER_0)).toBe(true)
      expect(verifyEd25519(signature, 'hello', multisigPda)).toBe(false)
    })

    it('leaves out the message-proposal surface Squads has no primitive for', async () => {
      const { accounts } = await deployMultisig({ members: 1, threshold: 1 })
      const [account] = accounts

      expect(account.proposeMessage).toBeUndefined()
      expect(account.approveMessageProposal).toBeUndefined()
      expect(account.getMessageProposals).toBeUndefined()
      await expect(account.verify('hello', '0x00')).rejects.toThrow(UnsupportedOperationError)
    })

    it('returns the receipt of a confirmed transaction', async () => {
      const { accounts, deployHash } = await deployMultisig({ members: 1, threshold: 1 })

      const receipt = await accounts[0].getTransactionReceipt(deployHash)

      expect(receipt.transaction.signatures[0]).toBe(deployHash)
      expect(receipt.meta.err).toBeNull()
      // Two signatures: the creator and the create key.
      expect(receipt.meta.fee).toBe(10000n)
    })

    it('returns null for a signature the cluster has never seen', async () => {
      const { accounts } = await deployMultisig({ members: 1, threshold: 1 })

      expect(await accounts[0].getTransactionReceipt('5'.repeat(87))).toBeNull()
    })

    it('refuses a signature that is not 64 bytes of base58', async () => {
      const { accounts } = await deployMultisig({ members: 1, threshold: 1 })

      await expect(accounts[0].getTransactionReceipt('not-a-signature'))
        .rejects.toThrow('Invalid transaction signature: not-a-signature')
    })

    it('normalizes a confirmed transaction', async () => {
      const { accounts, deployHash } = await deployMultisig({ members: 1, threshold: 1 })

      const receipt = await accounts[0].getTransaction(deployHash)

      expect(receipt.hash).toBe(deployHash)
      expect(receipt.success).toBe(true)
      expect(receipt.fee).toBe(10000n)
      expect(['confirmed', 'final']).toContain(receipt.finality)
    })

    it('throws for a signature the cluster has never seen', async () => {
      const { accounts } = await deployMultisig({ members: 1, threshold: 1 })

      await expect(accounts[0].getTransaction('5'.repeat(87))).rejects.toThrow(NoSuchElementError)
    })

    it('waits for a transaction it has just sent', async () => {
      const { accounts, deployHash } = await deployMultisig({ members: 1, threshold: 1 })

      const receipt = await accounts[0].waitForTransaction(deployHash)

      expect(receipt.hash).toBe(deployHash)
      expect(receipt.success).toBe(true)
    })

    it('exposes a read-only view that reads the same state without signing', async () => {
      const multisig = await deployMultisig({
        members: 2,
        threshold: 2,
        fundVault: LAMPORTS_PER_SOL
      })
      const { accounts, signers, multisigPda, vaultPda } = multisig
      const recipient = (await generateKeyPairSigner()).address

      const proposal = await accounts[0].propose({ to: recipient, value: 1n })

      await confirmTransaction(rpc, proposal.transaction.hash)
      await approveWithAll(accounts, proposal.proposalId, rpc)

      const readOnly = await accounts[0].toReadOnlyAccount()

      expect(readOnly).toBeInstanceOf(WalletAccountReadOnlyMultisigSquads)
      expect(await readOnly.getAddress()).toBe(multisigPda)
      expect(await readOnly.getVaultAddress()).toBe(vaultPda)
      expect(await readOnly.getMultisigInfo()).toMatchObject({
        owners: expect.arrayContaining(signers),
        threshold: 2
      })
      expect(await readOnly.getBalance()).toBe(LAMPORTS_PER_SOL)
      expect(await readOnly.isReadyToExecute(proposal.proposalId)).toBe(true)

      const seen = await readOnly.getProposal(proposal.proposalId)

      expect(seen.statusName).toBe('Approved')
    })

    it('reports an undeployed multisig as absent rather than throwing', async () => {
      const { accounts } = await createWallet({ members: 1 })
      const [account] = accounts

      expect(await account.isDeployed()).toBe(false)
      expect(await account.getMultisigInfo()).toMatchObject({
        owners: [],
        masks: [],
        threshold: 0
      })
    })

    it('reports an empty vault for an undeployed multisig', async () => {
      const { accounts } = await createWallet({ members: 1 })

      expect(await accounts[0].getBalance()).toBe(0n)
    })

    it('refuses getNonce on an undeployed multisig', async () => {
      const { accounts } = await createWallet({ members: 1 })

      await expect(accounts[0].getNonce()).rejects.toThrow(
        `The multisig account ${await accounts[0].getAddress()} does not exist.`
      )
    })

    it('derives distinct vaults per index and rejects one out of range', async () => {
      const { accounts, vaultPda } = await deployMultisig({ members: 1, threshold: 1 })
      const [account] = accounts

      const [zero, one] = await Promise.all([
        account.getVaultAddress(0),
        account.getVaultAddress(1)
      ])

      expect(zero).toBe(vaultPda)
      expect(one).not.toBe(zero)
      await expect(account.getVaultAddress(256)).rejects.toThrow(
        'Invalid vault index 256. It must be an integer between 0 and 255.'
      )
    })

    it('refuses to read a multisig with no address configured', async () => {
      const account = new WalletAccountReadOnlyMultisigSquads({ provider: TEST_RPC_URL })

      await expect(account.getAddress()).rejects.toThrow(/address must be set/)
    })
  })
})
