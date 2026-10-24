#!/usr/bin/env node
// Runs the integration suite as main's vla workflow did, then on the CUDA box checks an explicit Vulkan request.

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { modelEnv, PKG } from './model-env.mjs'
import { tee } from './tee.mjs'

export const MODELS = {
  QVAC_VLA_MODEL: 'smolvla-libero-vision-q8.gguf',
  PI05_TEST_GGUF: 'pi05-base-q-aggressive.gguf',
  PI05_TEST_FIXTURE: 'pi05-fixture.safetensors',
  PI05_TEST_ACTIVATIONS: 'pi05-activations.safetensors',
  GROOT_TEST_GGUF: 'groot-multi-q8_vf16.gguf',
  GROOT_TEST_ACTIVATIONS_V4: 'groot-libero-activations_v4.safetensors'
}

// The suite's performance reports, into the run's step summary; passing or not, as the workflow step did.
function renderPerfSummary() {
  if (!process.env.GITHUB_STEP_SUMMARY) return
  const dir = join(PKG, 'test/results')
  const reports = existsSync(dir)
    ? readdirSync(dir).filter((f) => /^performance-report.*\.json$/.test(f))
    : []
  const renderer = join(PKG, '../../scripts/perf-report/render-step-summary.js')
  for (const report of reports) {
    execFileSync('node', [renderer, join(dir, report), process.env.GITHUB_STEP_SUMMARY], {
      stdio: 'inherit'
    })
  }
}

const hasNvidia = () => {
  try {
    execFileSync('nvidia-smi', ['-L'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

export function expectedBackend(env, host, nvidia) {
  if (env.QVAC_VLA_EXPECTED_BACKEND !== undefined) return env.QVAC_VLA_EXPECTED_BACKEND
  return host === 'linux-x64' && nvidia() ? 'cuda' : ''
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const host = `${process.platform}-${process.arch}`
  const backend = expectedBackend(process.env, host, hasNvidia)
  const env = { ...process.env, ...modelEnv(MODELS), QVAC_VLA_EXPECTED_BACKEND: backend }
  const run = await tee('npm', ['run', 'test:integration', host], {
    cwd: PKG,
    env,
    logFile: join(PKG, 'integration-test.log')
  })
  renderPerfSummary()
  if (run.code !== 0) process.exit(run.code)
  if (backend === 'cuda') {
    execFileSync('bare', ['test/integration/backend-selection.test.js', '--exit'], {
      cwd: PKG,
      stdio: 'inherit',
      env: {
        ...env,
        QVAC_VLA_BACKEND_SELECTION_SMOKE: 'true',
        QVAC_VLA_REQUESTED_BACKEND: 'vulkan',
        QVAC_VLA_EXPECTED_BACKEND: 'vulkan',
        QVAC_VLA_BACKEND_LOAD_ONLY: 'true'
      }
    })
  }
}
