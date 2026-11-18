#!/usr/bin/env node
// tts's RTF benchmark, as main's desktop test workflow ran it after the tests: a named set from ci/benchmark-matrix.json as
// QVAC_TTS_GGML_BENCHMARK_MATRIX_JSON, in the tests' environment, then scripts/run-rtf-benchmark-matrix.js into
// benchmarks/results. It fails when the matrix fails or writes no result file.
//
//   node ci/benchmark.mjs --matrix <set> [--lib <dir>] [--set NAME=value]...

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { options, run } from './integration.mjs'

const PKG = fileURLToPath(new URL('..', import.meta.url))
const o = options(process.argv.slice(2))
const sets = JSON.parse(readFileSync(join(PKG, 'ci/benchmark-matrix.json'), 'utf8'))
const matrix = sets[o.matrix]
if (!matrix) throw new Error(`--matrix takes one of ${Object.keys(sets).join(', ')}`)
const status = run('node', ['scripts/run-rtf-benchmark-matrix.js'], {
  ...o.env,
  QVAC_TTS_GGML_BENCHMARK_MATRIX_JSON: JSON.stringify(matrix)
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
process.exit(status === 0 && files.length ? 0 : 1)
