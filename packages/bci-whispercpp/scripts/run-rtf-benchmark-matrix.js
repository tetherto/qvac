#!/usr/bin/env node
'use strict'

// Drives the BCI throughput benchmark (test/benchmark/rtf-benchmark.test.js)
// once per matrix entry, passing each entry's config through QVAC_BCI_BENCHMARK_*
// env vars. The matrix is supplied as JSON via QVAC_BCI_BENCHMARK_MATRIX_JSON
// (set per-runner by integration-test-bci-whispercpp.yml). BCI ships a single
// registry model, so the matrix sweeps platform × CPU/GPU backend rather than
// model quantizations.

const path = require('path')
const { spawnSync } = require('child_process')

function getNpmCommand () {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm'
}

function getSpawnOptions (pkgDir, env) {
  const options = { cwd: pkgDir, env, stdio: 'inherit' }
  if (process.platform === 'win32') options.shell = true
  return options
}

function parseMatrixConfig () {
  const raw = process.env.QVAC_BCI_BENCHMARK_MATRIX_JSON
  if (!raw) {
    return [{ useGPU: false }]
  }
  const parsed = JSON.parse(raw)
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('QVAC_BCI_BENCHMARK_MATRIX_JSON must be a non-empty JSON array')
  }
  return parsed
}

function normalizeBoolean (value) {
  return value === true || value === 'true' || value === '1'
}

function buildLabel (entry, index) {
  if (entry.label) return String(entry.label)
  const model = String(entry.modelFile || 'ggml-bci-windowed.bin').replace(/\.bin$/, '')
  return `${index + 1}-${model}-${normalizeBoolean(entry.useGPU) ? 'gpu' : 'cpu'}`
}

function runBenchmarkEntry (pkgDir, entry, index) {
  const env = {
    ...process.env,
    QVAC_BCI_BENCHMARK_MODEL_FILE: String(entry.modelFile || 'ggml-bci-windowed.bin'),
    QVAC_BCI_BENCHMARK_USE_GPU: normalizeBoolean(entry.useGPU) ? 'true' : 'false',
    QVAC_BCI_BENCHMARK_LABEL: buildLabel(entry, index),
    QVAC_BCI_BENCHMARK_BACKEND: entry.backendHint ? String(entry.backendHint) : (process.env.QVAC_BCI_BENCHMARK_BACKEND || ''),
    QVAC_BCI_BENCHMARK_DEVICE: entry.deviceLabel ? String(entry.deviceLabel) : (process.env.QVAC_BCI_BENCHMARK_DEVICE || ''),
    QVAC_BCI_BENCHMARK_RUNNER: entry.runnerLabel ? String(entry.runnerLabel) : (process.env.QVAC_BCI_BENCHMARK_RUNNER || '')
  }

  if (entry.threads !== undefined) env.QVAC_BCI_BENCHMARK_THREADS = String(entry.threads)
  if (entry.numRuns !== undefined) env.QVAC_BCI_BENCHMARK_RUNS = String(entry.numRuns)
  if (entry.numWarmup !== undefined) env.QVAC_BCI_BENCHMARK_WARMUP_RUNS = String(entry.numWarmup)

  console.log('')
  console.log('='.repeat(70))
  console.log(`Running BCI benchmark entry ${index + 1}`)
  console.log(`  modelFile: ${env.QVAC_BCI_BENCHMARK_MODEL_FILE}`)
  console.log(`  useGPU:    ${env.QVAC_BCI_BENCHMARK_USE_GPU}`)
  console.log(`  backend:   ${env.QVAC_BCI_BENCHMARK_BACKEND || 'default'}`)
  console.log(`  label:     ${env.QVAC_BCI_BENCHMARK_LABEL}`)
  console.log('='.repeat(70))

  const result = spawnSync(getNpmCommand(), ['run', 'test:benchmark:rtf'], getSpawnOptions(pkgDir, env))

  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`Benchmark entry failed for ${env.QVAC_BCI_BENCHMARK_LABEL} (exit ${result.status})`)
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
