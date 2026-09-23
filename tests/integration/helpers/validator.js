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

import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { SQUADS_PROGRAM_ADDRESS } from '@tetherto/wdk-wallet-multisig-squads'

export const TEST_RPC_URL = 'http://127.0.0.1:8899'

// The Squads ProgramConfig PDA, seeds ["multisig", "program_config"].
export const SQUADS_PROGRAM_CONFIG_ADDRESS = 'BSTq9w3kZwNwpBXJEvTZz2G9ZTNyKBvoSeXMvwb4cNZr'

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures')

const PROGRAM_SO_PATH = join(FIXTURES_DIR, 'squads-program.so')
const PROGRAM_CONFIG_PATH = join(FIXTURES_DIR, 'squads-program-config.json')

const READY_ATTEMPTS = 60
const READY_INTERVAL_MS = 500

/** @returns {Promise<void>} */
async function assertFixtures () {
  for (const path of [PROGRAM_SO_PATH, PROGRAM_CONFIG_PATH]) {
    try {
      await access(path)
    } catch {
      throw new Error(
        `The Squads fixture ${path} is missing. It is committed to the repository — ` +
        'see tests/integration/fixtures/README.md.'
      )
    }
  }
}

/**
 * @param {{ getLatestBlockhash: Function }} rpc
 * @returns {Promise<() => Promise<void>>} A function that stops the validator.
 */
export async function startSolanaTestValidator (rpc) {
  await assertFixtures()

  const validator = spawn('solana-test-validator', [
    '--reset',
    '--ticks-per-slot', '4',
    '--limit-ledger-size', '10000',
    '--upgradeable-program', SQUADS_PROGRAM_ADDRESS, PROGRAM_SO_PATH, 'none',
    '--account', SQUADS_PROGRAM_CONFIG_ADDRESS, PROGRAM_CONFIG_PATH
  ], {
    stdio: ['ignore', 'ignore', 'ignore']
  })

  let startupError

  const closed = new Promise((resolve) => {
    validator.once('close', resolve)
  })

  validator.once('error', (error) => {
    startupError = error
  })

  const stopSolanaTestValidator = async () => {
    if (!validator.killed && validator.exitCode === null) {
      validator.kill('SIGKILL')
    }

    await closed
  }

  for (let attempt = 0; attempt < READY_ATTEMPTS; attempt++) {
    if (startupError) {
      await stopSolanaTestValidator()
      throw startupError
    }

    try {
      await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send()
      return stopSolanaTestValidator
    } catch {
      await new Promise((resolve) => setTimeout(resolve, READY_INTERVAL_MS))
    }
  }

  await stopSolanaTestValidator()

  throw new Error(`The validator was not answering at ${TEST_RPC_URL}`)
}
