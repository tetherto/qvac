#!/usr/bin/env node
'use strict'

// Engine-dispatching RTF benchmark matrix runner for @qvac/asr-ggml.
//
// Reads a JSON array of matrix entries from QVAC_ASR_GGML_BENCHMARK_MATRIX_JSON.
// Each entry carries an `engine` key ("whisper" | "parakeet") plus the
// engine-specific fields:
//   whisper:  { engine, modelFile, useGPU, backendHint?, threads?, numRuns?,
//               numWarmup?, gpuDevice?, rtfUpperBound?, label? }
//   parakeet: { engine, modelType, quant?, useGPU, backendHint?, maxThreads?,
//               numRuns?, numWarmup?, rtfUpperBound?, label?, coreml? }
//
// `coreml: true` (parakeet, darwin only) benchmarks the Apple Neural Engine
// encoder sidecar. The sidecar is presence-driven -- parakeet.cpp derives
// `<gguf-stem-without-quant>-encoder.mlmodelc` from the GGUF path and picks it
// up automatically -- so it cannot live in `models/` next to the GGUFs the
// cpu/metal lanes resolve, or those lanes would silently start measuring the
// ANE. Coreml entries instead run against an isolated `models/coreml/` copy
// (see prepareCoremlEntry) and pin resolution there via QVAC_TEST_GGUF_<TYPE>.
//
// Legacy single-engine invocations still work: when the unified env var is
// absent, QVAC_WHISPER_BENCHMARK_MATRIX_JSON / QVAC_PARAKEET_BENCHMARK_MATRIX_JSON
// are consumed with the engine implied.
//
// Per entry the runner spawns the engine's npm benchmark script
// (test:benchmark:rtf / test:benchmark:rtf:parakeet) and afterwards stamps a
// top-level "engine" field into every report JSON the entry produced under
// benchmarks/results/ so the aggregator (scripts/perf-report/
// aggregate-asr-ggml-rtf.js) never has to shape-sniff fresh artifacts.

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const { isDeepStrictEqual } = require('util')

const RESULTS_DIR = path.resolve(__dirname, '..', 'benchmarks', 'results')
const MODELS_DIR = path.resolve(__dirname, '..', 'models')

// Core ML sidecars are exported per encoder checkpoint, not per quantisation:
// parakeet.cpp strips a trailing quant tag when deriving the sidecar path, so
// one `<stem>-encoder.mlmodelc` serves the f16/q8_0/q4_0 GGUFs of that stem.
// Only model types listed here have a published, validated sidecar.
const COREML_GGUF_STEMS = { tdt: 'parakeet-tdt-0.6b-v3' }

const ENGINES = {
  whisper: {
    npmScript: 'test:benchmark:rtf',
    defaultEntry: { engine: 'whisper', modelFile: 'ggml-tiny.bin', useGPU: false }
  },
  parakeet: {
    npmScript: 'test:benchmark:rtf:parakeet',
    defaultEntries: [
      { engine: 'parakeet', modelType: 'tdt', useGPU: false },
      { engine: 'parakeet', modelType: 'unified', useGPU: false },
      { engine: 'parakeet', modelType: 'ctc', useGPU: false },
      { engine: 'parakeet', modelType: 'eou', useGPU: false },
      { engine: 'parakeet', modelType: 'sortformer', useGPU: false },
      { engine: 'parakeet', modelType: 'sortformer-streaming', useGPU: false }
    ]
  }
}

function getNpmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm'
}

function getSpawnOptions(pkgDir, env) {
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

function parseJsonArray(raw, envName) {
  const parsed = JSON.parse(raw)
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`${envName} must be a non-empty JSON array`)
  }
  return parsed
}

function buildUnifiedEntry(tdtEntry) {
  return { ...tdtEntry, modelType: 'unified' }
}

function hasMatchingUnifiedEntry(entries, tdtEntry) {
  const expected = buildUnifiedEntry(tdtEntry)
  return entries.some((entry) => isDeepStrictEqual(entry, expected))
}

function addUnifiedCoverage(entries) {
  const expanded = [...entries]
  for (const entry of entries) {
    // Never clone a coreml lane into a `unified` one: `unified` is a different
    // checkpoint family (parakeet-unified-en-0.6b) with no encoder sidecar, so
    // the clone would resolve no sidecar and hard-fail the entry.
    if (
      entry.engine === 'parakeet' &&
      entry.modelType === 'tdt' &&
      !normalizeBoolean(entry.coreml) &&
      !hasMatchingUnifiedEntry(expanded, entry)
    ) {
      expanded.push(buildUnifiedEntry(entry))
    }
  }
  return expanded
}

function extendConfiguredMatrix(entries) {
  return normalizeBoolean(process.env.QVAC_PARAKEET_ADD_UNIFIED_COVERAGE)
    ? addUnifiedCoverage(entries)
    : entries
}

function parseMatrixConfig() {
  const unified = process.env.QVAC_ASR_GGML_BENCHMARK_MATRIX_JSON
  if (unified) {
    return extendConfiguredMatrix(parseJsonArray(unified, 'QVAC_ASR_GGML_BENCHMARK_MATRIX_JSON'))
  }

  // Legacy per-engine env vars (engine implied).
  const whisperRaw = process.env.QVAC_WHISPER_BENCHMARK_MATRIX_JSON
  const parakeetRaw = process.env.QVAC_PARAKEET_BENCHMARK_MATRIX_JSON
  if (whisperRaw || parakeetRaw) {
    const entries = []
    if (whisperRaw) {
      for (const e of parseJsonArray(whisperRaw, 'QVAC_WHISPER_BENCHMARK_MATRIX_JSON')) {
        entries.push({ engine: 'whisper', ...e })
      }
    }
    if (parakeetRaw) {
      for (const e of parseJsonArray(parakeetRaw, 'QVAC_PARAKEET_BENCHMARK_MATRIX_JSON')) {
        entries.push({ engine: 'parakeet', ...e })
      }
    }
    return extendConfiguredMatrix(entries)
  }

  // No matrix requested: one CPU smoke entry per engine family.
  return [ENGINES.whisper.defaultEntry, ...ENGINES.parakeet.defaultEntries]
}

function normalizeBoolean(value) {
  return value === true || value === 'true' || value === '1'
}

function resolveEngine(entry, index) {
  const engine = entry.engine || (entry.modelType ? 'parakeet' : 'whisper')
  if (!ENGINES[engine]) {
    throw new Error(
      `Matrix entry ${index + 1} has unknown engine "${engine}" (expected whisper|parakeet)`
    )
  }
  return engine
}

function buildLabel(engine, entry, index) {
  if (entry.label) return String(entry.label)
  const gpuTag = normalizeBoolean(entry.useGPU) ? 'gpu' : 'cpu'
  if (engine === 'parakeet') {
    const quantPart = entry.quant ? `-${entry.quant}` : ''
    // The label lands in the artifact filename, so a coreml lane must not
    // collide with the metal lane of the same model/quant on the same runner.
    const coremlPart = normalizeBoolean(entry.coreml) ? '-coreml' : ''
    return `${index + 1}-${entry.modelType || 'tdt'}${quantPart}-${gpuTag}${coremlPart}`
  }
  const model = String(entry.modelFile || 'ggml-tiny.bin').replace(/\.bin$/, '')
  return `${index + 1}-${model}-${gpuTag}`
}

function setIfDefined(env, key, value) {
  if (value !== undefined) env[key] = String(value)
}

function buildWhisperEnv(entry, label) {
  const env = {
    ...process.env,
    QVAC_WHISPER_BENCHMARK_MODEL_FILE: String(entry.modelFile || 'ggml-tiny.bin'),
    QVAC_WHISPER_BENCHMARK_USE_GPU: normalizeBoolean(entry.useGPU) ? 'true' : 'false',
    QVAC_WHISPER_BENCHMARK_LABEL: label,
    QVAC_WHISPER_BENCHMARK_BACKEND: entry.backendHint
      ? String(entry.backendHint)
      : process.env.QVAC_WHISPER_BENCHMARK_BACKEND || '',
    QVAC_WHISPER_BENCHMARK_DEVICE: entry.deviceLabel
      ? String(entry.deviceLabel)
      : process.env.QVAC_ASR_GGML_BENCHMARK_DEVICE ||
        process.env.QVAC_WHISPER_BENCHMARK_DEVICE ||
        '',
    QVAC_WHISPER_BENCHMARK_RUNNER: entry.runnerLabel
      ? String(entry.runnerLabel)
      : process.env.QVAC_ASR_GGML_BENCHMARK_RUNNER ||
        process.env.QVAC_WHISPER_BENCHMARK_RUNNER ||
        ''
  }

  setIfDefined(env, 'QVAC_WHISPER_BENCHMARK_THREADS', entry.threads)
  setIfDefined(env, 'QVAC_WHISPER_BENCHMARK_RUNS', entry.numRuns)
  setIfDefined(env, 'QVAC_WHISPER_BENCHMARK_WARMUP_RUNS', entry.numWarmup)
  setIfDefined(env, 'QVAC_WHISPER_BENCHMARK_GPU_DEVICE', entry.gpuDevice)
  setIfDefined(env, 'QVAC_WHISPER_BENCHMARK_RTF_UPPER_BOUND', entry.rtfUpperBound)

  return env
}

// A matrix entry that cannot run here but must not redden the lane (no Core ML
// on this platform, or the sidecar was never staged). Distinct from a plain
// Error, which still fails the entry.
class SkipEntryError extends Error {}

// Link the staged GGUF next to its Core ML sidecar under `models/coreml/` and
// return the env that pins model resolution there.
//
// The isolation is the point: the sidecar is picked up by presence alone, so
// keeping it out of `models/` is what stops the cpu/metal lanes from silently
// measuring the ANE. Symlink first (cheap, and the GGUFs are ~0.4-1.4 GB),
// falling back to a hardlink and then a copy for filesystems that refuse.
function prepareCoremlEntry(entry, modelsDir = MODELS_DIR) {
  // Validate the entry before the platform gate: an unsupported model type is
  // a mistake in the matrix JSON, not a property of the runner, so every
  // platform should reject it rather than only the one that can run the lane.
  const modelType = String(entry.modelType || 'tdt')
  const stem = COREML_GGUF_STEMS[modelType]
  if (!stem) {
    throw new Error(
      `Core ML is not supported for parakeet model type "${modelType}" ` +
        `(supported: ${Object.keys(COREML_GGUF_STEMS).join(', ')})`
    )
  }

  if (process.platform !== 'darwin') {
    throw new SkipEntryError('Core ML lanes run on darwin only')
  }

  const coremlDir = path.join(modelsDir, 'coreml')
  const sidecar = path.join(coremlDir, `${stem}-encoder.mlmodelc`)
  if (!fs.existsSync(sidecar)) {
    throw new SkipEntryError(`no Core ML encoder sidecar staged at ${sidecar}`)
  }

  const quant = entry.quant ? String(entry.quant) : 'f16'
  const ggufName = `${stem}.${quant}.gguf`
  const source = path.join(modelsDir, ggufName)
  if (!fs.existsSync(source)) {
    throw new Error(`Core ML lane needs ${ggufName}, which is not staged under models/`)
  }

  const linked = path.join(coremlDir, ggufName)
  // existsSync follows symlinks, so a link left dangling by an earlier run (or
  // by a cache restored without its target) reads as absent while still
  // occupying the path. Clear whatever is there before relinking; otherwise
  // symlink/link would throw EEXIST and the copy fallback would write THROUGH
  // the dangling link into the source GGUF.
  if (!fs.existsSync(linked)) {
    try {
      fs.unlinkSync(linked)
    } catch (_) {
      /* nothing to clear */
    }
    try {
      // Relative target: models/ is a restored CI cache, so an absolute path
      // would dangle if the workspace is restored under a different root.
      fs.symlinkSync(path.join('..', ggufName), linked)
    } catch (_) {
      try {
        fs.linkSync(source, linked)
      } catch (__) {
        fs.copyFileSync(source, linked)
      }
    }
  }

  return {
    [`QVAC_TEST_GGUF_${modelType.toUpperCase()}`]: linked,
    QVAC_PARAKEET_BENCHMARK_COREML: 'true'
  }
}

function buildParakeetEnv(entry, label) {
  const env = {
    ...process.env,
    QVAC_PARAKEET_BENCHMARK_MODEL_TYPE: String(entry.modelType || 'tdt'),
    QVAC_PARAKEET_BENCHMARK_QUANT: entry.quant
      ? String(entry.quant)
      : process.env.QVAC_PARAKEET_BENCHMARK_QUANT || '',
    QVAC_PARAKEET_BENCHMARK_USE_GPU: normalizeBoolean(entry.useGPU) ? 'true' : 'false',
    QVAC_PARAKEET_BENCHMARK_LABEL: label,
    QVAC_PARAKEET_BENCHMARK_BACKEND: entry.backendHint
      ? String(entry.backendHint)
      : normalizeBoolean(entry.coreml)
        ? 'coreml'
        : process.env.QVAC_PARAKEET_BENCHMARK_BACKEND || '',
    QVAC_PARAKEET_BENCHMARK_DEVICE: entry.deviceLabel
      ? String(entry.deviceLabel)
      : process.env.QVAC_ASR_GGML_BENCHMARK_DEVICE ||
        process.env.QVAC_PARAKEET_BENCHMARK_DEVICE ||
        '',
    QVAC_PARAKEET_BENCHMARK_RUNNER: entry.runnerLabel
      ? String(entry.runnerLabel)
      : process.env.QVAC_ASR_GGML_BENCHMARK_RUNNER ||
        process.env.QVAC_PARAKEET_BENCHMARK_RUNNER ||
        ''
  }

  setIfDefined(env, 'QVAC_PARAKEET_BENCHMARK_THREADS', entry.maxThreads)
  setIfDefined(env, 'QVAC_PARAKEET_BENCHMARK_RUNS', entry.numRuns)
  setIfDefined(env, 'QVAC_PARAKEET_BENCHMARK_WARMUP_RUNS', entry.numWarmup)
  setIfDefined(env, 'QVAC_PARAKEET_BENCHMARK_RTF_UPPER_BOUND', entry.rtfUpperBound)

  return env
}

function listReportFiles() {
  try {
    return new Set(
      fs.readdirSync(RESULTS_DIR).filter((name) => /^rtf-benchmark-.*\.json$/.test(name))
    )
  } catch {
    return new Set()
  }
}

// Stamp `engine` into every report file the entry just produced (unless the
// benchmark already wrote one). Best-effort: a malformed report is left alone
// for the aggregator's shape-based fallback.
function stampEngine(engine, before) {
  for (const name of listReportFiles()) {
    if (before.has(name)) continue
    const filePath = path.join(RESULTS_DIR, name)
    try {
      const report = JSON.parse(fs.readFileSync(filePath, 'utf8'))
      if (report && typeof report === 'object' && !Array.isArray(report) && !report.engine) {
        report.engine = engine
        fs.writeFileSync(filePath, JSON.stringify(report, null, 2))
      }
    } catch (err) {
      console.error(`[matrix-runner] could not stamp engine into ${name}: ${err.message}`)
    }
  }
}

function runBenchmarkEntry(pkgDir, entry, index) {
  const engine = resolveEngine(entry, index)
  const label = buildLabel(engine, entry, index)
  const env = engine === 'parakeet' ? buildParakeetEnv(entry, label) : buildWhisperEnv(entry, label)
  const { npmScript } = ENGINES[engine]

  // May throw SkipEntryError (no sidecar / not darwin), which main() reports as
  // a skip rather than a failure.
  const coreml = engine === 'parakeet' && normalizeBoolean(entry.coreml)
  if (coreml) Object.assign(env, prepareCoremlEntry(entry))

  console.log('')
  console.log('='.repeat(70))
  console.log(`Running benchmark entry ${index + 1}`)
  console.log(`  engine:    ${engine}`)
  if (engine === 'parakeet') {
    console.log(`  modelType: ${env.QVAC_PARAKEET_BENCHMARK_MODEL_TYPE}`)
    console.log(`  quant:     ${env.QVAC_PARAKEET_BENCHMARK_QUANT || 'default'}`)
    console.log(`  useGPU:    ${env.QVAC_PARAKEET_BENCHMARK_USE_GPU}`)
    console.log(`  backend:   ${env.QVAC_PARAKEET_BENCHMARK_BACKEND || 'default'}`)
    if (coreml) {
      // modelType is optional on an entry (prepareCoremlEntry defaults it), so
      // read the pinned path back off the env rather than re-deriving the key.
      const pinned = Object.keys(env).find((key) => key.startsWith('QVAC_TEST_GGUF_'))
      console.log(`  coreml:    ${pinned ? env[pinned] : 'staged'}`)
    }
  } else {
    console.log(`  modelFile: ${env.QVAC_WHISPER_BENCHMARK_MODEL_FILE}`)
    console.log(`  useGPU:    ${env.QVAC_WHISPER_BENCHMARK_USE_GPU}`)
    console.log(`  backend:   ${env.QVAC_WHISPER_BENCHMARK_BACKEND || 'default'}`)
  }
  console.log(`  label:     ${label}`)
  console.log('='.repeat(70))

  const before = listReportFiles()

  const result = spawnSync(getNpmCommand(), ['run', npmScript], getSpawnOptions(pkgDir, env))

  stampEngine(engine, before)

  if (result.error) {
    throw result.error
  }

  if (result.status !== 0) {
    throw new Error(`Benchmark entry failed for ${label} (exit ${result.status})`)
  }
}

function main() {
  const pkgDir = path.resolve(__dirname, '..')
  const matrix = parseMatrixConfig()
  const failures = []
  const skips = []

  for (let i = 0; i < matrix.length; i++) {
    try {
      runBenchmarkEntry(pkgDir, matrix[i], i)
    } catch (err) {
      if (err instanceof SkipEntryError) {
        console.log(`\n[matrix-runner] entry ${i + 1} SKIPPED: ${err.message}\n`)
        skips.push({ index: i + 1, message: err.message })
        continue
      }
      console.error(`\n[matrix-runner] entry ${i + 1} failed: ${err.message}\n`)
      failures.push({ index: i + 1, message: err.message })
    }
  }

  const attempted = matrix.length - skips.length
  console.log('')
  console.log(`Completed ${attempted - failures.length}/${attempted} benchmark configuration(s).`)

  if (skips.length > 0) {
    console.log(`${skips.length} skipped:`)
    for (const s of skips) console.log(`  - entry ${s.index}: ${s.message}`)
  }

  if (failures.length > 0) {
    console.log(`${failures.length} failure(s):`)
    for (const f of failures) console.log(`  - entry ${f.index}: ${f.message}`)
    // Don't fail the whole matrix: a single model/backend failure on a
    // platform should still let the remaining configs' artifacts upload and be
    // aggregated. The CI "Verify RTF benchmark output exists" step hard-fails
    // only when NO artifacts landed; summarize renders whatever did.
    process.exit(0)
  }
}

if (require.main === module) main()

module.exports = {
  addUnifiedCoverage,
  parseMatrixConfig,
  buildLabel,
  buildParakeetEnv,
  prepareCoremlEntry,
  SkipEntryError
}
