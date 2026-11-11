#!/usr/bin/env node
// Runs a C++ test script with the staged BridgeDepth model, as main's cpp-tests-classification job set it up: the
// reference tests skip without QVAC_BRIDGEDEPTH_MODEL_PATH. Usage: node ci/cpp-tests.mjs <npm script> [backend]

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const [script, backend = 'CPU'] = process.argv.slice(2)
const model = fileURLToPath(new URL('../test/fixtures/bridgedepth-vits-f32.gguf', import.meta.url))
const env = { ...process.env, QVAC_BRIDGEDEPTH_BACKEND: backend }
if (existsSync(model)) env.QVAC_BRIDGEDEPTH_MODEL_PATH = model
execFileSync('pnpm', ['run', script], { stdio: 'inherit', env, shell: process.platform === 'win32' })
