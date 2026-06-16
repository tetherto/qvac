'use strict'

/**
 * Real-Time Factor (RTF) Benchmark
 *
 * Captures RTF and related inference performance metrics directly from
 * the C++ addon's runtimeStats (emitted on the JobEnded event).
 *
 * RTF = processing_time / audio_duration
 *   < 1.0  → faster than real-time
 *   = 1.0  → exactly real-time
 *   > 1.0  → slower than real-time
 *
 * The test runs multiple transcriptions after a warmup pass and
 * reports per-run and aggregate statistics (mean, min, max, stddev,
 * p50, p95).  Results are also written to a JSON file so CI can
 * upload them as artifacts for cross-device comparison.
 */

const test = require('brittle')
const fs = require('bare-fs')
const path = require('bare-path')
const process = require('bare-process')
const binding = require('../../binding')
const TranscriptionParakeet = require('../../index.js')
const {
  detectPlatform,
  setupJsLogger,
  getTestPaths,
  ensureGgufForType,
  quantFromGgufName,
  isMobile
} = require('../integration/helpers.js')

const platform = detectPlatform()
const { samplesDir } = getTestPaths()

const SAMPLE_RATE = 16000
const VALID_MODEL_TYPES = ['tdt', 'ctc', 'eou', 'sortformer']
const VALID_QUANTS = ['q8_0', 'q4_0', 'f16']
const RTF_RESULTS_DIR = path.resolve(__dirname, '../../benchmarks/results')
const RESULT_MARKER = 'QVAC_RTF_REPORT::'

function getEnvBoolean (name, fallback) {
  const value = process.env[name]
  if (value === undefined) return fallback
  return value === '1' || value === 'true' || value === 'TRUE' || value === 'yes'
}

function getEnvInteger (name, fallback) {
  const value = process.env[name]
  if (value === undefined) return fallback
  const parsed = Number.parseInt(value, 10)
  return Number.isNaN(parsed) ? fallback : parsed
}

function sanitizeTag (value) {
  if (!value) return ''
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
}

function getBenchmarkSettings () {
  const requestedModelType = (process.env.QVAC_PARAKEET_BENCHMARK_MODEL_TYPE || 'tdt').toLowerCase()
  if (!VALID_MODEL_TYPES.includes(requestedModelType)) {
    throw new Error(`Invalid benchmark model type: ${requestedModelType}`)
  }

  const label = sanitizeTag(process.env.QVAC_PARAKEET_BENCHMARK_LABEL || '')
  const backendHint = process.env.QVAC_PARAKEET_BENCHMARK_BACKEND || ''
  const deviceLabel = process.env.QVAC_PARAKEET_BENCHMARK_DEVICE || ''
  const runnerLabel = process.env.QVAC_PARAKEET_BENCHMARK_RUNNER || ''

  // Quantisation to benchmark. Empty => platform default (q8_0 desktop,
  // q4_0 mobile). The matrix runner sets this per entry so a single device
  // can sweep q8_0 vs q4_0.
  const requestedQuant = (process.env.QVAC_PARAKEET_BENCHMARK_QUANT || '').toLowerCase()
  if (requestedQuant && !VALID_QUANTS.includes(requestedQuant)) {
    throw new Error(`Invalid benchmark quant: ${requestedQuant} (expected one of ${VALID_QUANTS.join(', ')})`)
  }

  return {
    modelType: requestedModelType,
    quant: requestedQuant,
    maxThreads: getEnvInteger('QVAC_PARAKEET_BENCHMARK_THREADS', 4),
    numWarmup: getEnvInteger('QVAC_PARAKEET_BENCHMARK_WARMUP_RUNS', 1),
    numRuns: getEnvInteger('QVAC_PARAKEET_BENCHMARK_RUNS', isMobile ? 3 : 5),
    useGPU: getEnvBoolean('QVAC_PARAKEET_BENCHMARK_USE_GPU', false),
    backendHint,
    deviceLabel,
    runnerLabel,
    label,
    requestedUpperBound: process.env.QVAC_PARAKEET_BENCHMARK_RTF_UPPER_BOUND
  }
}

async function resolveModelPath (benchmarkSettings) {
  const modelPath = await ensureGgufForType(
    benchmarkSettings.modelType,
    null,
    benchmarkSettings.quant ? { quant: benchmarkSettings.quant } : {}
  )
  if (!modelPath) {
    const quantHint = benchmarkSettings.quant ? ` (quant: ${benchmarkSettings.quant})` : ''
    throw new Error(`Unable to resolve model for type: ${benchmarkSettings.modelType}${quantHint}`)
  }

  return modelPath
}

function getUpperBound (benchmarkSettings) {
  if (benchmarkSettings.requestedUpperBound !== undefined) {
    const parsed = Number.parseFloat(benchmarkSettings.requestedUpperBound)
    if (!Number.isNaN(parsed)) return parsed
  }

  return null
}

// parakeet.cpp (ggml) GPU backend cascade, per test/integration/gpu-smoke.test.js:
//   - darwin / ios:   Metal
//   - linux / win32:  Vulkan
//   - android:        Vulkan (Adreno: OpenCL fallback)
// (The previous coreml/nnapi/auto-gpu names were ONNX-era and never matched
// the GGML runtime, which reports the real backend via stats.backendId.)
function getRequestedBackendFamily (platformName, useGPU, backendHint) {
  if (backendHint) return backendHint
  if (!useGPU) return 'cpu'
  if (platformName === 'darwin' || platformName === 'ios') return 'metal'
  if (platformName === 'android') return 'vulkan'
  if (platformName === 'win32' || platformName === 'linux') return 'vulkan'
  return 'gpu'
}

// Maps stats.backendId (surfaced by ParakeetModel::runtimeStats() after
// Engine::backend_name()) to the GGML backend family that actually ran.
function backendIdToName (id) {
  switch (id) {
    case 0: return 'cpu'
    case 1: return 'metal'
    case 2: return 'cuda'
    case 3: return 'vulkan'
    case 4: return 'opencl'
    case 99: return 'other-gpu'
    default: return ''
  }
}

function getArtifactFileName (benchmarkSettings) {
  const parts = [
    'rtf-benchmark',
    platform,
    benchmarkSettings.modelType
  ]

  // Quant goes between model type and device so multi-quant sweeps on the
  // same runner don't clobber each other's artifacts.
  if (benchmarkSettings.resolvedQuant) {
    parts.push(benchmarkSettings.resolvedQuant)
  }

  parts.push(benchmarkSettings.useGPU ? 'gpu' : 'cpu')

  if (benchmarkSettings.label) {
    parts.push(benchmarkSettings.label)
  }

  return `${parts.join('-')}.json`
}

function getTimeMs () {
  const [sec, nsec] = process.hrtime()
  return sec * 1000 + nsec / 1e6
}

// Addon version stamped into every artifact so the consolidated report can
// label which build produced the numbers (matches the version-stamping the
// LLM benchmark suite does). Read from package.json via bare-fs because bare
// does not support require()-ing JSON.
function getAddonVersion () {
  try {
    const pkgPath = path.resolve(__dirname, '../../package.json')
    return JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version || ''
  } catch (_) {
    return ''
  }
}

function percentile (sorted, p) {
  const idx = (p / 100) * (sorted.length - 1)
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return sorted[lo]
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo)
}

function stats (values) {
  const sorted = [...values].sort((a, b) => a - b)
  const sum = sorted.reduce((a, b) => a + b, 0)
  const mean = sum / sorted.length
  const variance = sorted.reduce((s, v) => s + (v - mean) ** 2, 0) / sorted.length
  return {
    mean,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    stddev: Math.sqrt(variance),
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    count: sorted.length
  }
}

test('RTF benchmark: collect real-time factor on CI device', { timeout: 600000 }, async (t) => {
  const loggerBinding = setupJsLogger(binding)
  const benchmarkSettings = getBenchmarkSettings()
  const modelPath = await resolveModelPath(benchmarkSettings)
  // Resolve the actual quant from the staged file name; this is the source of
  // truth (the requested quant may have been empty => platform default).
  benchmarkSettings.resolvedQuant = quantFromGgufName(modelPath) || benchmarkSettings.quant || ''
  const upperBound = getUpperBound(benchmarkSettings)
  const [platformName, archName] = platform.split('-')

  console.log('\n' + '='.repeat(70))
  console.log('RTF BENCHMARK')
  console.log('='.repeat(70))
  console.log(`  Platform:       ${platform}`)
  console.log(`  Model path:     ${modelPath}`)
  console.log(`  Model type:     ${benchmarkSettings.modelType}`)
  console.log(`  Quant:          ${benchmarkSettings.resolvedQuant || 'default'}`)
  console.log(`  GPU requested:  ${benchmarkSettings.useGPU}`)
  if (benchmarkSettings.backendHint) console.log(`  Backend hint:   ${benchmarkSettings.backendHint}`)
  if (benchmarkSettings.deviceLabel) console.log(`  Device label:   ${benchmarkSettings.deviceLabel}`)
  if (benchmarkSettings.runnerLabel) console.log(`  Runner label:   ${benchmarkSettings.runnerLabel}`)
  console.log(`  Mobile:         ${isMobile}`)
  console.log(`  Warmup runs:    ${benchmarkSettings.numWarmup}`)
  console.log(`  Benchmark runs: ${benchmarkSettings.numRuns}`)
  console.log('='.repeat(70) + '\n')

  const samplePath = path.join(samplesDir, 'sample.raw')
  if (!fs.existsSync(samplePath)) {
    loggerBinding.releaseLogger()
    t.pass('Test skipped - sample audio not found')
    return
  }

  const rawBuffer = fs.readFileSync(samplePath)
  const pcmData = new Int16Array(rawBuffer.buffer, rawBuffer.byteOffset, rawBuffer.length / 2)
  const audioData = new Float32Array(pcmData.length)
  for (let i = 0; i < pcmData.length; i++) {
    audioData[i] = pcmData[i] / 32768.0
  }

  const audioDurationSec = audioData.length / SAMPLE_RATE
  console.log(`  Audio samples:  ${audioData.length}`)
  console.log(`  Audio duration: ${audioDurationSec.toFixed(2)}s\n`)

  const allResults = []
  let observedBackendId = null
  const model = new TranscriptionParakeet({
    files: { model: modelPath },
    config: {
      parakeetConfig: {
        maxThreads: benchmarkSettings.maxThreads,
        useGPU: benchmarkSettings.useGPU,
        sampleRate: SAMPLE_RATE,
        channels: 1
      }
    }
  })

  async function runOnce (audio) {
    const response = await model.run(audio)
    await response.onUpdate(() => { /* discard segments here -- we only need stats */ }).await()
    return response.stats || null
  }

  try {
    console.log('Loading model...')
    const loadStart = getTimeMs()
    await model.load()

    // Warmup with silent audio to trigger full model initialisation.
    const silentAudio = new Float32Array(SAMPLE_RATE).fill(0)
    await runOnce(silentAudio).catch(() => null)

    const loadMs = getTimeMs() - loadStart
    console.log(`Model loaded and initialised in ${loadMs.toFixed(0)}ms\n`)

    // --- Warmup runs (discard) ---
    for (let w = 0; w < benchmarkSettings.numWarmup; w++) {
      console.log(`[warmup ${w + 1}/${benchmarkSettings.numWarmup}]`)
      const stats = await runOnce(audioData)
      if (stats) {
        console.log(`  RTF (warmup): ${(stats.realTimeFactor || 0).toFixed(4)}`)
      }
    }

    console.log(`\nRunning ${benchmarkSettings.numRuns} benchmark iterations...\n`)

    // --- Benchmark runs ---
    for (let i = 0; i < benchmarkSettings.numRuns; i++) {
      const runStart = getTimeMs()
      const jobStats = await runOnce(audioData)
      const wallMs = getTimeMs() - runStart

      if (!jobStats) {
        console.log(`  Run ${i + 1}: no stats reported`)
        continue
      }

      // The GGML addon (parakeet.cpp) does not populate realTimeFactor in its
      // runtimeStats — it reports `0` (and only raw, cumulative counters for
      // audioDurationMs / totalTokens / totalTimeSec). So derive RTF from the
      // measured per-call wall time and the known audio duration instead, and
      // only prefer the addon value when a future build reports a positive one.
      const statsRtf = jobStats.realTimeFactor || 0
      const derivedRtf = audioDurationSec > 0 ? (wallMs / 1000) / audioDurationSec : 0
      const run = {
        iteration: i + 1,
        wallMs,
        rtf: statsRtf > 0 ? statsRtf : derivedRtf,
        rtfSource: statsRtf > 0 ? 'addon' : 'wall',
        requestedModelType: benchmarkSettings.modelType,
        requestedUseGPU: benchmarkSettings.useGPU,
        totalTimeSec: jobStats.totalTime || 0,
        audioDurationMs: jobStats.audioDurationMs || 0,
        tokensPerSecond: jobStats.tokensPerSecond || 0,
        msPerToken: jobStats.msPerToken || 0,
        totalTokens: jobStats.totalTokens || 0,
        totalSamples: jobStats.totalSamples || 0,
        modelLoadMs: jobStats.modelLoadMs || 0,
        melSpecMs: jobStats.melSpecMs || 0,
        encoderMs: jobStats.encoderMs || 0,
        decoderMs: jobStats.decoderMs || 0,
        totalWallMs: jobStats.totalWallMs || 0,
        backendDevice: typeof jobStats.backendDevice === 'number' ? jobStats.backendDevice : null,
        backendId: typeof jobStats.backendId === 'number' ? jobStats.backendId : null
      }

      if (run.backendId !== null) observedBackendId = run.backendId

      allResults.push(run)

      console.log(`  Run ${i + 1}/${benchmarkSettings.numRuns}: ` +
        `RTF=${run.rtf.toFixed(4)}  ` +
        `wall=${wallMs.toFixed(0)}ms  ` +
        `tokens/s=${run.tokensPerSecond.toFixed(1)}  ` +
        `encoder=${run.encoderMs.toFixed(0)}ms  ` +
        `decoder=${run.decoderMs.toFixed(0)}ms`)

      if (isMobile) {
        await new Promise(resolve => setTimeout(resolve, 200))
      }
    }

    // --- Aggregate statistics ---
    if (allResults.length === 0) {
      t.fail('No benchmark results collected')
      return
    }

    const rtfValues = allResults.map(r => r.rtf)
    const wallValues = allResults.map(r => r.wallMs)
    const tpsValues = allResults.map(r => r.tokensPerSecond)
    const encoderValues = allResults.map(r => r.encoderMs)
    const decoderValues = allResults.map(r => r.decoderMs)

    const rtfStats = stats(rtfValues)
    const wallStats = stats(wallValues)
    const tpsStats = stats(tpsValues)
    const encoderStats = stats(encoderValues)
    const decoderStats = stats(decoderValues)

    console.log('\n' + '='.repeat(70))
    console.log('RTF BENCHMARK RESULTS')
    console.log('='.repeat(70))
    console.log(`\n  Platform:        ${platform}`)
    console.log(`  Audio duration:  ${audioDurationSec.toFixed(2)}s`)
    console.log(`  Iterations:      ${allResults.length}`)
    console.log('')
    console.log('  Real-Time Factor (RTF):')
    console.log(`    Mean:   ${rtfStats.mean.toFixed(4)}`)
    console.log(`    Min:    ${rtfStats.min.toFixed(4)}`)
    console.log(`    Max:    ${rtfStats.max.toFixed(4)}`)
    console.log(`    Stddev: ${rtfStats.stddev.toFixed(4)}`)
    console.log(`    P50:    ${rtfStats.p50.toFixed(4)}`)
    console.log(`    P95:    ${rtfStats.p95.toFixed(4)}`)
    console.log('')
    console.log('  Wall Time (ms):')
    console.log(`    Mean:   ${wallStats.mean.toFixed(0)}`)
    console.log(`    P50:    ${wallStats.p50.toFixed(0)}`)
    console.log(`    P95:    ${wallStats.p95.toFixed(0)}`)
    console.log('')
    console.log('  Tokens/Second:')
    console.log(`    Mean:   ${tpsStats.mean.toFixed(1)}`)
    console.log(`    P50:    ${tpsStats.p50.toFixed(1)}`)
    console.log('')
    console.log('  Encoder (ms):')
    console.log(`    Mean:   ${encoderStats.mean.toFixed(0)}`)
    console.log(`    P50:    ${encoderStats.p50.toFixed(0)}`)
    console.log('')
    console.log('  Decoder (ms):')
    console.log(`    Mean:   ${decoderStats.mean.toFixed(0)}`)
    console.log(`    P50:    ${decoderStats.p50.toFixed(0)}`)
    console.log('')
    console.log('='.repeat(70) + '\n')

    // --- Write JSON artifact ---
    const report = {
      timestamp: new Date().toISOString(),
      platform,
      platformName,
      arch: archName || '',
      isMobile,
      addonVersion: getAddonVersion(),
      model: {
        type: benchmarkSettings.modelType,
        quant: benchmarkSettings.resolvedQuant,
        path: modelPath,
        dirName: path.basename(modelPath)
      },
      labels: {
        runner: benchmarkSettings.runnerLabel,
        device: benchmarkSettings.deviceLabel,
        backend: getRequestedBackendFamily(platformName, benchmarkSettings.useGPU, benchmarkSettings.backendHint),
        activeBackend: observedBackendId !== null ? backendIdToName(observedBackendId) : '',
        requestedBackend: benchmarkSettings.useGPU ? 'gpu' : 'cpu',
        label: benchmarkSettings.label
      },
      audio: {
        durationSec: audioDurationSec,
        samples: audioData.length,
        sampleRate: SAMPLE_RATE
      },
      config: {
        warmupRuns: benchmarkSettings.numWarmup,
        benchmarkRuns: benchmarkSettings.numRuns,
        maxThreads: benchmarkSettings.maxThreads,
        useGPU: benchmarkSettings.useGPU,
        sampleRate: SAMPLE_RATE
      },
      requested: {
        modelType: benchmarkSettings.modelType,
        quant: benchmarkSettings.quant,
        useGPU: benchmarkSettings.useGPU,
        backendHint: benchmarkSettings.backendHint,
        deviceLabel: benchmarkSettings.deviceLabel,
        runnerLabel: benchmarkSettings.runnerLabel
      },
      observed: {
        runtimeStatsKeys: allResults.length > 0 ? Object.keys(allResults[0]).sort() : []
      },
      summary: {
        rtf: rtfStats,
        wallMs: wallStats,
        tokensPerSecond: tpsStats,
        encoderMs: encoderStats,
        decoderMs: decoderStats,
        backendId: observedBackendId,
        activeBackend: observedBackendId !== null ? backendIdToName(observedBackendId) : ''
      },
      runs: allResults
    }

    const emittedSummary = {
      schemaVersion: 1,
      platform,
      platformName,
      arch: archName || '',
      addonVersion: getAddonVersion(),
      modelType: benchmarkSettings.modelType,
      quant: benchmarkSettings.resolvedQuant,
      useGPU: benchmarkSettings.useGPU,
      backendHint: getRequestedBackendFamily(platformName, benchmarkSettings.useGPU, benchmarkSettings.backendHint),
      activeBackend: observedBackendId !== null ? backendIdToName(observedBackendId) : '',
      deviceLabel: benchmarkSettings.deviceLabel,
      runnerLabel: benchmarkSettings.runnerLabel,
      summary: report.summary
    }

    try {
      if (!fs.existsSync(RTF_RESULTS_DIR)) {
        fs.mkdirSync(RTF_RESULTS_DIR, { recursive: true })
      }
      const outPath = path.join(RTF_RESULTS_DIR, getArtifactFileName(benchmarkSettings))
      fs.writeFileSync(outPath, JSON.stringify(report, null, 2))
      console.log(`Results written to ${outPath}\n`)
      console.log(`${RESULT_MARKER}${JSON.stringify(emittedSummary)}`)
    } catch (writeErr) {
      console.log(`Warning: could not write results file: ${writeErr.message}`)
      console.log(`${RESULT_MARKER}${JSON.stringify(emittedSummary)}`)
    }

    // --- Assertions ---
    t.ok(allResults.length === benchmarkSettings.numRuns,
      `Completed ${benchmarkSettings.numRuns} benchmark runs`)

    t.ok(rtfStats.mean > 0, 'Mean RTF should be positive')

    if (upperBound !== null) {
      t.ok(rtfStats.mean <= upperBound,
        `Mean RTF ${rtfStats.mean.toFixed(4)} should be <= ${upperBound}`)
    }

    console.log('RTF benchmark completed successfully!\n')
  } finally {
    try { await model.unload() } catch (_) { /* ignore */ }
    try { loggerBinding.releaseLogger() } catch (_) { /* ignore */ }
  }
})
