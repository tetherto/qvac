#!/usr/bin/env node
'use strict'

/**
 * Runs `npm run test:benchmark:rtf` once per entry in a matrix JSON array,
 * setting QVAC_TTS_GGML_BENCHMARK_* env vars for each entry.
 *
 * The matrix is read from QVAC_TTS_GGML_BENCHMARK_MATRIX_JSON (stringified array).
 * Each entry has the shape:
 *   {
 *     "engine": "chatterbox" | "chatterbox-mtl" | "supertonic" | "supertonic-mtl",
 *     "variant": "q4" | "q8" | "f16" | "mixed",              (optional, default q4)
 *     "useGPU": true | false,
 *     "backendHint": "cpu" | "metal" | "vulkan" | "opencl",  (optional)
 *     "deviceLabel": "...",                                  (optional)
 *     "runnerLabel": "...",                                  (optional)
 *     "label": "...",                                        (optional)
 *     "numWarmup": 1,                                        (optional)
 *     "numRuns": 5,                                          (optional)
 *     "numThreads": 8,                                       (optional)
 *     "rtfUpperBound": 1.5                                   (optional)
 *   }
 *
 * If QVAC_TTS_GGML_BENCHMARK_MATRIX_JSON is empty, a small default matrix
 * (chatterbox + chatterbox-mtl + supertonic + supertonic-mtl, CPU-only) is run.
 */

const path = require('path')
const { spawnSync } = require('child_process')

function getNpmCommand () {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm'
}

// Per-entry watchdog. Without this, a single hung benchmark entry blocks the
// whole matrix run forever (spawnSync has no built-in timeout). Most entries
// finish in 1-6 minutes; QVAC_TTS_GGML_BENCHMARK_ENTRY_TIMEOUT_MS lets CI
// override per-runner if needed.
const DEFAULT_ENTRY_TIMEOUT_MS = 10 * 60 * 1000 // 10 minutes
function getEntryTimeoutMs () {
  const raw = process.env.QVAC_TTS_GGML_BENCHMARK_ENTRY_TIMEOUT_MS
  const parsed = Number.parseInt(raw || '', 10)
  if (Number.isFinite(parsed) && parsed > 0) return parsed
  return DEFAULT_ENTRY_TIMEOUT_MS
}

function getSpawnOptions (pkgDir, env) {
  const options = {
    cwd: pkgDir,
    env,
    stdio: 'inherit',
    // Watchdog: kill the child after this much wall-clock time. Surfaces hung
    // entries as ETIMEDOUT / SIGTERM so the matrix loop can continue with
    // the next entry instead of blocking forever.
    timeout: getEntryTimeoutMs(),
    killSignal: 'SIGTERM'
  }
  if (process.platform === 'win32') {
    options.shell = true
  }
  return options
}

function parseMatrixConfig () {
  const raw = process.env.QVAC_TTS_GGML_BENCHMARK_MATRIX_JSON
  if (!raw) {
    return [
      { engine: 'chatterbox', useGPU: false, backendHint: 'cpu' },
      { engine: 'chatterbox-mtl', useGPU: false, backendHint: 'cpu' },
      { engine: 'supertonic', useGPU: false, backendHint: 'cpu' },
      { engine: 'supertonic-mtl', useGPU: false, backendHint: 'cpu' }
    ]
  }

  const parsed = JSON.parse(raw)
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('QVAC_TTS_GGML_BENCHMARK_MATRIX_JSON must be a non-empty JSON array')
  }
  return parsed
}

function normalizeBoolean (value) {
  return value === true || value === 'true' || value === '1'
}

function buildLabel (entry, index) {
  if (entry.label) return String(entry.label)
  const gpuTag = normalizeBoolean(entry.useGPU) ? 'gpu' : 'cpu'
  return `${index + 1}-${entry.engine || 'tts'}-${gpuTag}`
}

function buildEnv (entry, index) {
  const label = buildLabel(entry, index)
  const env = {
    ...process.env,
    QVAC_TTS_GGML_BENCHMARK_ENGINE: String(entry.engine || 'chatterbox'),
    QVAC_TTS_GGML_BENCHMARK_VARIANT: String(entry.variant || process.env.QVAC_TTS_GGML_BENCHMARK_VARIANT || 'q4'),
    QVAC_TTS_GGML_BENCHMARK_USE_GPU: normalizeBoolean(entry.useGPU) ? 'true' : 'false',
    QVAC_TTS_GGML_BENCHMARK_LABEL: label,
    QVAC_TTS_GGML_BENCHMARK_BACKEND:
      entry.backendHint !== undefined
        ? String(entry.backendHint)
        : (process.env.QVAC_TTS_GGML_BENCHMARK_BACKEND || ''),
    QVAC_TTS_GGML_BENCHMARK_DEVICE:
      entry.deviceLabel !== undefined
        ? String(entry.deviceLabel)
        : (process.env.QVAC_TTS_GGML_BENCHMARK_DEVICE || ''),
    QVAC_TTS_GGML_BENCHMARK_RUNNER:
      entry.runnerLabel !== undefined
        ? String(entry.runnerLabel)
        : (process.env.QVAC_TTS_GGML_BENCHMARK_RUNNER || '')
  }

  if (entry.numWarmup !== undefined) {
    env.QVAC_TTS_GGML_BENCHMARK_WARMUP_RUNS = String(entry.numWarmup)
  }
  if (entry.numRuns !== undefined) {
    env.QVAC_TTS_GGML_BENCHMARK_RUNS = String(entry.numRuns)
  }
  if (entry.numThreads !== undefined) {
    env.QVAC_TTS_GGML_BENCHMARK_NUM_THREADS = String(entry.numThreads)
  }
  if (entry.rtfUpperBound !== undefined) {
    env.QVAC_TTS_GGML_BENCHMARK_RTF_UPPER_BOUND = String(entry.rtfUpperBound)
  }

  // Forward GitHub Actions correlation env vars so the report can be traced
  // back to a specific workflow run / commit / actor.
  const correlationKeys = [
    'GITHUB_RUN_ID',
    'GITHUB_RUN_ATTEMPT',
    'GITHUB_SHA',
    'GITHUB_REF_NAME',
    'GITHUB_ACTOR',
    'GITHUB_WORKFLOW',
    'GITHUB_JOB',
    'GITHUB_SERVER_URL',
    'GITHUB_REPOSITORY'
  ]
  for (const key of correlationKeys) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }

  return env
}

function runEntry (pkgDir, entry, index, matrixLen) {
  const env = buildEnv(entry, index)

  console.log('')
  console.log('='.repeat(70))
  console.log(`Running benchmark entry ${index + 1}/${matrixLen}`)
  console.log(`  engine:     ${env.QVAC_TTS_GGML_BENCHMARK_ENGINE}`)
  console.log(`  variant:    ${env.QVAC_TTS_GGML_BENCHMARK_VARIANT}`)
  console.log(`  useGPU:     ${env.QVAC_TTS_GGML_BENCHMARK_USE_GPU}`)
  console.log(`  backend:    ${env.QVAC_TTS_GGML_BENCHMARK_BACKEND || 'default'}`)
  console.log(`  label:      ${env.QVAC_TTS_GGML_BENCHMARK_LABEL}`)
  console.log('='.repeat(70))

  const startedAt = Date.now()
  const result = spawnSync(
    getNpmCommand(),
    ['run', 'test:benchmark:rtf'],
    getSpawnOptions(pkgDir, env)
  )
  const elapsedMs = Date.now() - startedAt

  // Watchdog hit: spawnSync timed out and SIGTERM'd the child. Surface this
  // distinctly from "child exited with non-zero status" so the matrix-runner
  // log makes the timeout reason obvious in CI.
  if (result.error && result.error.code === 'ETIMEDOUT') {
    const timeoutMs = getEntryTimeoutMs()
    throw new Error(
      `Benchmark entry ${index + 1} (${env.QVAC_TTS_GGML_BENCHMARK_LABEL}) ` +
      `exceeded watchdog timeout of ${timeoutMs}ms (elapsed ${elapsedMs}ms) ` +
      'and was terminated. Set QVAC_TTS_GGML_BENCHMARK_ENTRY_TIMEOUT_MS to override.'
    )
  }

  if (result.error) {
    throw result.error
  }

  // Any other path where spawn returned with the watchdog signal — also a
  // timeout-equivalent (e.g. on platforms where ETIMEDOUT is not surfaced).
  if (result.signal === 'SIGTERM') {
    const timeoutMs = getEntryTimeoutMs()
    throw new Error(
      `Benchmark entry ${index + 1} (${env.QVAC_TTS_GGML_BENCHMARK_LABEL}) ` +
      `was killed by SIGTERM after ${elapsedMs}ms ` +
      `(watchdog timeout ${timeoutMs}ms).`
    )
  }

  if (result.status !== 0) {
    throw new Error(`Benchmark entry ${index + 1} (${env.QVAC_TTS_GGML_BENCHMARK_LABEL}) exited with status ${result.status}`)
  }
}

function main () {
  const pkgDir = path.resolve(__dirname, '..')
  const matrix = parseMatrixConfig()
  const failures = []

  for (let i = 0; i < matrix.length; i++) {
    try {
      runEntry(pkgDir, matrix[i], i, matrix.length)
    } catch (err) {
      console.error(`\n[matrix-runner] entry ${i + 1} failed: ${err.message}\n`)
      failures.push({ index: i + 1, entry: matrix[i], message: err.message })
    }
  }

  console.log('')
  console.log(`Completed ${matrix.length - failures.length}/${matrix.length} benchmark configuration(s).`)

  if (failures.length > 0) {
    console.log(`${failures.length} failure(s):`)
    for (const f of failures) {
      console.log(`  - entry ${f.index}: ${f.message}`)
    }
    // Do not fail the whole matrix: we want partial artifacts uploaded even
    // if one engine fails on a platform. The CI job should mark this step as
    // continue-on-error so aggregation still runs.
    process.exit(0)
  }
}

main()
