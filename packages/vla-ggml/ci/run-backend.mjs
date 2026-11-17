#!/usr/bin/env node
// With CUDA hidden on the NVIDIA box, the addon must pick Vulkan by itself.

import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { modelEnv, PKG } from './model-env.mjs'
import { tee } from './tee.mjs'

export const SMOKE_ENV = {
  QVAC_VLA_BACKEND_SELECTION_SMOKE: 'true',
  QVAC_VLA_EXPECTED_BACKEND: 'vulkan',
  CUDA_VISIBLE_DEVICES: '-1'
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  execFileSync('npm', ['run', 'build:ts'], {
    cwd: PKG,
    stdio: 'inherit',
    shell: process.platform === 'win32'
  })
  const env = {
    ...process.env,
    ...modelEnv({ QVAC_VLA_MODEL: 'smolvla-libero-vision-q8.gguf' }),
    ...SMOKE_ENV
  }
  const run = await tee('bare', ['test/integration/backend-selection.test.js', '--exit'], {
    cwd: PKG,
    env,
    logFile: join(PKG, 'backend-selection-test.log')
  })
  process.exit(run.code)
}
