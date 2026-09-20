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

import { NotImplementedError } from '@tetherto/wdk-wallet'

/** @typedef {import('@solana/transactions').Transaction} Transaction */

/**
 * Builds the coordinator an account votes through, over the address of the member it will serve.
 *
 * @typedef {(config: { signerAddress: string }) => IMultisigCoordinator} MultisigCoordinatorFactory
 */

/**
 * Coordinator for collecting a proposal's approvals into one transaction. It compiles the bundle and
 * circulates it; the account signs, and the member whose signature completes it broadcasts.
 *
 * @interface
 */
export class IMultisigCoordinator {
  /**
   * Returns the compiled bundle this member should sign, which must carry its own approval of that
   * proposal, or null to leave it voting alone in its own transaction.
   *
   * @param {string} proposalId - The proposal (transaction index) id.
   * @returns {Promise<Transaction | null>} The bundle, or null.
   */
  async getProposal (proposalId) {
    throw new NotImplementedError('getProposal(proposalId)')
  }

  /**
   * Takes this member's signature over the bundle `getProposal` handed out, for the coordinator to
   * put in the slot the factory's `signerAddress` names.
   *
   * Before merging it, the implementation must decode the base58 signature and verify it against
   * that member's public key (`signerAddress`) and the exact `messageBytes` of the bundle it holds.
   * Reject an invalid signature without changing the held bundle; a signature over different
   * message bytes must not be accepted.
   *
   * @param {string} proposalId - The proposal (transaction index) id.
   * @param {string} signature - The member's signature over the bundle, base58 encoded.
   * @returns {Promise<void>}
   */
  async confirmProposal (proposalId, signature) {
    throw new NotImplementedError('confirmProposal(proposalId, signature)')
  }
}
