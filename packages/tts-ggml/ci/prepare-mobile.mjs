#!/usr/bin/env node
// tts's test:mobile, as main's tts mobile workflow prepared it: the advisory staleness check, the presigned
// mobile model manifest from the US bucket, and the Device Farm host's pre-stage block (Android always, iOS on a
// benchmark run). A benchmarks.yml run picks its matrix row in BENCHMARK_ARGS (engine, variant, use_gpu, enhancer,
// enhancer_variant, denoiser), injects it into the mobile runtime, runs the perf tests only and turns on the report.

import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { emitOutputs } from '../../../scripts/ci/mobile-prestage.mjs'

const PKG = fileURLToPath(new URL('..', import.meta.url))
const DEFAULTS = {
  engine: 'chatterbox',
  variant: 'q4',
  use_gpu: 'false',
  enhancer: 'none',
  enhancer_variant: 'f16',
  denoiser: 'none'
}

export function benchmarkRow(words) {
  const row = { ...DEFAULTS }
  for (const word of words) {
    const at = word.indexOf('=')
    if (at < 1) throw new Error(`BENCHMARK_ARGS word '${word}' is not key=value`)
    const key = word.slice(0, at)
    if (!(key in DEFAULTS))
      throw new Error(`BENCHMARK_ARGS takes ${Object.keys(DEFAULTS).join(', ')}; got ${key}`)
    row[key] = word.slice(at + 1)
  }
  return row
}

// The runtime prologue main's workflow wrote, so the on-device benchmark shims read the row through bare-os.getEnv.
export function injectEnv(row, platform) {
  const gpu = row.use_gpu === 'true' ? 'gpu' : 'cpu'
  const tags = `${row.enhancer === 'lavasr' ? '-lavasr' : ''}${row.denoiser === 'lavasr' ? '-denoise' : ''}`
  const values = {
    QVAC_TTS_GGML_RUN_BENCHMARK_ON_MOBILE: '1',
    QVAC_TTS_GGML_BENCHMARK_DEVICE: `${platform}-device-farm`,
    QVAC_TTS_GGML_BENCHMARK_RUNNER: `aws-device-farm-${platform}`,
    QVAC_TTS_GGML_BENCHMARK_LABEL: `${platform}-${row.engine}-${row.variant}-${gpu}${tags}`,
    QVAC_TTS_GGML_BENCHMARK_VARIANT: row.variant,
    QVAC_TTS_GGML_BENCHMARK_ENGINE: row.engine,
    QVAC_TTS_GGML_BENCHMARK_USE_GPU: row.use_gpu === 'true' ? '1' : '0',
    QVAC_TTS_GGML_BENCHMARK_ENHANCER: row.enhancer,
    QVAC_TTS_GGML_BENCHMARK_ENHANCER_VARIANT: row.enhancer_variant,
    QVAC_TTS_GGML_BENCHMARK_DENOISER: row.denoiser,
    QVAC_TTS_GGML_BENCHMARK_QUALITY: 'true',
    QVAC_TTS_GGML_BENCHMARK_WHISPER_MODEL: 'ggml-tiny.bin'
  }
  const cases = Object.entries(values)
    .map(([k, v]) => `  if (key === ${JSON.stringify(k)}) return ${JSON.stringify(v)}`)
    .join('\n')
  return `const os = require('bare-os')
const originalGetEnv = os.getEnv
os.getEnv = function (key) {
${cases}
  return originalGetEnv ? originalGetEnv.call(this, key) : undefined
}
`
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = process.env
  const sh = (cmd, args, extra = {}) =>
    execFileSync(cmd, args, { cwd: PKG, stdio: 'inherit', env: { ...env, ...extra } })
  const words = (env.BENCHMARK_ARGS ?? '').split(/\s+/).filter(Boolean)
  const benchmark = words.length > 0
  const row = benchmarkRow(words)
  try {
    sh('npm', ['run', 'test:mobile:validate'])
  } catch {
    console.log('::warning::test:mobile:validate failed; the mobile tests may be stale')
  }
  const android = env.PLATFORM === 'Android'
  if (android || benchmark) sh('node', ['scripts/generate-mobile-model-manifest.js'])
  if (benchmark) {
    const runtime = join(PKG, 'test/mobile/integration-runtime.cjs')
    writeFileSync(runtime, injectEnv(row, env.PLATFORM) + readFileSync(runtime, 'utf8'))
  }
  if (android || benchmark) {
    const block = execFileSync(
      'node',
      ['scripts/generate-prestage-block.js', android ? 'android' : 'ios'],
      {
        cwd: PKG,
        encoding: 'utf8',
        env: {
          ...env,
          TTS_GGML_MOBILE_BENCHMARK_VARIANT: row.variant,
          // As main: the iOS block took no engine, so it stages chatterbox's models.
          TTS_GGML_MOBILE_BENCHMARK_ENGINE: android ? row.engine : '',
          TTS_GGML_MOBILE_BENCHMARK_ENHANCER: row.enhancer,
          TTS_GGML_MOBILE_BENCHMARK_DENOISER: row.denoiser,
          TTS_GGML_MOBILE_BENCHMARK_QUALITY: 'true',
          TTS_GGML_MOBILE_FUNCTIONAL_MULTI_SPEC: String(!benchmark)
        }
      }
    )
    appendFileSync(env.GITHUB_OUTPUT, `pre-test-commands<<PRESTAGE_EOF\n${block}\nPRESTAGE_EOF\n`)
  }
  if (benchmark) {
    const grep = JSON.parse(readFileSync(join(PKG, 'test/mobile/perf-tests.json'), 'utf8')).join(
      '|'
    )
    if (!grep) throw new Error('perf-tests.json is empty; no benchmarks to run')
    emitOutputs({ 'test-groups': JSON.stringify([{ name: 'perf', grep }]), 'enables-perf': 'true' })
  }
  sh('node', ['../../scripts/ci/check-speech-ggml-builds.mjs', '--package', '.'])
}
