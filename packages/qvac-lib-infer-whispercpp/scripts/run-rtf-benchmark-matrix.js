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
  const raw = process.env.QVAC_WHISPER_BENCHMARK_MATRIX_JSON
  if (!raw) {
    return [
      { modelFile: 'ggml-tiny.bin', useGPU: false }
    ]
  }

  const parsed = JSON.parse(raw)
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('QVAC_WHISPER_BENCHMARK_MATRIX_JSON must be a non-empty JSON array')
  }

  return parsed
}

function normalizeBoolean (value) {
  return value === true || value === 'true' || value === '1'
}

function buildLabel (entry, index) {
  if (entry.label) return String(entry.label)
  const model = String(entry.modelFile || 'ggml-tiny.bin').replace(/\.bin$/, '')
  return `${index + 1}-${model}-${normalizeBoolean(entry.useGPU) ? 'gpu' : 'cpu'}`
}

function runBenchmarkEntry (pkgDir, entry, index) {
  const env = {
    ...process.env,
    QVAC_WHISPER_BENCHMARK_MODEL_FILE: String(entry.modelFile || 'ggml-tiny.bin'),
    QVAC_WHISPER_BENCHMARK_USE_GPU: normalizeBoolean(entry.useGPU) ? 'true' : 'false',
    QVAC_WHISPER_BENCHMARK_LABEL: buildLabel(entry, index),
    QVAC_WHISPER_BENCHMARK_BACKEND: entry.backendHint ? String(entry.backendHint) : (process.env.QVAC_WHISPER_BENCHMARK_BACKEND || ''),
    QVAC_WHISPER_BENCHMARK_DEVICE: entry.deviceLabel ? String(entry.deviceLabel) : (process.env.QVAC_WHISPER_BENCHMARK_DEVICE || ''),
    QVAC_WHISPER_BENCHMARK_RUNNER: entry.runnerLabel ? String(entry.runnerLabel) : (process.env.QVAC_WHISPER_BENCHMARK_RUNNER || '')
  }

  if (entry.threads !== undefined) {
    env.QVAC_WHISPER_BENCHMARK_THREADS = String(entry.threads)
  }
  if (entry.numRuns !== undefined) {
    env.QVAC_WHISPER_BENCHMARK_RUNS = String(entry.numRuns)
  }
  if (entry.numWarmup !== undefined) {
    env.QVAC_WHISPER_BENCHMARK_WARMUP_RUNS = String(entry.numWarmup)
  }
  if (entry.gpuDevice !== undefined) {
    env.QVAC_WHISPER_BENCHMARK_GPU_DEVICE = String(entry.gpuDevice)
  }
  if (entry.rtfUpperBound !== undefined) {
    env.QVAC_WHISPER_BENCHMARK_RTF_UPPER_BOUND = String(entry.rtfUpperBound)
  }

  console.log('')
  console.log('='.repeat(70))
  console.log(`Running benchmark entry ${index + 1}`)
  console.log(`  modelFile: ${env.QVAC_WHISPER_BENCHMARK_MODEL_FILE}`)
  console.log(`  useGPU:    ${env.QVAC_WHISPER_BENCHMARK_USE_GPU}`)
  console.log(`  backend:   ${env.QVAC_WHISPER_BENCHMARK_BACKEND || 'default'}`)
  console.log(`  label:     ${env.QVAC_WHISPER_BENCHMARK_LABEL}`)
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
    throw new Error(`Benchmark entry failed for ${env.QVAC_WHISPER_BENCHMARK_LABEL} (exit ${result.status})`)
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
