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

import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals'

import { getBase58Encoder, getU32Encoder, getU64Encoder } from '@solana/codecs'
import { AccountRole } from '@solana/instructions'
import { pipe } from '@solana/functional'
import { createSolanaRpc } from '@solana/rpc'
import { generateKeyPairSigner } from '@solana/signers'
import {
  appendTransactionMessageInstructions,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash
} from '@solana/transaction-messages'
import {
  compileTransaction,
  getTransactionDecoder,
  getTransactionEncoder
} from '@solana/transactions'

import { PublicKey } from '@solana/web3.js'
import * as squads from '@sqds/multisig'

import { WalletAccountReadOnlySolana } from '@tetherto/wdk-wallet-solana'

import { IMultisigCoordinator, ValueError } from '@tetherto/wdk-protocol-multisig-squads'

import { LAMPORTS_PER_SOL, confirmTransaction } from './helpers/chain.js'
import { deployMultisig, sorted } from './helpers/multisig.js'
import { TEST_RPC_URL, startSolanaTestValidator } from './helpers/validator.js'

jest.setTimeout(180_000)

// The network fee a single-signature transaction pays on the validator.
const SIGNATURE_FEE = 5000n

// The rent a SOL-transfer proposal locks up on this validator for a two-member multisig: its
// transaction and proposal accounts.
const PROPOSAL_RENT = 5143440n

const TRANSFER_AMOUNT = LAMPORTS_PER_SOL / 10n

const MEMO_TEXT = 'two of three, collected off chain'
const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'
const MEMO_INSTRUCTION = {
  programAddress: MEMO_PROGRAM,
  accounts: [],
  data: new TextEncoder().encode(MEMO_TEXT)
}

// Far above what an approval bundle costs, which is two signatures, and far below what the priority
// fee below buys.
const APPROVE_MAX_FEE = 1_000_000n
const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111'
const PRIORITY_INSTRUCTIONS = [
  {
    programAddress: COMPUTE_BUDGET_PROGRAM,
    accounts: [],
    data: new Uint8Array([2, ...getU32Encoder().encode(1_400_000)])
  },
  {
    programAddress: COMPUTE_BUDGET_PROGRAM,
    accounts: [],
    data: new Uint8Array([3, ...getU64Encoder().encode(10_000_000n)])
  }
]

/**
 * Reads the memo a landed transaction wrote, from the log the memo program prints.
 *
 * @param {object} rpc - The Solana RPC client.
 * @param {string} hash - The transaction's signature.
 * @returns {Promise<string | null>} The memo, or null when the transaction logged none.
 */
async function memoOf (rpc, hash) {
  const { meta } = await rpc
    .getTransaction(hash, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 })
    .send()
  const logged = meta.logMessages.find((line) => line.includes('Program log: Memo'))

  return logged ? logged.slice(logged.indexOf('"') + 1, logged.lastIndexOf('"')) : null
}

/** @param {string} target */
function solanaAccount (target) {
  return new WalletAccountReadOnlySolana(target, {
    provider: TEST_RPC_URL,
    commitment: 'confirmed'
  })
}

/**
 * Builds a member's `proposalApprove` with the Squads SDK, in the shape `@solana/kit` compiles.
 *
 * @param {string} multisigPda - The multisig account.
 * @param {string} member - The approving member.
 * @param {bigint} transactionIndex - The proposal id.
 * @returns {object} The instruction.
 */
function approvalOf (multisigPda, member, transactionIndex) {
  const instruction = squads.instructions.proposalApprove({
    multisigPda: new PublicKey(multisigPda),
    member: new PublicKey(member),
    transactionIndex
  })

  return {
    programAddress: instruction.programId.toBase58(),
    accounts: instruction.keys.map(({ pubkey, isSigner, isWritable }) => ({
      address: pubkey.toBase58(),
      role: isSigner
        ? (isWritable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER)
        : (isWritable ? AccountRole.WRITABLE : AccountRole.READONLY)
    })),
    data: new Uint8Array(instruction.data)
  }
}

/**
 * Compiles a bundle the way a coordinator has to: every approval, the fee payer and the lifetime
 * are in it before the first signature.
 *
 * @param {object} rpc - The Solana RPC client.
 * @param {{ multisigPda: string, feePayer: string, approvers: string[], transactionIndex: bigint, padding?: object[] }} plan
 * @returns {Promise<object>} The compiled, unsigned transaction.
 */
async function compileBundle (rpc, { multisigPda, feePayer, approvers, transactionIndex, padding = [] }) {
  const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send()
  const approvals = approvers.map((member) => approvalOf(multisigPda, member, transactionIndex))

  return compileTransaction(pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions([...padding, ...approvals], m)
  ))
}

/**
 * A coordinator for the suite to drive. Its transport holds the wire encoding rather than the
 * object, and `confirmProposal` merges the member's signature into the copy it holds.
 *
 * @implements {IMultisigCoordinator}
 */
class PseudoCoordinator {
  constructor (config) {
    this._config = config
  }

  async getProposal (proposalId) {
    const wire = this._config.transport.get(proposalId)

    return wire ? getTransactionDecoder().decode(wire) : null
  }

  async confirmProposal (proposalId, signature) {
    const held = getTransactionDecoder().decode(this._config.transport.get(proposalId))
    const merged = {
      ...held,
      signatures: {
        ...held.signatures,
        [this._config.signerAddress]: getBase58Encoder().encode(signature)
      }
    }

    this._config.transport.set(proposalId, getTransactionEncoder().encode(merged))
  }
}

describe('coordinators', () => {
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

  describe('no coordinator', () => {
    let accounts
    let signers
    let vaultPda
    let recipient
    let proposal

    beforeAll(async () => {
      const deployed = await deployMultisig({
        members: 2,
        threshold: 2,
        fundVault: LAMPORTS_PER_SOL
      })

      accounts = deployed.accounts
      signers = deployed.signers
      vaultPda = deployed.vaultPda
      recipient = (await generateKeyPairSigner()).address
      proposal = await accounts[0].propose({ to: recipient, value: TRANSFER_AMOUNT })

      await confirmTransaction(rpc, proposal.transaction.hash)
    })

    it('drives the whole lifecycle with the member signing every transaction', async () => {
      const first = await accounts[0].approveProposal(proposal.proposalId)
      await confirmTransaction(rpc, first.transaction.hash)

      const second = await accounts[1].approveProposal(proposal.proposalId)
      await confirmTransaction(rpc, second.transaction.hash)

      const execution = await accounts[1].executeProposal(proposal.proposalId)
      await confirmTransaction(rpc, execution.hash)

      expect(proposal).toEqual({
        proposalId: '1',
        confirmations: 0,
        pendingConfirmations: 0,
        threshold: 2,
        status: 'pending',
        transaction: { hash: proposal.transaction.hash, fee: SIGNATURE_FEE + PROPOSAL_RENT }
      })
      expect(first.transaction.fee).toBe(SIGNATURE_FEE)
      expect(second.transaction.fee).toBe(SIGNATURE_FEE)
      expect(execution.fee).toBe(SIGNATURE_FEE)

      const executed = await accounts[0].getProposal(proposal.proposalId)

      expect(executed.statusName).toBe('Executed')
      expect(sorted(executed.approved)).toEqual(sorted(signers))
      expect(await solanaAccount(recipient).getBalance()).toBe(TRANSFER_AMOUNT)
      expect(await solanaAccount(vaultPda).getBalance()).toBe(
        LAMPORTS_PER_SOL - TRANSFER_AMOUNT
      )
    })
  })

  describe('two of three members voting through a coordinator', () => {
    let accounts
    let signers
    let multisigPda
    let transport
    let proposalId
    let bundle

    beforeAll(async () => {
      transport = new Map()

      const deployed = await deployMultisig({
        members: 3,
        threshold: 2,
        config: {
          coordinator: (config) => new PseudoCoordinator({ ...config, transport }),
          approveMaxFee: APPROVE_MAX_FEE
        }
      })

      accounts = deployed.accounts
      signers = deployed.signers
      multisigPda = deployed.multisigPda
    })

    // A fresh proposal per test, and the unsigned bundle a coordinator would be holding for it.
    beforeEach(async () => {
      const proposal = await accounts[0].propose({ instructions: [MEMO_INSTRUCTION] })
      await confirmTransaction(rpc, proposal.transaction.hash)

      proposalId = proposal.proposalId
      bundle = getTransactionEncoder().encode(await compileBundle(rpc, {
        multisigPda,
        feePayer: signers[1],
        approvers: [signers[0], signers[1]],
        transactionIndex: BigInt(proposalId)
      }))

      transport.set(proposalId, bundle)
    })

    afterAll(() => {
      accounts.forEach((account) => account.dispose())
      transport.clear()
    })

    it('reports a transaction only when the collected approvals are broadcast', async () => {
      const first = await accounts[0].approveProposal(proposalId)

      expect(first).toEqual({
        proposalId,
        confirmations: 0,
        pendingConfirmations: 1,
        threshold: 2,
        status: 'pending',
        transaction: undefined
      })
      expect(await accounts[0].getProposal(proposalId)).toMatchObject({ approved: [] })

      // The second fills the last slot, so it broadcasts and reports what landed.
      const second = await accounts[1].approveProposal(proposalId)

      await confirmTransaction(rpc, second.transaction.hash)

      expect(second).toEqual({
        proposalId,
        confirmations: 2,
        pendingConfirmations: 0,
        threshold: 2,
        status: 'pending',
        transaction: { hash: second.transaction.hash, fee: 2n * SIGNATURE_FEE }
      })

      const approved = await accounts[0].getProposal(proposalId)

      expect(approved.statusName).toBe('Approved')
      expect(sorted(approved.approved)).toEqual(sorted([signers[0], signers[1]]))
      expect(approved.approved).not.toContain(signers[2])

      const execution = await accounts[2].executeProposal(proposalId)

      await confirmTransaction(rpc, execution.hash)

      expect((await accounts[0].getProposal(proposalId)).statusName).toBe('Executed')
      expect(await memoOf(rpc, execution.hash)).toBe(MEMO_TEXT)
    })

    it('counts only the approvals of this proposal, whatever else the bundle carries', async () => {
      // Padded with what a nonce advance or a compute budget would be: not an approval.
      transport.set(proposalId, getTransactionEncoder().encode(await compileBundle(rpc, {
        multisigPda,
        feePayer: signers[1],
        approvers: [signers[0], signers[1]],
        transactionIndex: BigInt(proposalId),
        padding: [MEMO_INSTRUCTION]
      })))

      await accounts[0].approveProposal(proposalId)

      const second = await accounts[1].approveProposal(proposalId)

      await confirmTransaction(rpc, second.transaction.hash)

      expect(second.confirmations).toBe(2)
      expect(await memoOf(rpc, second.transaction.hash)).toBe(MEMO_TEXT)
      expect(sorted((await accounts[0].getProposal(proposalId)).approved))
        .toEqual(sorted([signers[0], signers[1]]))
    })

    it('refuses a bundle whose priority fee exceeds the ceiling, before signing', async () => {
      // The whitelist lets a compute budget instruction ride along, and it is what sets the priority
      // fee. 1.4M units at 10 lamports each is 14,000,000 lamports, against a ceiling of 1,000,000.
      transport.set(proposalId, getTransactionEncoder().encode(await compileBundle(rpc, {
        multisigPda,
        feePayer: signers[1],
        approvers: [signers[0], signers[1]],
        transactionIndex: BigInt(proposalId),
        padding: PRIORITY_INSTRUCTIONS
      })))

      await expect(accounts[0].approveProposal(proposalId)).rejects.toThrow(
        'Exceeded maximum fee cost for the approve operation.'
      )
      expect(sorted((await accounts[0].getProposal(proposalId)).approved)).toEqual([])
    })

    it('refuses a bundle that does not carry this member approval', async () => {
      // The seeded bundle carries no slot for the third member.
      await expect(accounts[2].approveProposal(proposalId)).rejects.toThrow(
        new ValueError(
          `The bundle the coordinator holds for the proposal ${proposalId} does not carry an approval by the signer ${signers[2]}.`
        )
      )
      expect((await accounts[0].getProposal(proposalId)).approved).toEqual([])
    })

    it('leaves a member to vote alone when the coordinator holds no bundle for it', async () => {
      transport.delete(proposalId)

      const alone = await accounts[0].approveProposal(proposalId)

      await confirmTransaction(rpc, alone.transaction.hash)

      expect(alone).toEqual({
        proposalId,
        confirmations: 1,
        pendingConfirmations: 0,
        threshold: 2,
        status: 'pending',
        transaction: { hash: alone.transaction.hash, fee: SIGNATURE_FEE }
      })
      expect((await accounts[0].getProposal(proposalId)).approved).toEqual([signers[0]])
    })

    it('never reaches a coordinator for a rejection or an execution', async () => {
      const rejection = await accounts[0].rejectProposal(proposalId)

      await confirmTransaction(rpc, rejection.transaction.hash)

      expect(rejection.transaction.fee).toBe(SIGNATURE_FEE)
      expect(transport.get(proposalId)).toBe(bundle)
      expect((await accounts[0].getProposal(proposalId)).rejected).toEqual([signers[0]])
    })
  })
})
