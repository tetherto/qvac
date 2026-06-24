#!/usr/bin/env node
'use strict'

const path = require('path')
const { spawnSync } = require('child_process')

function getNpmCommand () {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm'
}

function getSpawnOptions (pkgDir, env) {
  const options = {
    cwd: pkgDir,
    env,
    stdio: 'inherit'
  }

  if (process.platform === 'win32') {
    options.shell = true
  }

  return options
}

function parseMatrixConfig () {
  const raw = process.env.QVAC_PARAKEET_BENCHMARK_MATRIX_JSON
  if (!raw) {
    return [
      { modelType: 'tdt', useGPU: false },
      { modelType: 'ctc', useGPU: false },
      { modelType: 'eou', useGPU: false },
      { modelType: 'sortformer', useGPU: false }
    ]
  }

  const parsed = JSON.parse(raw)
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('QVAC_PARAKEET_BENCHMARK_MATRIX_JSON must be a non-empty JSON array')
  }

  return parsed
}

function normalizeBoolean (value) {
  return value === true || value === 'true' || value === '1'
}

function buildLabel (entry, index) {
  if (entry.label) return String(entry.label)
  const quantPart = entry.quant ? `-${entry.quant}` : ''
  return `${index + 1}-${entry.modelType}${quantPart}-${normalizeBoolean(entry.useGPU) ? 'gpu' : 'cpu'}`
}

function runBenchmarkEntry (pkgDir, entry, index) {
  const label = buildLabel(entry, index)
  const env = {
    ...process.env,
    QVAC_PARAKEET_BENCHMARK_MODEL_TYPE: String(entry.modelType || 'tdt'),
    QVAC_PARAKEET_BENCHMARK_QUANT: entry.quant ? String(entry.quant) : (process.env.QVAC_PARAKEET_BENCHMARK_QUANT || ''),
    QVAC_PARAKEET_BENCHMARK_USE_GPU: normalizeBoolean(entry.useGPU) ? 'true' : 'false',
    QVAC_PARAKEET_BENCHMARK_LABEL: label,
    QVAC_PARAKEET_BENCHMARK_BACKEND: entry.backendHint ? String(entry.backendHint) : (process.env.QVAC_PARAKEET_BENCHMARK_BACKEND || ''),
    QVAC_PARAKEET_BENCHMARK_DEVICE: entry.deviceLabel ? String(entry.deviceLabel) : (process.env.QVAC_PARAKEET_BENCHMARK_DEVICE || ''),
    QVAC_PARAKEET_BENCHMARK_RUNNER: entry.runnerLabel ? String(entry.runnerLabel) : (process.env.QVAC_PARAKEET_BENCHMARK_RUNNER || '')
  }

  if (entry.maxThreads !== undefined) {
    env.QVAC_PARAKEET_BENCHMARK_THREADS = String(entry.maxThreads)
  }
  if (entry.numRuns !== undefined) {
    env.QVAC_PARAKEET_BENCHMARK_RUNS = String(entry.numRuns)
  }
  if (entry.numWarmup !== undefined) {
    env.QVAC_PARAKEET_BENCHMARK_WARMUP_RUNS = String(entry.numWarmup)
  }
  if (entry.rtfUpperBound !== undefined) {
    env.QVAC_PARAKEET_BENCHMARK_RTF_UPPER_BOUND = String(entry.rtfUpperBound)
  }

  console.log('')
  console.log('='.repeat(70))
  console.log(`Running benchmark entry ${index + 1}`)
  console.log(`  modelType:  ${env.QVAC_PARAKEET_BENCHMARK_MODEL_TYPE}`)
  console.log(`  quant:      ${env.QVAC_PARAKEET_BENCHMARK_QUANT || 'default'}`)
  console.log(`  useGPU:     ${env.QVAC_PARAKEET_BENCHMARK_USE_GPU}`)
  console.log(`  backend:    ${env.QVAC_PARAKEET_BENCHMARK_BACKEND || 'default'}`)
  console.log(`  label:      ${env.QVAC_PARAKEET_BENCHMARK_LABEL}`)
  console.log('='.repeat(70))

  const result = spawnSync(
    getNpmCommand(),
    ['run', 'test:benchmark:rtf'],
    getSpawnOptions(pkgDir, env)
  )

  if (result.error) {
    throw result.error
  }

  if (result.status !== 0) {
    throw new Error(`Benchmark entry failed for ${label} (exit ${result.status})`)
  }
}

function main () {
  const pkgDir = path.resolve(__dirname, '..')
  const matrix = parseMatrixConfig()
  const failures = []

  for (let i = 0; i < matrix.length; i++) {
    try {
      runBenchmarkEntry(pkgDir, matrix[i], i)
    } catch (err) {
      console.error(`\n[matrix-runner] entry ${i + 1} failed: ${err.message}\n`)
      failures.push({ index: i + 1, message: err.message })
    }
  }

  console.log('')
  console.log(`Completed ${matrix.length - failures.length}/${matrix.length} benchmark configuration(s).`)

  if (failures.length > 0) {
    console.log(`${failures.length} failure(s):`)
    for (const f of failures) console.log(`  - entry ${f.index}: ${f.message}`)
    // Don't fail the whole matrix: a single model-type / backend failure on a
    // platform should still let the remaining configs' artifacts upload and be
    // aggregated. The CI step keeps going; summarize renders whatever landed.
    process.exit(0)
  }
}

main()
