#!/usr/bin/env node
// main's CUDA smoke under bare-sidecar, which maps no C++ runtime: the suite runs under bare, whose binary links
// libstdc++, so only this proves fabric's GPU module loads without one.

import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const VERSION = '0.5.13'
const MODEL = 'test/model/Llama-3.2-1B-Instruct-Q4_0.gguf'

const dir = join(process.env.RUNNER_TEMP || tmpdir(), 'bare-sidecar')
rmSync(dir, { recursive: true, force: true })
mkdirSync(dir, { recursive: true })
execFileSync('npm', ['pack', `bare-sidecar@${VERSION}`, '--pack-destination', dir, '--silent'], {
  stdio: 'inherit'
})
execFileSync('tar', ['-xzf', join(dir, `bare-sidecar-${VERSION}.tgz`), '-C', dir], { stdio: 'inherit' })
// The Vulkan module loads first, and Mesa's ICDs need libstdc++, which would let a broken CUDA module load.
execFileSync(
  join(dir, 'package/prebuilds/linux-x64/bare'),
  ['test/integration/sidecar-cuda-smoke.js', MODEL],
  {
    stdio: 'inherit',
    env: { ...process.env, VK_DRIVER_FILES: '/nonexistent.json', VK_ICD_FILENAMES: '/nonexistent.json' }
  }
)
