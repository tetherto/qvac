#!/usr/bin/env node
// asr's test:mobile, as integration-mobile-test-asr-ggml.yml prepared it: the advisory staleness check, the presigned
// mobile model manifest from the US bucket and the Device Farm host's pre-stage block. A benchmarks.yml run picks one
// on-device perf runner in BENCHMARK_ARGS (engine, model or model_type, use_gpu) and runs only that.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { emitOutputs, emitPrestage } from '../../../scripts/ci/mobile-prestage.mjs'
import { dispatch } from './benchmark.mjs'

const PKG = fileURLToPath(new URL('..', import.meta.url))

const PARAKEET = {
  ctc: 'Ctc',
  tdt: 'Tdt',
  unified: 'Unified',
  eou: 'Eou',
  sortformer: 'Sortformer',
  'sortformer-streaming': 'SortformerStreaming'
}

// The perf runner main's workflow mapped each benchmark row to, checked against perf-tests.json.
export function perfRunner(d, registered) {
  const backend = d.use_gpu === 'true' ? 'Gpu' : 'Cpu'
  let runner = ''
  if (d.engine === 'whisper' && d.model === 'ggml-tiny') runner = `runMobilePerfTiny${backend}Test`
  if (d.engine === 'whisper' && d.model === 'sweep') runner = `runMobilePerfSweep${backend}Test`
  if (d.engine === 'parakeet' && PARAKEET[d.model_type])
    runner = `runParakeetMobilePerf${PARAKEET[d.model_type]}${backend}Test`
  if (!runner)
    throw new Error(
      `no on-device benchmark runner maps to engine=${d.engine} model=${d.model} model_type=${d.model_type}`
    )
  if (!registered.includes(runner))
    throw new Error(`${runner} is not registered in test/mobile/perf-tests.json`)
  return runner
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const sh = (cmd, args) => execFileSync(cmd, args, { cwd: PKG, stdio: 'inherit' })
  const words = (process.env.BENCHMARK_ARGS ?? '').split(/\s+/).filter(Boolean)
  try {
    sh('npm', ['run', 'test:mobile:validate'])
  } catch {
    console.log('::warning::test:mobile:validate failed; the mobile tests may be stale')
  }
  sh('node', ['scripts/generate-mobile-model-manifest.js'])
  emitPrestage(PKG)
  if (words.length) {
    const registered = JSON.parse(readFileSync(join(PKG, 'test/mobile/perf-tests.json'), 'utf8'))
    const grep = perfRunner(dispatch(words), registered)
    emitOutputs({ 'test-groups': JSON.stringify([{ name: 'perf', grep }]) })
  }
  sh('node', ['../../scripts/ci/check-speech-ggml-builds.mjs', '--package', '.'])
}
