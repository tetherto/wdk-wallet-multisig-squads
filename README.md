# @tetherto/wdk-wallet-multisig-squads

[![npm version](https://img.shields.io/npm/v/%40tetherto%2Fwdk-wallet-multisig-squads?style=flat-square)](https://www.npmjs.com/package/@tetherto/wdk-wallet-multisig-squads)
[![npm downloads](https://img.shields.io/npm/dw/%40tetherto%2Fwdk-wallet-multisig-squads?style=flat-square)](https://www.npmjs.com/package/@tetherto/wdk-wallet-multisig-squads)
[![license](https://img.shields.io/npm/l/%40tetherto%2Fwdk-wallet-multisig-squads?style=flat-square)](https://github.com/tetherto/wdk-wallet-multisig-squads/blob/main/LICENSE)
[![docs](https://img.shields.io/badge/docs-docs.wdk.tether.io-0A66C2?style=flat-square)](https://docs.wdk.tether.io/)

**Note**: This package is currently in beta. Please test thoroughly in development environments before using in production.

A simple and secure package to manage [Squads](https://squads.so/) multisig wallets on the Solana blockchain. It follows the same wallet **manager / account** model as [`@tetherto/wdk-wallet-solana`](https://www.npmjs.com/package/@tetherto/wdk-wallet-solana), deriving multisig accounts from a BIP-39 seed phrase and exposing a clean API for creating multisigs and proposing, approving, and executing multisig transactions.

## About WDK

This module is part of the [**WDK (Wallet Development Kit)**](https://docs.wdk.tether.io/) project, which empowers developers to build secure, non-custodial wallets with unified blockchain access, stateless architecture, and complete user control.

For detailed documentation about the complete WDK ecosystem, visit [docs.wdk.tether.io](https://docs.wdk.tether.io).

## Installation

```bash
npm install @tetherto/wdk-wallet-multisig-squads
```

## Quick Start

```javascript
import WalletManagerMultisigSquads from '@tetherto/wdk-wallet-multisig-squads'

const seedPhrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

const wallet = new WalletManagerMultisigSquads(seedPhrase, {
  provider: 'https://api.devnet.solana.com',
  commitment: 'confirmed',
  // The multisig's address derives from this key, so keep it: without it the address —
  // and anything in its vault — cannot be recovered.
  createKeySecret: '<base58 32-byte private key or 64-byte keypair>'
  // multisigPdaOrCreateKey: '<existing multisig address>'
})

const account = await wallet.getAccount(0)

// Create (deploy) a new Squads multisig. Defaults to this account's signer as the sole
// owner with a threshold of 1; pass owners and a threshold for anything else.
const { hash } = await account.deploy()
console.log('Multisig address:', await account.getAddress())
console.log('Create tx:', hash)

account.dispose()
```

> [!IMPORTANT]
> `createKeySecret` is required to create a multisig, and is the only way to recover its
> address later. To attach to an existing multisig instead, pass `multisigPdaOrCreateKey` and
> omit it: it takes the multisig's address, or the create key that address derives from, and
> tells the two apart by curve membership.

## Key Capabilities

- **Seed-Derived Accounts**: Derive multisig accounts from a BIP-39 seed phrase using SLIP-0010 paths
- **Create Multisig**: Deploy a new Squads multisig with configurable members and threshold
- **Propose / Approve / Reject / Execute**: Full multisig transaction lifecycle
- **Transfers**: Propose native SOL and SPL token transfers through the multisig vault
- **Member Management**: Add, remove, or swap members and change the approval threshold
- **Read-Only Support**: Inspect multisig state without a signing key
- **Pluggable Coordinator**: An open `IMultisigCoordinator` seam, so approvals can be collected however you choose without touching the operations

> [!NOTE]
> Multisig message signing is not part of this module. It is an optional addon of the shared
> multisig interface (`IMultisigMessageSigning`), and Solana has no message-signing primitive a
> program-derived address could use, so the module leaves the addon out rather than stubbing it.
> `sign(message)` still signs with the member's own key.

## Transaction Options

One options object runs through the whole lifecycle, so a note or a vault choice is passed the
same way wherever it applies:

```javascript
// vaultIndex: the vault to spend from, 0 to 255 (default: 0)
// memo: a note recorded on chain with the call
// autoExecute: execute in the same transaction, when this call completes the approvals
await account.propose(tx, { vaultIndex: 0, memo: 'payroll', autoExecute: true })
await account.proposeTransfer(transferOptions, { memo: 'payroll' })

await account.approveProposal(proposalId, { memo: 'looks good', autoExecute: true })
await account.rejectProposal(proposalId, { memo: 'wrong recipient' })

await account.executeProposal(proposalId)
```

`vaultIndex` bears on `propose` and `proposeTransfer` only, and `autoExecute` on everything but
`rejectProposal`, which executes nothing whatever the votes say. `memo` applies to all four.
`executeProposal` takes no options. A memo rides in the instruction's data rather than in an
account, so it adds no rent, and an empty string is a present-but-empty memo rather than none.

`autoExecute` saves the separate `executeProposal` round trip when the same call already
carries the last approval the proposal needs:

- On `propose` and `proposeTransfer`, that means a **threshold of 1**, so it is a 1-of-1 and
  test-setup convenience.
- On `approveProposal`, it means **this approval reaching the threshold**, so the last approver
  of a 3-of-5 applies the transaction in the same transaction as their vote.

It also needs no time lock on the multisig and a signer holding `Execute` on top of the vote.
The two instructions ride in one transaction, so an execution that fails on chain takes the
approval down with it: the vote is not recorded and the proposal stays open, rather than being
approved and left stuck.

> [!NOTE]
> Where `autoExecute` cannot apply it is dropped silently rather than throwing, so branch on
> the result's `status`, which is `'executed'` when it ran and `'pending'` when it did not.
> Either way the result's `transaction` holds the hash and fee of the transaction the call sent,
> since on Solana a proposal is itself an on-chain transaction. `status` is what says whether that
> transaction also executed the proposal.

## Transactions and Coordinators

A proposal that needs N approvals costs N+2 transactions on Squads: one to create it, one per
approval, one to execute. `IMultisigCoordinator` is the seam for collapsing the middle N into one,
and this package does not implement it: implement the interface, plug it in through the
`coordinator` option, and collect approvals however you like. Omit the option and there is no coordinator at all:
every vote is the member's own transaction, broadcast at once. Creating a proposal, rejecting it and
executing it never reach a coordinator either way.

| Call | Without a coordinator | With a coordinator |
|---|---|---|
| `propose` | chain | chain |
| A's `approveProposal` | chain | coordinator |
| B's `approveProposal` | chain | coordinator, then chain, carrying A's approval too |
| `executeProposal` | chain | chain |
| **Transactions** | **4** | **3** |

The two approval rows are the whole of the difference: A's vote does not reach the cluster when it
is cast, it waits in the coordinator until B's completes the bundle, and B's account broadcasts both.
So A gets no transaction of its own back, and its vote counts in the result's `pendingConfirmations`
rather than `confirmations`, which the chain governs. One network fee covers both votes, charged to
whoever the coordinator named as fee payer when it compiled.

```javascript
import { IMultisigCoordinator } from '@tetherto/wdk-wallet-multisig-squads'

// Implement `getProposal` and `confirmProposal`. The interface documents what each is handed and
// what it must return.
/** @implements {IMultisigCoordinator} */
class MyCoordinator {
  constructor (config) { this._config = config }
  /* ... */
}

const wallet = new WalletManagerMultisigSquads(seedPhrase, {
  provider: 'https://api.devnet.solana.com',
  multisigPdaOrCreateKey: '<existing multisig address>',
  coordinator: (config) => new MyCoordinator(config)
})
```

`coordinator` takes a factory rather than an instance because one configuration is shared by every
account the manager derives, and each votes as a different member. The factory is handed
`{ signerAddress }`, which names that member and nothing more, so a coordinator never holds a way to
sign: the account adds the member's signature itself, after checking the bundle. Widen that object
with anything else your implementation needs and keep it however you like; the interface says nothing
about how an implementation stores it.

In `confirmProposal`, verify the decoded signature against `signerAddress` and the held bundle's
exact `messageBytes` before merging it. Reject invalid signatures without changing the bundle.

What the account does with what you return, which is the part you can rely on:

- `getProposal` answering null leaves the member voting alone, exactly as with no coordinator
  configured, so declining is never worse than being absent. Throwing refuses outright.
- Given a transaction, the account checks it, signs it as the member, and hands the signature alone
  to `confirmProposal`. It broadcasts as well when that signature fills the last empty slot.
- It reads the transaction for `confirmations`, counting the approvals of this proposal it carries
  plus any the cluster already holds, and for `status`, which follows an execution riding along.
- It refuses a bundle carrying no approval by this member, and one carrying any member's twice,
  since Squads rejects the duplicate and takes the whole batch with it.
- It refuses anything else in the bundle. Every Squads instruction must vote on or execute this
  proposal of this multisig, and the only other programs allowed to ride along are the compute
  budget, the memo and a System nonce advance. A member signs the whole message, so this is what
  keeps its signature off instructions it never agreed to.
- It quotes the bundle before signing and refuses above `approveMaxFee`, when that option is set. A
  compute budget instruction is allowed through, and it is what buys a priority fee, so the ceiling
  is what bounds the lamports a bundle can cost the fee payer.
- It never appends to the transaction and never recompiles it, so signatures already collected
  stay valid. Address lookup tables are fine; the account reads them to resolve borrowed indices.

> [!IMPORTANT]
> The transaction must be compiled. A signature covers the message bytes, so those bytes have to
> exist before anyone signs and must not change afterwards, which fixes the approver set, the fee
> payer and the lifetime at the moment you compile. Everything beyond that is yours: how members
> reach each other, what keeps the bytes valid while they do, and when to give up on a batch.

> [!WARNING]
> A signature covers the whole transaction, never one instruction, so a member that signs
> authorises everything in it: every instruction, the fee payer and the lifetime. Solana has no
> per-instruction signing, so the account's checks on the bundle, listed above, are the only limit
> on what a coordinator can get signed, and they do not reach everything: they bound the
> instructions the bundle carries, but not the stored message an execution riding along would run,
> and not the priority fee it sets unless `approveMaxFee` is there to bound it. They narrow the
> damage to this proposal; they do not make an unknown coordinator safe to point at.
>
> Two more they never reach. Which account pays: the fee payer is fixed when the bundle is compiled,
> so a member signing one that names itself is agreeing to pay. And how long that signature stays
> usable: a bundle carrying a durable nonce keeps it valid until the nonce advances, so one left in
> a transport can land after the member has voted otherwise on chain.

## Fees, rent, and who pays

Three payers, and one call can involve all three:

- **The fee payer** signs the transaction and pays the Solana network fee. It is the member whose
  account sends, for everything the account builds itself. On a coordinator's bundle it is whoever
  the coordinator named when it compiled, which need not be the member that broadcasts: sending
  bytes that are already fully signed takes no signature of its own.
- **The rent payer** funds the accounts Squads creates. Set it with the `rentPayer` config
  option; it defaults to the signer. It has to sign the transaction by other means, which nothing
  in this package currently provides.
- **The vault** funds whatever the proposed transaction itself does, a recipient's associated
  token account included. No member ever pays for the payload.

| Call | Who must sign | Rent it creates | Charged to |
|---|---|---|---|
| `deploy` | the signer, plus the create key, which `createKeySecret` signs for you | the multisig account, sized by member count, plus the Squads treasury creation fee | `rentPayer`, else the signer |
| `propose`, `proposeTransfer`, `addOwner`, `removeOwner`, `swapOwner`, `changeThreshold` | a member holding `Initiate` | the transaction account, sized by the message, plus the proposal account | `rentPayer`, else the member |
| `approveProposal`, `rejectProposal` | a member holding `Vote` | none | network fee only; on a coordinator's bundle, one fee for the whole batch, charged to the fee payer it compiled |
| `executeProposal` for a transfer or other vault transaction | a member holding `Execute` | none | network fee only; the vault funds the transaction itself |
| `executeProposal` for an owner or threshold change | a member holding `Execute` | growth of the multisig account when the change adds a member | the executing member, even when `rentPayer` is set |

The `transaction.fee` a propose-family call reports is the network fee plus that rent, the same basis
`quotePropose` and `quoteTransfer` use, so a quote and the call it quotes agree. `deploy` sets
no rent collector, so rent stays locked for the life of the accounts rather than being
reclaimable on close.

> [!NOTE]
> An approval that a coordinator is still circulating has not been paid for yet: the `fee` it
> reports is whatever the coordinator answered with, and the transaction that eventually carries it
> pays once for the batch.

## Squads Protocol Version

> [!IMPORTANT]
> This package targets **Squads Protocol v4**, the live version. Program ID:
>
> ```
> SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf
> ```
>
> v3 (**"Squads Legacy"**) is a different program with a different account layout. Its documentation lives under [`/main/squads-legacy/*`](https://docs.squads.so/main/squads-legacy/getting-started/whats-a-squad.md) — do not use it as a reference for this package. Use the [v4 development docs](https://docs.squads.so/main/development/introduction/what-is-squads-protocol.md) instead.

## Compatibility

- **Solana Mainnet Beta**
- **Solana Testnet**
- **Solana Devnet**
- **Standard Solana RPC Providers**

## Testing

```sh
npm test                  # unit tests
npm run test:integration  # against a local validator running the real Squads program
```

The integration suite starts and stops its own `solana-test-validator`, so it needs only
that binary on `PATH`; the Squads program it loads is committed to the repository. See
[tests/integration/fixtures/README.md](tests/integration/fixtures/README.md).

## Community

Join the [WDK Discord](https://discord.gg/arYXDhHB2w) to connect with other developers.

## Support

For support, please [open an issue](https://github.com/tetherto/wdk-wallet-multisig-squads/issues) on GitHub or reach out via [email](mailto:wallet-info@tether.io).

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

This project is licensed under the Apache License 2.0 - see the [LICENSE](LICENSE) file for details.
