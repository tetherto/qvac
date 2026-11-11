#!/usr/bin/env node
// audiogen's test:mobile, as main's audiogen mobile workflow prepared it: on Android the host pre-stages the
// tested dit variant's models from presigned URLs in the US bucket. A benchmarks.yml run picks its matrix row in
// BENCHMARK_ARGS (dit_variant, use_gpu, warmup, runs, duration), runs the perf tests only and turns on the perf report.

import { appendFileSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { emitOutputs } from '../../../scripts/ci/mobile-prestage.mjs'

const PKG = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(import.meta.url)

// key=value words, with main's per-row defaults: sft rows ran shorter.
export function benchmarkRow(words) {
  const row = { dit_variant: 'turbo-q4', use_gpu: 'false' }
  for (const word of words) {
    const at = word.indexOf('=')
    if (at < 1) throw new Error(`BENCHMARK_ARGS word '${word}' is not key=value`)
    row[word.slice(0, at)] = word.slice(at + 1)
  }
  const sft = row.dit_variant === 'sft'
  const out = {
    warmup: sft ? '0' : '1',
    runs: sft ? '1' : '2',
    duration: sft ? '10' : '15',
    ...row
  }
  const known = ['dit_variant', 'use_gpu', 'warmup', 'runs', 'duration']
  const unknown = Object.keys(out).filter((k) => !known.includes(k))
  if (unknown.length)
    throw new Error(`BENCHMARK_ARGS takes ${known.join(', ')}; got ${unknown.join(', ')}`)
  return out
}

export function deviceEnv(row, platform) {
  const gpu = row.use_gpu === 'true'
  return [
    `QVAC_AUDIOGEN_GGML_BENCHMARK_DIT_VARIANT=${row.dit_variant}`,
    `QVAC_AUDIOGEN_GGML_BENCHMARK_USE_GPU=${gpu ? '1' : '0'}`,
    `QVAC_AUDIOGEN_GGML_BENCHMARK_WARMUP_RUNS=${row.warmup}`,
    `QVAC_AUDIOGEN_GGML_BENCHMARK_RUNS=${row.runs}`,
    `QVAC_AUDIOGEN_GGML_BENCHMARK_DURATION_S=${row.duration}`,
    `QVAC_AUDIOGEN_GGML_BENCHMARK_DEVICE=${platform}-device-farm`,
    `QVAC_AUDIOGEN_GGML_BENCHMARK_RUNNER=aws-device-farm-${platform}`,
    `QVAC_AUDIOGEN_GGML_BENCHMARK_LABEL=${platform}-${row.dit_variant}-${gpu ? 'gpu' : 'cpu'}`
  ].join(';')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = process.env
  const words = (env.BENCHMARK_ARGS ?? '').split(/\s+/).filter(Boolean)
  const row = benchmarkRow(words)
  if (env.PLATFORM === 'Android') {
    const block = require('../scripts/generate-mobile-prestage-block.js')
    const entries = block.presignEntries(
      env.MODEL_S3_BUCKET,
      block.prestageEntries(row.dit_variant),
      env.MODEL_PRESIGN_EXPIRES_IN || '7200'
    )
    const text = block.asYamlBlock(block.buildAndroidScript(entries))
    appendFileSync(env.GITHUB_OUTPUT, `pre-test-commands<<PRESTAGE_EOF\n${text}\nPRESTAGE_EOF\n`)
  }
  if (words.length) {
    const grep = JSON.parse(readFileSync(join(PKG, 'test/mobile/perf-tests.json'), 'utf8')).join(
      '|'
    )
    if (!grep) throw new Error('perf-tests.json is empty; no benchmarks to run')
    emitOutputs({
      'test-groups': JSON.stringify([{ name: 'perf', grep }]),
      'device-env': deviceEnv(row, env.PLATFORM),
      'enables-perf': 'true'
    })
  }
  execFileSync('node', ['../../scripts/ci/check-speech-ggml-builds.mjs', '--package', '.'], {
    cwd: PKG,
    stdio: 'inherit'
  })
}
