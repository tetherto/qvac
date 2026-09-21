#!/usr/bin/env node
'use strict'

// Runs `npm run test:benchmark:rtf` once per entry in
// QVAC_AUDIOGEN_GGML_BENCHMARK_MATRIX_JSON. The entry schema and the
// partial-failure contract are documented in benchmarks/RTF-BENCHMARKS.md.

const path = require('path')
const { spawnSync } = require('child_process')

const ENV_PREFIX = 'QVAC_AUDIOGEN_GGML_BENCHMARK'
const BENCHMARK_SCRIPT = 'test:benchmark:rtf'

const DEFAULT_DIT_VARIANT = 'turbo-q4'

// ACE-Step renders are minutes long, and the sft variant runs a ~50-step
// schedule on top of that, so the watchdog is deliberately generous. It exists
// only to stop a wedged entry from blocking the matrix forever, because
// spawnSync has no built-in timeout.
const DEFAULT_ENTRY_TIMEOUT_MS = 45 * 60 * 1000

const DEFAULT_MATRIX = [{ ditVariant: DEFAULT_DIT_VARIANT, useGPU: false, backendHint: 'cpu' }]

// Forwarded so a report can be traced back to a workflow run / commit / actor.
const CORRELATION_KEYS = [
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

// Optional per-entry overrides: matrix key -> env var suffix.
const OPTIONAL_SETTINGS = {
  numWarmup: 'WARMUP_RUNS',
  numRuns: 'RUNS',
  durationS: 'DURATION_S',
  inferenceSteps: 'INFERENCE_STEPS',
  shift: 'SHIFT',
  numThreads: 'NUM_THREADS',
  rtfUpperBound: 'RTF_UPPER_BOUND'
}

function envKey(suffix) {
  return `${ENV_PREFIX}_${suffix}`
}

function getNpmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm'
}

function getEntryTimeoutMs() {
  const parsed = Number.parseInt(process.env[envKey('ENTRY_TIMEOUT_MS')] || '', 10)
  if (Number.isFinite(parsed) && parsed > 0) return parsed
  return DEFAULT_ENTRY_TIMEOUT_MS
}

function getSpawnOptions(pkgDir, env) {
  const options = {
    cwd: pkgDir,
    env,
    stdio: 'inherit',
    timeout: getEntryTimeoutMs(),
    killSignal: 'SIGTERM'
  }
  if (process.platform === 'win32') options.shell = true
  return options
}

function parseMatrixConfig() {
  const raw = process.env[envKey('MATRIX_JSON')]
  if (!raw) return DEFAULT_MATRIX

  const parsed = JSON.parse(raw)
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`${envKey('MATRIX_JSON')} must be a non-empty JSON array`)
  }
  return parsed
}

function normalizeBoolean(value) {
  return value === true || value === 'true' || value === '1'
}

function buildLabel(entry, index) {
  if (entry.label) return String(entry.label)
  const variant = entry.ditVariant || DEFAULT_DIT_VARIANT
  const gpuTag = normalizeBoolean(entry.useGPU) ? 'gpu' : 'cpu'
  return `${index + 1}-${variant}-${gpuTag}`
}

// An entry field wins; otherwise the ambient env value passes through so a
// workflow can set a matrix-wide default without repeating it per entry.
function inherited(entry, entryKey, suffix) {
  if (entry[entryKey] !== undefined) return String(entry[entryKey])
  return process.env[envKey(suffix)] || ''
}

function applyOptionalSettings(env, entry) {
  for (const [entryKey, suffix] of Object.entries(OPTIONAL_SETTINGS)) {
    if (entry[entryKey] !== undefined) env[envKey(suffix)] = String(entry[entryKey])
  }
}

function applyCorrelation(env) {
  for (const key of CORRELATION_KEYS) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
}

function buildEnv(entry, index) {
  const env = {
    ...process.env,
    [envKey('DIT_VARIANT')]: String(entry.ditVariant || DEFAULT_DIT_VARIANT),
    [envKey('USE_GPU')]: normalizeBoolean(entry.useGPU) ? 'true' : 'false',
    [envKey('LABEL')]: buildLabel(entry, index),
    [envKey('BACKEND')]: inherited(entry, 'backendHint', 'BACKEND'),
    [envKey('DEVICE')]: inherited(entry, 'deviceLabel', 'DEVICE'),
    [envKey('RUNNER')]: inherited(entry, 'runnerLabel', 'RUNNER')
  }

  applyOptionalSettings(env, entry)
  applyCorrelation(env)
  return env
}

function logEntryHeader(env, index, matrixLen) {
  console.log('')
  console.log('='.repeat(70))
  console.log(`Running benchmark entry ${index + 1}/${matrixLen}`)
  console.log(`  ditVariant: ${env[envKey('DIT_VARIANT')]}`)
  console.log(`  useGPU:     ${env[envKey('USE_GPU')]}`)
  console.log(`  backend:    ${env[envKey('BACKEND')] || 'default'}`)
  console.log(`  label:      ${env[envKey('LABEL')]}`)
  console.log('='.repeat(70))
}

function timedOutError(env, index, elapsedMs, reason) {
  return new Error(
    `Benchmark entry ${index + 1} (${env[envKey('LABEL')]}) ${reason} after ${elapsedMs}ms ` +
      `(watchdog timeout ${getEntryTimeoutMs()}ms). ` +
      `Set ${envKey('ENTRY_TIMEOUT_MS')} to override.`
  )
}

function assertEntrySucceeded(result, env, index, elapsedMs) {
  if (result.error && result.error.code === 'ETIMEDOUT') {
    throw timedOutError(env, index, elapsedMs, 'exceeded its watchdog timeout')
  }
  if (result.error) throw result.error
  if (result.signal === 'SIGTERM') {
    throw timedOutError(env, index, elapsedMs, 'was killed by SIGTERM')
  }
  if (result.status !== 0) {
    throw new Error(
      `Benchmark entry ${index + 1} (${env[envKey('LABEL')]}) exited with status ${result.status}`
    )
  }
}

function runEntry(pkgDir, entry, index, matrixLen) {
  const env = buildEnv(entry, index)
  logEntryHeader(env, index, matrixLen)

  const startedAt = Date.now()
  const result = spawnSync(getNpmCommand(), ['run', BENCHMARK_SCRIPT], getSpawnOptions(pkgDir, env))
  assertEntrySucceeded(result, env, index, Date.now() - startedAt)
}

function runMatrix(pkgDir, matrix) {
  const failures = []
  for (let i = 0; i < matrix.length; i++) {
    try {
      runEntry(pkgDir, matrix[i], i, matrix.length)
    } catch (err) {
      console.error(`\n[matrix-runner] entry ${i + 1} failed: ${err.message}\n`)
      failures.push({ index: i + 1, entry: matrix[i], message: err.message })
    }
  }
  return failures
}

function reportFailures(matrixLen, failures) {
  console.log('')
  console.log(`Completed ${matrixLen - failures.length}/${matrixLen} benchmark configuration(s).`)
  if (failures.length === 0) return
  console.log(`${failures.length} failure(s):`)
  for (const failure of failures) {
    console.log(`  - entry ${failure.index}: ${failure.message}`)
  }
}

function main() {
  const pkgDir = path.resolve(__dirname, '..')
  const matrix = parseMatrixConfig()
  reportFailures(matrix.length, runMatrix(pkgDir, matrix))
}

if (require.main === module) {
  main()
}

module.exports = {
  DEFAULT_DIT_VARIANT,
  DEFAULT_MATRIX,
  parseMatrixConfig,
  normalizeBoolean,
  buildLabel,
  buildEnv,
  getEntryTimeoutMs
}
