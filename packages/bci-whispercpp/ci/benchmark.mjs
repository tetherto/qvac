#!/usr/bin/env node
// bci's RTF benchmark, as main's desktop test workflow ran it after the tests: ci/benchmark-matrix/<config>.json as
// QVAC_BCI_BENCHMARK_MATRIX_JSON, then scripts/run-rtf-benchmark-matrix.js into benchmarks/results. It fails when the
// matrix fails or writes no result file.
//
//   node ci/benchmark.mjs --config <configuration> [--set NAME=value]...

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import { copyVulkanLoader, fetchFixtures, run } from './integration.mjs'

const PKG = fileURLToPath(new URL('..', import.meta.url))
const { values } = parseArgs({
  options: {
    config: { type: 'string' },
    set: { type: 'string', multiple: true, default: [] }
  },
  strict: true
})
const matrix = JSON.parse(
  readFileSync(join(PKG, 'ci/benchmark-matrix', `${values.config}.json`), 'utf8')
)
const env = {
  ...process.env,
  ...Object.fromEntries(
    values.set.map((p) => [p.slice(0, p.indexOf('=')), p.slice(p.indexOf('=') + 1)])
  ),
  QVAC_BCI_BENCHMARK_MATRIX_JSON: JSON.stringify(matrix)
}
fetchFixtures(env)
if (process.platform === 'win32') copyVulkanLoader(env)
const r = spawnSync('node', ['scripts/run-rtf-benchmark-matrix.js'], {
  cwd: PKG,
  env,
  stdio: 'inherit'
})
const dir = join(PKG, 'benchmarks/results')
const files = existsSync(dir)
  ? readdirSync(dir).filter((f) => /^rtf-benchmark-.*\.json$/.test(f))
  : []
if (!files.length)
  console.log(
    '::error title=No RTF benchmark output::no benchmarks/results/rtf-benchmark-*.json produced'
  )
else console.log(`RTF benchmark produced ${files.length} result file(s)`)
process.exit(r.status === 0 && files.length ? 0 : 1)
