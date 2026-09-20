/** @typedef {import('@solana/transactions').Transaction} Transaction */
/**
 * Builds the coordinator an account votes through, over the address of the member it will serve.
 *
 * @typedef {(config: { signerAddress: string }) => IMultisigCoordinator} MultisigCoordinatorFactory
 */
/**
 * Coordinator for collecting a proposal's approvals into one transaction. It compiles the bundle and
 * circulates it; the account signs, and the member whose signature completes it broadcasts.
 */
export interface IMultisigCoordinator {
    /**
     * Returns the compiled bundle this member should sign, which must carry its own approval of that
     * proposal, or null to leave it voting alone in its own transaction.
     *
     * @param {string} proposalId - The proposal (transaction index) id.
     * @returns {Promise<Transaction | null>} The bundle, or null.
     */
    getProposal(proposalId: string): Promise<Transaction | null>;
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
    confirmProposal(proposalId: string, signature: string): Promise<void>;
}
export type Transaction = import("@solana/transactions").Transaction;
/**
 * Builds the coordinator an account votes through. One configuration is shared by every account a
 * manager derives, and each signs with a different key, so it carries a factory rather than an
 * instance.
 */
export type MultisigCoordinatorFactory = (config: {
    signerAddress: string;
}) => IMultisigCoordinator;
