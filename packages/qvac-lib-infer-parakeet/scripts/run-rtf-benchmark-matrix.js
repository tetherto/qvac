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
  return `${index + 1}-${entry.modelType}-${normalizeBoolean(entry.useGPU) ? 'gpu' : 'cpu'}`
}

function runBenchmarkEntry (pkgDir, entry, index) {
  const label = buildLabel(entry, index)
  const env = {
    ...process.env,
    QVAC_PARAKEET_BENCHMARK_MODEL_TYPE: String(entry.modelType || 'tdt'),
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

  for (let i = 0; i < matrix.length; i++) {
    runBenchmarkEntry(pkgDir, matrix[i], i)
  }

  console.log('')
  console.log(`Completed ${matrix.length} benchmark configuration(s).`)
}

main()
