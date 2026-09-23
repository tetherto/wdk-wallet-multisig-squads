# Agent Guide

This repository is part of the Tether WDK (Wallet Development Kit) ecosystem. It follows strict coding conventions and tooling standards to ensure consistency, reliability, and cross-platform compatibility (Node.js and Bare runtime).

## Project Overview

- **Architecture:** Modular architecture with clear separation between Core, Wallet managers, and Protocols. This package is a **wallet** module that lets Solana accounts interact with the Squads multisig program.
- **Runtime:** Supports both Node.js and Bare runtime.

## Tech Stack & Tooling

- **Language:** JavaScript (ES2015+).
- **Module System:** ES Modules (`"type": "module"` in package.json).
- **Type Checking:** TypeScript is used purely for generating type declarations (`.d.ts`). The source code remains JavaScript.
  - Command: `npm run build:types`
- **Linting:** `standard` (JavaScript Standard Style).
  - Command: `npm run lint` / `npm run lint:fix`
- **Testing:** `jest` (configured with `experimental-vm-modules` for ESM support).
  - Command: `npm test`
- **Dependencies:** `cross-env` is consistently used for environment variable management in scripts.

## Coding Conventions

- **File Naming:** Kebab-case (e.g., `wallet-manager-multisig-squads.js`).
- **Class Naming:** PascalCase (e.g., `WalletManagerMultisigSquads`).
- **Private Members:** Prefixed with `_` (underscore) and explicitly documented with `@private` / `@protected`.
- **Imports:** Explicit file extensions are mandatory (e.g., `import ... from './file.js'`).
- **Copyright:** All source files must include the standard Tether copyright header.

## Documentation (JSDoc)

Source code must be strictly typed using JSDoc comments to support the `build:types` process.

- **Types:** Use `@typedef` to define or import types.
- **Methods:** Use `@param`, `@returns`, `@throws`.
- **Generics:** Use `@template`.

## Development Workflow

1.  **Install:** `npm install`
2.  **Lint:** `npm run lint`
3.  **Test:** `npm test`
4.  **Build Types:** `npm run build:types`

## Key Files

- `index.js`: Main entry point.
- `bare.js`: Entry point for Bare runtime optimization.
- `src/`: Core logic.
- `types/`: Generated type definitions (do not edit manually).

## Repository Specifics

- **Domain:** Squads Multisig (Solana).
- **Key Libraries:** `@sqds/multisig`, the modern Solana stack (`@solana/rpc`, `@solana/signers`, etc.), `@tetherto/wdk-wallet`, and `@tetherto/wdk-wallet-solana`.
- **Pattern:** A wallet **manager → account → read-only account** trio (the same shape as `@tetherto/wdk-wallet-solana` and `@tetherto/wdk-wallet-multisig-safe`). The read-only account implements `IWalletAccountReadOnlyMultisig` and the signing account implements `IWalletAccountMultisig`, both from `@tetherto/wdk-wallet`. The signing account wraps a `WalletAccountSolana` signer, mirroring how the Safe package wraps `WalletAccountEvm`.
- **Standards:** SLIP-0010 (`m/44'/501'`), inherited from the Solana signer account.
- **Features:** Create (deploy) multisig, propose / approve / reject / execute transactions, transfers, message proposals, and member/threshold management.
