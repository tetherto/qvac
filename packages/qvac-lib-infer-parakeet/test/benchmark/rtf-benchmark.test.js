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
const { ParakeetInterface } = require('../../parakeet')
const {
  detectPlatform,
  setupJsLogger,
  getTestPaths,
  ensureModel,
  ensureModelForType,
  getNamedPathsConfig,
  isMobile
} = require('../integration/helpers.js')

const platform = detectPlatform()
const { modelPath: defaultModelPath, samplesDir } = getTestPaths()

const SAMPLE_RATE = 16000
const VALID_MODEL_TYPES = ['tdt', 'ctc', 'eou', 'sortformer']
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

  return {
    modelType: requestedModelType,
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
  if (benchmarkSettings.modelType === 'tdt') {
    await ensureModel(defaultModelPath)
    return defaultModelPath
  }

  const modelPath = await ensureModelForType(benchmarkSettings.modelType)
  if (!modelPath) {
    throw new Error(`Unable to resolve model for type: ${benchmarkSettings.modelType}`)
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

function getRequestedBackendFamily (platformName, useGPU, backendHint) {
  if (backendHint) return backendHint
  if (!useGPU) return 'cpu'
  if (platformName === 'darwin' || platformName === 'ios') return 'coreml-requested'
  if (platformName === 'android') return 'nnapi-requested'
  if (platformName === 'win32') return 'auto-gpu-requested'
  if (platformName === 'linux') return 'auto-gpu-requested'
  return 'gpu-requested'
}

function getArtifactFileName (benchmarkSettings) {
  const parts = [
    'rtf-benchmark',
    platform,
    benchmarkSettings.modelType,
    benchmarkSettings.useGPU ? 'gpu' : 'cpu'
  ]

  if (benchmarkSettings.label) {
    parts.push(benchmarkSettings.label)
  }

  return `${parts.join('-')}.json`
}

function getTimeMs () {
  const [sec, nsec] = process.hrtime()
  return sec * 1000 + nsec / 1e6
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
  const upperBound = getUpperBound(benchmarkSettings)
  const [platformName, archName] = platform.split('-')

  console.log('\n' + '='.repeat(70))
  console.log('RTF BENCHMARK')
  console.log('='.repeat(70))
  console.log(`  Platform:       ${platform}`)
  console.log(`  Model path:     ${modelPath}`)
  console.log(`  Model type:     ${benchmarkSettings.modelType}`)
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

  const config = {
    modelPath,
    modelType: benchmarkSettings.modelType,
    maxThreads: benchmarkSettings.maxThreads,
    useGPU: benchmarkSettings.useGPU,
    sampleRate: SAMPLE_RATE,
    channels: 1,
    ...getNamedPathsConfig(benchmarkSettings.modelType, modelPath)
  }

  const allResults = []
  const receivedStats = []
  let parakeet = null

  try {
    function outputCallback (handle, event, id, output, error) {
      if (event === 'JobEnded' && output) {
        receivedStats.push(output)
      }
    }

    console.log('Loading model...')
    const loadStart = getTimeMs()
    parakeet = new ParakeetInterface(binding, config, outputCallback)
    await parakeet.activate()

    // Warmup with silent audio to trigger full model initialisation
    const silentAudio = new Float32Array(SAMPLE_RATE).fill(0)
    receivedStats.length = 0
    await parakeet.append({ type: 'audio', data: silentAudio.buffer })
    await parakeet.append({ type: 'end of job' })

    const warmupDeadline = getTimeMs() + 30000
    while (receivedStats.length === 0 && getTimeMs() < warmupDeadline) {
      await new Promise(resolve => setTimeout(resolve, 100))
    }

    const loadMs = getTimeMs() - loadStart
    console.log(`Model loaded and initialised in ${loadMs.toFixed(0)}ms\n`)

    // --- Warmup runs (discard) ---
    for (let w = 0; w < benchmarkSettings.numWarmup; w++) {
      console.log(`[warmup ${w + 1}/${benchmarkSettings.numWarmup}]`)
      receivedStats.length = 0
      await parakeet.append({ type: 'audio', data: audioData.buffer })
      await parakeet.append({ type: 'end of job' })

      const deadline = getTimeMs() + 600000
      while (receivedStats.length === 0 && getTimeMs() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 50))
      }

      if (receivedStats.length > 0) {
        const s = receivedStats[receivedStats.length - 1]
        console.log(`  RTF (warmup): ${(s.realTimeFactor || 0).toFixed(4)}`)
      }
    }

    console.log(`\nRunning ${benchmarkSettings.numRuns} benchmark iterations...\n`)

    // --- Benchmark runs ---
    for (let i = 0; i < benchmarkSettings.numRuns; i++) {
      receivedStats.length = 0
      const runStart = getTimeMs()

      await parakeet.append({ type: 'audio', data: audioData.buffer })
      await parakeet.append({ type: 'end of job' })

      const deadline = getTimeMs() + 600000
      while (receivedStats.length === 0 && getTimeMs() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 50))
      }

      const wallMs = getTimeMs() - runStart

      if (receivedStats.length === 0) {
        console.log(`  Run ${i + 1}: TIMEOUT (no JobEnded received)`)
        continue
      }

      const jobStats = receivedStats[receivedStats.length - 1]
      const run = {
        iteration: i + 1,
        wallMs,
        rtf: jobStats.realTimeFactor || 0,
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
        totalWallMs: jobStats.totalWallMs || 0
      }

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
      model: {
        type: benchmarkSettings.modelType,
        path: modelPath,
        dirName: path.basename(modelPath)
      },
      labels: {
        runner: benchmarkSettings.runnerLabel,
        device: benchmarkSettings.deviceLabel,
        backend: getRequestedBackendFamily(platformName, benchmarkSettings.useGPU, benchmarkSettings.backendHint),
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
        maxThreads: config.maxThreads,
        useGPU: config.useGPU,
        sampleRate: config.sampleRate
      },
      requested: {
        modelType: benchmarkSettings.modelType,
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
        decoderMs: decoderStats
      },
      runs: allResults
    }

    const emittedSummary = {
      schemaVersion: 1,
      platform,
      platformName,
      arch: archName || '',
      modelType: benchmarkSettings.modelType,
      useGPU: benchmarkSettings.useGPU,
      backendHint: getRequestedBackendFamily(platformName, benchmarkSettings.useGPU, benchmarkSettings.backendHint),
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
    if (parakeet) {
      try { parakeet.destroyInstance() } catch (_) {}
    }
    try { loggerBinding.releaseLogger() } catch (_) {}
  }
})
