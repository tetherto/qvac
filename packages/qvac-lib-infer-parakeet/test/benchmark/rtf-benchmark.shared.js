'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const os = require('bare-os')
const process = require('bare-process')
const {
  binding,
  ParakeetInterface,
  detectPlatform,
  setupJsLogger,
  getTestPaths,
  ensureModel,
  ensureModelForType,
  getNamedPathsConfig,
  isMobile
} = require('../integration/helpers.js')

const SAMPLE_RATE = 16000
const VALID_MODEL_TYPES = ['tdt', 'ctc', 'eou', 'sortformer']
const RESULT_MARKER = 'QVAC_RTF_REPORT::'
const DESKTOP_RESULTS_DIR = path.resolve(__dirname, '../../benchmarks/results')
const DEFAULT_MOBILE_BENCHMARK_MATRIX = [
  { modelType: 'tdt', useGPU: false, backendHint: 'cpu', label: 'mobile-tdt-cpu' },
  { modelType: 'tdt', useGPU: true, label: 'mobile-tdt-gpu' }
]

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
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
}

function normalizeBoolean (value) {
  return value === true || value === 'true' || value === '1'
}

function parseBenchmarkMatrixConfig (raw, fallback) {
  if (!raw) return fallback

  const parsed = JSON.parse(raw)
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('QVAC_PARAKEET_BENCHMARK_MATRIX_JSON must be a non-empty JSON array')
  }

  return parsed
}

function buildMatrixLabel (entry, index) {
  if (entry && entry.label) return sanitizeTag(entry.label)
  const modelType = entry && entry.modelType ? String(entry.modelType) : 'tdt'
  const useGPU = entry && normalizeBoolean(entry.useGPU)
  return `${index + 1}-${sanitizeTag(modelType)}-${useGPU ? 'gpu' : 'cpu'}`
}

function getBenchmarkSettings (overrides = {}) {
  const requestedModelType = String(
    overrides.modelType !== undefined
      ? overrides.modelType
      : (process.env.QVAC_PARAKEET_BENCHMARK_MODEL_TYPE || 'tdt')
  ).toLowerCase()

  if (!VALID_MODEL_TYPES.includes(requestedModelType)) {
    throw new Error(`Invalid benchmark model type: ${requestedModelType}`)
  }

  const label = sanitizeTag(
    overrides.label !== undefined
      ? overrides.label
      : (process.env.QVAC_PARAKEET_BENCHMARK_LABEL || '')
  )

  const backendHint = overrides.backendHint !== undefined
    ? String(overrides.backendHint || '')
    : (process.env.QVAC_PARAKEET_BENCHMARK_BACKEND || '')

  const deviceLabel = overrides.deviceLabel !== undefined
    ? String(overrides.deviceLabel || '')
    : (process.env.QVAC_PARAKEET_BENCHMARK_DEVICE || '')

  const runnerLabel = overrides.runnerLabel !== undefined
    ? String(overrides.runnerLabel || '')
    : (process.env.QVAC_PARAKEET_BENCHMARK_RUNNER || '')

  return {
    modelType: requestedModelType,
    maxThreads: overrides.maxThreads !== undefined
      ? Number.parseInt(String(overrides.maxThreads), 10)
      : getEnvInteger('QVAC_PARAKEET_BENCHMARK_THREADS', 4),
    numWarmup: overrides.numWarmup !== undefined
      ? Number.parseInt(String(overrides.numWarmup), 10)
      : getEnvInteger('QVAC_PARAKEET_BENCHMARK_WARMUP_RUNS', 1),
    numRuns: overrides.numRuns !== undefined
      ? Number.parseInt(String(overrides.numRuns), 10)
      : getEnvInteger('QVAC_PARAKEET_BENCHMARK_RUNS', isMobile ? 3 : 5),
    useGPU: overrides.useGPU !== undefined
      ? normalizeBoolean(overrides.useGPU)
      : getEnvBoolean('QVAC_PARAKEET_BENCHMARK_USE_GPU', false),
    backendHint,
    deviceLabel,
    runnerLabel,
    label,
    requestedUpperBound: overrides.rtfUpperBound !== undefined
      ? String(overrides.rtfUpperBound)
      : process.env.QVAC_PARAKEET_BENCHMARK_RTF_UPPER_BOUND
  }
}

async function resolveModelPath (benchmarkSettings) {
  const { modelPath: defaultModelPath } = getTestPaths()

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

function getArtifactFileName (platform, benchmarkSettings) {
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

function getDefaultResultsDir () {
  if (!isMobile) return DESKTOP_RESULTS_DIR
  const writableRoot = global.testDir || global.cacheDir || os.tmpdir()
  return path.join(writableRoot, 'qvac-parakeet-rtf-results')
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

function readRawSampleAsFloat32 (samplePath) {
  const rawBuffer = fs.readFileSync(samplePath)
  const pcmData = new Int16Array(rawBuffer.buffer, rawBuffer.byteOffset, rawBuffer.length / 2)
  const audioData = new Float32Array(pcmData.length)

  for (let i = 0; i < pcmData.length; i++) {
    audioData[i] = pcmData[i] / 32768.0
  }

  return audioData
}

async function waitForJobEnded (receivedStats, deadlineMs, pollMs) {
  while (receivedStats.length === 0 && getTimeMs() < deadlineMs) {
    await new Promise(resolve => setTimeout(resolve, pollMs))
  }
}

function logBenchmarkHeader (platform, modelPath, benchmarkSettings) {
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
}

function logBenchmarkSummary (platform, audioDurationSec, allResults, reportSummary) {
  console.log('\n' + '='.repeat(70))
  console.log('RTF BENCHMARK RESULTS')
  console.log('='.repeat(70))
  console.log(`\n  Platform:        ${platform}`)
  console.log(`  Audio duration:  ${audioDurationSec.toFixed(2)}s`)
  console.log(`  Iterations:      ${allResults.length}`)
  console.log('')
  console.log('  Real-Time Factor (RTF):')
  console.log(`    Mean:   ${reportSummary.rtf.mean.toFixed(4)}`)
  console.log(`    Min:    ${reportSummary.rtf.min.toFixed(4)}`)
  console.log(`    Max:    ${reportSummary.rtf.max.toFixed(4)}`)
  console.log(`    Stddev: ${reportSummary.rtf.stddev.toFixed(4)}`)
  console.log(`    P50:    ${reportSummary.rtf.p50.toFixed(4)}`)
  console.log(`    P95:    ${reportSummary.rtf.p95.toFixed(4)}`)
  console.log('')
  console.log('  Wall Time (ms):')
  console.log(`    Mean:   ${reportSummary.wallMs.mean.toFixed(0)}`)
  console.log(`    P50:    ${reportSummary.wallMs.p50.toFixed(0)}`)
  console.log(`    P95:    ${reportSummary.wallMs.p95.toFixed(0)}`)
  console.log('')
  console.log('  Tokens/Second:')
  console.log(`    Mean:   ${reportSummary.tokensPerSecond.mean.toFixed(1)}`)
  console.log(`    P50:    ${reportSummary.tokensPerSecond.p50.toFixed(1)}`)
  console.log('')
  console.log('  Encoder (ms):')
  console.log(`    Mean:   ${reportSummary.encoderMs.mean.toFixed(0)}`)
  console.log(`    P50:    ${reportSummary.encoderMs.p50.toFixed(0)}`)
  console.log('')
  console.log('  Decoder (ms):')
  console.log(`    Mean:   ${reportSummary.decoderMs.mean.toFixed(0)}`)
  console.log(`    P50:    ${reportSummary.decoderMs.p50.toFixed(0)}`)
  console.log('')
  console.log('='.repeat(70) + '\n')
}

function buildReport (options) {
  const {
    platform,
    platformName,
    archName,
    benchmarkSettings,
    modelPath,
    audioData,
    audioDurationSec,
    config,
    allResults
  } = options

  const reportSummary = {
    rtf: stats(allResults.map(run => run.rtf)),
    wallMs: stats(allResults.map(run => run.wallMs)),
    tokensPerSecond: stats(allResults.map(run => run.tokensPerSecond)),
    encoderMs: stats(allResults.map(run => run.encoderMs)),
    decoderMs: stats(allResults.map(run => run.decoderMs))
  }

  return {
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
    summary: reportSummary,
    runs: allResults
  }
}

function emitMarkerPayload (report, options = {}) {
  const markerPayload = {
    schemaVersion: options.schemaVersion || 2,
    kind: 'parakeet-rtf-report',
    platform: report.platform,
    platformName: report.platformName,
    arch: report.arch,
    isMobile: report.isMobile,
    modelType: report.model && report.model.type,
    useGPU: report.requested && report.requested.useGPU,
    backendHint: report.labels && report.labels.backend,
    deviceLabel: report.labels && report.labels.device,
    runnerLabel: report.labels && report.labels.runner,
    label: report.labels && report.labels.label,
    summary: report.summary
  }

  if (options.reportPath) {
    markerPayload.reportPath = options.reportPath
  }

  if (options.emitInlineReport) {
    markerPayload.report = report
  }

  console.log(`${RESULT_MARKER}${JSON.stringify(markerPayload)}`)
  return markerPayload
}

function writeReportArtifact (platform, benchmarkSettings, report, options = {}) {
  const resultsDir = options.resultsDir || getDefaultResultsDir()
  let outPath = null

  try {
    if (!fs.existsSync(resultsDir)) {
      fs.mkdirSync(resultsDir, { recursive: true })
    }

    outPath = path.join(resultsDir, getArtifactFileName(platform, benchmarkSettings))
    fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`)
    console.log(`Results written to ${outPath}\n`)
  } catch (writeErr) {
    console.log(`Warning: could not write results file: ${writeErr.message}`)
  }

  const markerPayload = emitMarkerPayload(report, {
    schemaVersion: 2,
    reportPath: outPath,
    emitInlineReport: options.emitInlineReport === true
  })

  return { outPath, markerPayload }
}

async function runRtfBenchmark (overrides = {}) {
  const loggerBinding = setupJsLogger(binding)
  const benchmarkSettings = getBenchmarkSettings(overrides)
  const modelPath = await resolveModelPath(benchmarkSettings)
  const upperBound = getUpperBound(benchmarkSettings)
  const platform = detectPlatform()
  const [platformName, archName] = platform.split('-')
  const { samplesDir } = getTestPaths()
  const samplePath = overrides.samplePath || path.join(samplesDir, 'sample.raw')

  logBenchmarkHeader(platform, modelPath, benchmarkSettings)

  if (!fs.existsSync(samplePath)) {
    return {
      skipped: true,
      reason: `Test skipped - sample audio not found at ${samplePath}`,
      benchmarkSettings,
      samplePath
    }
  }

  const audioData = readRawSampleAsFloat32(samplePath)
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

    const silentAudio = new Float32Array(SAMPLE_RATE).fill(0)
    receivedStats.length = 0
    await parakeet.append({ type: 'audio', data: silentAudio.buffer })
    await parakeet.append({ type: 'end of job' })
    await waitForJobEnded(receivedStats, getTimeMs() + 30000, 100)

    const loadMs = getTimeMs() - loadStart
    console.log(`Model loaded and initialised in ${loadMs.toFixed(0)}ms\n`)

    for (let warmupIndex = 0; warmupIndex < benchmarkSettings.numWarmup; warmupIndex++) {
      console.log(`[warmup ${warmupIndex + 1}/${benchmarkSettings.numWarmup}]`)
      receivedStats.length = 0
      await parakeet.append({ type: 'audio', data: audioData.buffer })
      await parakeet.append({ type: 'end of job' })
      await waitForJobEnded(receivedStats, getTimeMs() + 600000, 50)

      if (receivedStats.length > 0) {
        const warmupStats = receivedStats[receivedStats.length - 1]
        console.log(`  RTF (warmup): ${(warmupStats.realTimeFactor || 0).toFixed(4)}`)
      }
    }

    console.log(`\nRunning ${benchmarkSettings.numRuns} benchmark iterations...\n`)

    for (let runIndex = 0; runIndex < benchmarkSettings.numRuns; runIndex++) {
      receivedStats.length = 0
      const runStart = getTimeMs()

      await parakeet.append({ type: 'audio', data: audioData.buffer })
      await parakeet.append({ type: 'end of job' })
      await waitForJobEnded(receivedStats, getTimeMs() + 600000, 50)

      const wallMs = getTimeMs() - runStart

      if (receivedStats.length === 0) {
        console.log(`  Run ${runIndex + 1}: TIMEOUT (no JobEnded received)`)
        continue
      }

      const jobStats = receivedStats[receivedStats.length - 1]
      const run = {
        iteration: runIndex + 1,
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

      console.log(`  Run ${runIndex + 1}/${benchmarkSettings.numRuns}: ` +
        `RTF=${run.rtf.toFixed(4)}  ` +
        `wall=${wallMs.toFixed(0)}ms  ` +
        `tokens/s=${run.tokensPerSecond.toFixed(1)}  ` +
        `encoder=${run.encoderMs.toFixed(0)}ms  ` +
        `decoder=${run.decoderMs.toFixed(0)}ms`)

      if (isMobile) {
        await new Promise(resolve => setTimeout(resolve, 200))
      }
    }

    if (allResults.length === 0) {
      throw new Error('No benchmark results collected')
    }

    const report = buildReport({
      platform,
      platformName,
      archName,
      benchmarkSettings,
      modelPath,
      audioData,
      audioDurationSec,
      config,
      allResults
    })

    logBenchmarkSummary(platform, audioDurationSec, allResults, report.summary)

    const artifact = writeReportArtifact(platform, benchmarkSettings, report, {
      resultsDir: overrides.resultsDir,
      emitInlineReport: overrides.emitInlineReport === true
    })

    if (upperBound !== null && report.summary.rtf.mean > upperBound) {
      throw new Error(`Mean RTF ${report.summary.rtf.mean.toFixed(4)} should be <= ${upperBound}`)
    }

    console.log('RTF benchmark completed successfully!\n')

    return {
      skipped: false,
      benchmarkSettings,
      report,
      outPath: artifact.outPath,
      markerPayload: artifact.markerPayload
    }
  } finally {
    if (parakeet) {
      try { parakeet.destroyInstance() } catch (_) {}
    }
    try { loggerBinding.releaseLogger() } catch (_) {}
  }
}

async function runRtfBenchmarkMatrix (matrix, options = {}) {
  const reports = []
  for (let i = 0; i < matrix.length; i++) {
    const entry = matrix[i] || {}
    const result = await runRtfBenchmark({
      ...options,
      ...entry,
      label: entry.label || buildMatrixLabel(entry, i)
    })
    reports.push(result)
  }
  return reports
}

module.exports = {
  SAMPLE_RATE,
  VALID_MODEL_TYPES,
  RESULT_MARKER,
  DEFAULT_MOBILE_BENCHMARK_MATRIX,
  buildMatrixLabel,
  getBenchmarkSettings,
  getRequestedBackendFamily,
  parseBenchmarkMatrixConfig,
  runRtfBenchmark,
  runRtfBenchmarkMatrix
}
