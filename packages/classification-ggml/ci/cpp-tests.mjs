#!/usr/bin/env node
// Runs a C++ test script with the staged fixture models, as main's cpp-tests-classification job set it up: the BridgeDepth
// reference and the MegaLoc and BridgeDepth footprint tests skip without them. Usage: node ci/cpp-tests.mjs <script> [backend]

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const [script, backend = 'CPU'] = process.argv.slice(2)
const env = { ...process.env, QVAC_BRIDGEDEPTH_BACKEND: backend, QVAC_FOOTPRINT_BACKEND: backend }
for (const [file, name] of [
  ['bridgedepth-vits-f32.gguf', 'QVAC_BRIDGEDEPTH_MODEL_PATH'],
  ['megaloc-f16.gguf', 'QVAC_MEGALOC_F16_MODEL_PATH'],
  ['megaloc-mixed.gguf', 'QVAC_MEGALOC_MIXED_MODEL_PATH']
]) {
  const model = fileURLToPath(new URL(`../test/fixtures/${file}`, import.meta.url))
  if (existsSync(model)) env[name] = model
}
execFileSync('pnpm', ['run', script], { stdio: 'inherit', env, shell: process.platform === 'win32' })
