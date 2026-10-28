#!/usr/bin/env node
// audiogen's RTF benchmark, as integration-test-nx.yml ran it after the tests: ci/benchmark-matrix/<config>.json as
// QVAC_AUDIOGEN_GGML_BENCHMARK_MATRIX_JSON with main's warmup, runs and duration, then
// scripts/run-rtf-benchmark-matrix.js into benchmarks/results. It fails when the matrix fails or writes no result.
//
//   node ci/benchmark.mjs --config <configuration> [--set NAME=value]...

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { environment, run } from './integration.mjs'

const PKG = fileURLToPath(new URL('..', import.meta.url))
const argv = process.argv.slice(2)
const at = argv.indexOf('--config')
if (at < 0 || !argv[at + 1]) throw new Error('--config <configuration> is required')
const config = argv[at + 1]
const matrix = JSON.parse(readFileSync(join(PKG, 'ci/benchmark-matrix', `${config}.json`), 'utf8'))
const env = {
  ...environment(argv.filter((_, i) => i !== at && i !== at + 1)),
  QVAC_AUDIOGEN_GGML_BENCHMARK_MATRIX_JSON: JSON.stringify(matrix),
  QVAC_AUDIOGEN_GGML_BENCHMARK_WARMUP_RUNS: '1',
  QVAC_AUDIOGEN_GGML_BENCHMARK_RUNS: '3',
  QVAC_AUDIOGEN_GGML_BENCHMARK_DURATION_S: '15'
}
const status = run('node', ['scripts/run-rtf-benchmark-matrix.js'], env)
const dir = join(PKG, 'benchmarks/results')
const files = existsSync(dir)
  ? readdirSync(dir).filter((f) => /^rtf-benchmark-.*\.json$/.test(f))
  : []
if (!files.length)
  console.log(
    '::error title=No RTF benchmark output::no benchmarks/results/rtf-benchmark-*.json produced'
  )
else console.log(`RTF benchmark produced ${files.length} result file(s)`)
process.exit(status === 0 && files.length ? 0 : 1)
