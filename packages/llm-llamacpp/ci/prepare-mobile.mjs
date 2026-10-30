#!/usr/bin/env node
// Checks the mobile tests and benchmark shards, mirrors the models the mobile suite stages into the US bucket and
// presigns them, then emits the host pre-stage commands that fetch them. A benchmarks.yml run (BENCHMARK_ARGS) picks
// the sweep's shards or bootstraps the VLM matrix into the test app instead of the regular groups.

import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { emitOutputs, emitPrestage, seedAndPresign } from '../../../scripts/ci/mobile-prestage.mjs'
import { dispatch } from './benchmark.mjs'

const PKG = fileURLToPath(new URL('..', import.meta.url))
const sh = (cmd, args) => execFileSync(cmd, args, { cwd: PKG, stdio: 'inherit' })
const json = (f) => JSON.parse(readFileSync(join(PKG, f), 'utf8'))

// The mobile manifest plus the benchmark matrix, so the seed skips desktop-only models.
export function mobileModelNames() {
  const { resolvePinnedManifest } = createRequire(import.meta.url)(
    '../scripts/generate-prestage-block.js'
  )
  const resolved = resolvePinnedManifest(
    json('test/mobile/model-manifest.json'),
    json('test/integration/models.manifest.json')
  )
  return [...new Set(Object.values(resolved).flatMap((models) => models.map((m) => m.name)))]
}

// The benchmark run's groups, device env and timeouts, as main's benchmark workflows passed them to the mobile run.
export function benchmarkOutputs(suite, { groups, config }) {
  if (suite.name === 'sweep') {
    const batch = groups.find((b) => b.cache === suite.values.batch)
    if (!batch)
      throw new Error(
        `batch=${suite.values.batch} is not one of ${groups.map((b) => b.cache).join(', ')}`
      )
    return { 'test-groups': JSON.stringify(batch.groups) }
  }
  if (suite.name !== 'vlm') return {}
  const v = suite.values
  const min =
    v.mobile_timeout_min || (config.mobileTimeoutMin == null ? '' : String(config.mobileTimeoutMin))
  const env = [
    `QVAC_VLM_DEVICES=${v.vlm_devices}`,
    `QVAC_VLM_MODE=${v.mode}`,
    `QVAC_VLM_PRESET=${v.preset}`,
    'QVAC_VLM_SOURCE_ID=addon',
    ...(v.samples ? [`QVAC_VLM_SAMPLES=${v.samples}`] : []),
    ...(v.models ? [`QVAC_VLM_MODELS=b64:${Buffer.from(v.models).toString('base64')}`] : []),
    ...(min ? [`QVAC_VLM_TEST_TIMEOUT_MIN=${min}`] : [])
  ]
  return {
    'test-groups': JSON.stringify([{ name: 'vlmMatrix', grep: 'runVlmMatrixTest' }]),
    'device-env': env.join(';'),
    ...(min
      ? { 'mocha-timeout-ms': String((Number(min) + 5) * 60000), 'per-test-timeout-minutes': min }
      : {})
  }
}

const suite = process.env.BENCHMARK_ARGS
  ? dispatch(process.env.BENCHMARK_ARGS.split(/\s+/).filter(Boolean))
  : null
if (suite?.name === 'vlm') {
  // The VLM test and its fixture images join the generated mobile suite for this run only.
  sh('aws', [
    's3',
    'sync',
    's3://tether-ai-dev/vlm-benchmark/',
    'benchmarks/vlm-benchmark/fixture/'
  ])
  execFileSync(
    'pnpm',
    ['install', '--frozen-lockfile', '--ignore-scripts', '--filter', '@qvac/llm-llamacpp'],
    {
      cwd: join(PKG, '../..'),
      stdio: 'inherit'
    }
  )
  sh('node', ['benchmarks/vlm-benchmark/stage.cjs'])
  sh('npm', ['run', 'test:mobile:generate'])
}
sh('npm', ['run', 'test:mobile:validate'])
sh('npm', ['run', 'generate:benchmark-shards'])
sh('node', ['scripts/generate-benchmark-shards.js', '--assert-shards'])
const map = join(process.env.RUNNER_TEMP, 'llm-url-map.json')
seedAndPresign({
  pkg: PKG,
  manifest: 'test/integration/models.manifest.json',
  prefix: 'qvac_models_compiled/mobile-pilot/llm/',
  out: map,
  names: mobileModelNames().join(',')
})
emitPrestage(PKG, { env: { ...process.env, PRESTAGE_URL_MAP: map } })
if (suite)
  emitOutputs(
    benchmarkOutputs(suite, {
      groups: createRequire(import.meta.url)(
        '../test/integration/_benchmark-matrix.js'
      ).workflowBatches(),
      config: createRequire(import.meta.url)('../benchmarks/vlm-benchmark/config.cjs')
    })
  )
