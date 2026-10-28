#!/usr/bin/env node
// asr's benchmarks: suite=rtf (the RTF matrix of both engines, as main's asr integration workflow ran it) or
// suite=accuracy (WER/CER, as main's asr accuracy workflow ran it), chosen in BENCHMARK_ARGS as key=value words; rtf when
// none is given. Each configuration names the suite its host serves; a host that serves another does nothing.
//
//   node ci/benchmark.mjs --suite rtf --config <configuration> [--no-gpu] [--set NAME=value]...
//   node ci/benchmark.mjs --suite accuracy

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { install, libEnv, options, run } from './integration.mjs'

const PKG = fileURLToPath(new URL('..', import.meta.url))

// The accuracy keys and main's dispatch defaults; the mobile keys pick a mobile benchmark row.
export const KEYS = {
  suite: 'rtf',
  engine: 'whisper',
  dataset: 'librispeech',
  language: 'english',
  model_size: 'tiny',
  model_type: 'tdt',
  custom_model_repo: '',
  streaming_mode: 'false',
  max_samples: '-1',
  model: 'ggml-tiny',
  use_gpu: 'false'
}

export function dispatch(words) {
  const out = { ...KEYS }
  for (const word of words) {
    const at = word.indexOf('=')
    if (at < 1) throw new Error(`BENCHMARK_ARGS word '${word}' is not key=value`)
    const key = word.slice(0, at)
    if (!(key in KEYS))
      throw new Error(`BENCHMARK_ARGS takes ${Object.keys(KEYS).join(', ')}; got ${key}`)
    out[key] = word.slice(at + 1)
  }
  if (!['rtf', 'accuracy'].includes(out.suite)) throw new Error('suite is rtf or accuracy')
  return out
}

function rtf(o) {
  install()
  // Core ML sidecars are darwin-only and outside the contract's model download.
  if (
    process.platform === 'darwin' &&
    run('node', ['scripts/stage-integration-models.mjs', '--coreml-only']) !== 0
  )
    process.exit(1)
  const matrix = JSON.parse(
    readFileSync(join(PKG, 'ci/benchmark-matrix', `${o.config}.json`), 'utf8')
  )
  const status = run('node', ['scripts/run-rtf-benchmark-matrix.js'], {
    ...process.env,
    ...o.set,
    ...libEnv(),
    NO_GPU: o['no-gpu'] ? 'true' : 'false',
    QVAC_ASR_GGML_BENCHMARK_MATRIX_JSON: JSON.stringify(matrix),
    QVAC_PARAKEET_ADD_UNIFIED_COVERAGE: 'true'
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
  return status === 0 && files.length ? 0 : 1
}

function accuracy(d) {
  install()
  const env = { ...process.env }
  for (const [k, v] of Object.entries(d)) env[`BM_${k.toUpperCase()}`] = v
  return run('bash', ['ci/benchmark-accuracy.sh'], env)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const d = dispatch((process.env.BENCHMARK_ARGS ?? '').split(/\s+/).filter(Boolean))
  const o = options(process.argv.slice(2))
  if (d.suite !== o.suite) {
    console.log(`suite=${d.suite} does not run on this host (it serves ${o.suite})`)
    process.exit(0)
  }
  process.exit(d.suite === 'rtf' ? rtf(o) : accuracy(d))
}
