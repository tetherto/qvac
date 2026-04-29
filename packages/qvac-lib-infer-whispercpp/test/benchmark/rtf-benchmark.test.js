'use strict'

/**
 * Real-Time Factor (RTF) Benchmark
 *
 * Captures Whisper runtime stats directly from the high-level response object
 * when `opts.stats=true` is enabled. Results are written to JSON so the
 * desktop integration workflow can upload them as artifacts for comparison
 * across CI runners.
 */

const test = require('brittle')
const fs = require('bare-fs')
const path = require('bare-path')
const process = require('bare-process')
const TranscriptionWhispercpp = require('../../index.js')
const binding = require('../../binding')
const {
  detectPlatform,
  setupJsLogger,
  getTestPaths,
  ensureWhisperModel,
  generateTestAudio,
  createAudioStream,
  getAssetPath,
  isMobile
} = require('../integration/helpers.js')

const platform = detectPlatform()
const { modelsDir, audioPath, samplesDir } = getTestPaths()

const SAMPLE_RATE = 16000
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
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function getBenchmarkSettings () {
  const modelFile = process.env.QVAC_WHISPER_BENCHMARK_MODEL_FILE || 'ggml-tiny.bin'
  const label = sanitizeTag(process.env.QVAC_WHISPER_BENCHMARK_LABEL || '')
  const backendHint = process.env.QVAC_WHISPER_BENCHMARK_BACKEND || ''
  const deviceLabel = process.env.QVAC_WHISPER_BENCHMARK_DEVICE || ''
  const runnerLabel = process.env.QVAC_WHISPER_BENCHMARK_RUNNER || ''

  return {
    modelFile,
    modelPath: path.join(modelsDir, modelFile),
    numWarmup: getEnvInteger('QVAC_WHISPER_BENCHMARK_WARMUP_RUNS', 1),
    numRuns: getEnvInteger('QVAC_WHISPER_BENCHMARK_RUNS', isMobile ? 3 : 5),
    useGPU: getEnvBoolean('QVAC_WHISPER_BENCHMARK_USE_GPU', isMobile),
    gpuDevice: getEnvInteger('QVAC_WHISPER_BENCHMARK_GPU_DEVICE', 0),
    threads: getEnvInteger('QVAC_WHISPER_BENCHMARK_THREADS', 0),
    backendHint,
    deviceLabel,
    runnerLabel,
    label,
    requestedUpperBound: process.env.QVAC_WHISPER_BENCHMARK_RTF_UPPER_BOUND
  }
}

function getUpperBound (benchmarkSettings) {
  if (benchmarkSettings.requestedUpperBound === undefined) return null
  const parsed = Number.parseFloat(benchmarkSettings.requestedUpperBound)
  return Number.isNaN(parsed) ? null : parsed
}

function getRequestedBackendFamily (platformName, useGPU, backendHint) {
  if (backendHint) return backendHint
  if (!useGPU) return 'cpu'
  if (platformName === 'darwin' || platformName === 'ios') return 'coreml'
  if (platformName === 'win32') return 'directml'
  if (platformName === 'linux') return 'cuda'
  if (platformName === 'android') return 'nnapi'
  return 'gpu'
}

function getArtifactFileName (benchmarkSettings) {
  const parts = [
    'rtf-benchmark',
    platform,
    sanitizeTag(benchmarkSettings.modelFile.replace(/\.bin$/, '')),
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
  const variance = sorted.reduce((acc, value) => acc + (value - mean) ** 2, 0) / sorted.length

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

function getMobileReportDirs () {
  const dirs = []
  if (global.testDir) dirs.push(global.testDir)
  if (platform.startsWith('android')) {
    dirs.push('/sdcard/Android/data/io.tether.test.qvac/files')
    dirs.push('/storage/emulated/0/Android/data/io.tether.test.qvac/files')
    dirs.push('/data/local/tmp')
  }
  dirs.push('/tmp')
  return dirs
}

function createPerfReport (benchmarkSettings, report, platformName, archName) {
  const backend = getRequestedBackendFamily(platformName, benchmarkSettings.useGPU, benchmarkSettings.backendHint)
  const rtf = report.summary.rtf || {}
  const wallMs = report.summary.wallMs || {}
  const tps = report.summary.tokensPerSecond || {}
  const encodeMs = report.summary.whisperEncodeMs || {}
  const decodeMs = report.summary.whisperDecodeMs || {}
  const ep = benchmarkSettings.useGPU ? backend : 'cpu'

  return {
    schema_version: '1.0',
    addon: 'whispercpp',
    addon_type: 'whisper',
    timestamp: report.timestamp,
    device: {
      name: benchmarkSettings.deviceLabel || platform,
      platform: platformName || platform,
      os_version: '',
      arch: archName || '',
      runner: benchmarkSettings.runnerLabel || (isMobile ? 'device-farm' : 'local')
    },
    results: [{
      test: '[' + ep.toUpperCase() + '] ' + benchmarkSettings.modelFile.replace(/\.bin$/, ''),
      execution_provider: ep,
      metrics: {
        total_time_ms: Number(wallMs.mean) || null,
        real_time_factor: Number(rtf.mean) || null,
        wall_time_ms: Number(wallMs.mean) || null,
        tps: Number(tps.mean) || null,
        encoder_time_ms: Number(encodeMs.mean) || null,
        decoder_time_ms: Number(decodeMs.mean) || null,
        audio_duration_ms: Math.round(report.audio.durationSec * 1000),
        sample_count: report.runs.length
      },
      input: benchmarkSettings.modelFile,
      output: null
    }]
  }
}

function writePerfReportToMobilePaths (perfReport) {
  const json = JSON.stringify(perfReport)
  for (const dir of getMobileReportDirs()) {
    try {
      try { fs.mkdirSync(dir, { recursive: true }) } catch (_) {}
      const reportPath = path.join(dir, 'perf-report.json')
      fs.writeFileSync(reportPath, json)
      console.log('[PERF_REPORT_PATH]' + reportPath)
    } catch (err) {
      console.log('[perf-reporter] write to ' + dir + ' failed: ' + err.message)
    }
  }
}

function writePerfReportToConsole (perfReport) {
  const json = JSON.stringify(perfReport)
  const chunkSize = 800
  if (json.length <= chunkSize) {
    console.log('[PERF_REPORT_START]' + json + '[PERF_REPORT_END]')
    return
  }

  const id = Date.now().toString(36)
  const chunkCount = Math.ceil(json.length / chunkSize)
  for (let i = 0; i < chunkCount; i++) {
    const chunk = json.substring(i * chunkSize, (i + 1) * chunkSize)
    console.log('[PERF_CHUNK:' + id + ':' + i + ':' + chunkCount + ']' + chunk)
  }
}

function emitMobilePerfReport (benchmarkSettings, report, platformName, archName) {
  if (!isMobile) return
  const perfReport = createPerfReport(benchmarkSettings, report, platformName, archName)
  try { writePerfReportToMobilePaths(perfReport) } catch (_) {}
  try { writePerfReportToConsole(perfReport) } catch (_) {}
}

function getAudioDurationSec (samplePath) {
  const rawBuffer = fs.readFileSync(samplePath)
  return rawBuffer.length / 2 / SAMPLE_RATE
}

async function runSingleBenchmark (model, samplePath) {
  const audioStream = createAudioStream(samplePath)
  const wallStart = getTimeMs()
  const response = await model.run(audioStream)
  await response.await()

  const jobStats = response.stats
  if (!jobStats) {
    throw new Error('Whisper response did not include runtime stats')
  }

  return {
    wallMs: getTimeMs() - wallStart,
    rtf: jobStats.realTimeFactor || 0,
    totalTimeSec: jobStats.totalTime || 0,
    audioDurationMs: jobStats.audioDurationMs || 0,
    tokensPerSecond: jobStats.tokensPerSecond || 0,
    totalTokens: jobStats.totalTokens || 0,
    totalSamples: jobStats.totalSamples || 0,
    totalSegments: jobStats.totalSegments || 0,
    processCalls: jobStats.processCalls || 0,
    whisperSampleMs: jobStats.whisperSampleMs || 0,
    whisperEncodeMs: jobStats.whisperEncodeMs || 0,
    whisperDecodeMs: jobStats.whisperDecodeMs || 0,
    whisperBatchdMs: jobStats.whisperBatchdMs || 0,
    whisperPromptMs: jobStats.whisperPromptMs || 0,
    totalWallMs: jobStats.totalWallMs || 0
  }
}

test('RTF benchmark: collect whisper real-time factor on CI device', { timeout: 600000 }, async (t) => {
  const benchmarkSettings = getBenchmarkSettings()
  const upperBound = getUpperBound(benchmarkSettings)
  const [platformName, archName] = platform.split('-')
  const loggerBinding = setupJsLogger(binding)
  let model = null

  try {
    console.log('\n' + '='.repeat(70))
    console.log('WHISPER RTF BENCHMARK')
    console.log('='.repeat(70))
    console.log(`  Platform:       ${platform}`)
    console.log(`  Model path:     ${benchmarkSettings.modelPath}`)
    console.log(`  GPU requested:  ${benchmarkSettings.useGPU}`)
    if (benchmarkSettings.backendHint) console.log(`  Backend hint:   ${benchmarkSettings.backendHint}`)
    if (benchmarkSettings.deviceLabel) console.log(`  Device label:   ${benchmarkSettings.deviceLabel}`)
    if (benchmarkSettings.runnerLabel) console.log(`  Runner label:   ${benchmarkSettings.runnerLabel}`)
    console.log(`  Warmup runs:    ${benchmarkSettings.numWarmup}`)
    console.log(`  Benchmark runs: ${benchmarkSettings.numRuns}`)
    console.log('='.repeat(70) + '\n')

    await ensureWhisperModel(benchmarkSettings.modelPath)

    let samplePath = isMobile
      ? getAssetPath('sample.raw')
      : path.join(samplesDir, 'sample.raw')

    if (!fs.existsSync(samplePath) && !isMobile) {
      samplePath = generateTestAudio(audioPath)
      console.log(`Using generated benchmark audio: ${samplePath}`)
    }

    if (!fs.existsSync(samplePath)) {
      t.pass('RTF benchmark skipped because no audio sample is available')
      return
    }

    const audioDurationSec = getAudioDurationSec(samplePath)
    console.log(`  Audio path:     ${samplePath}`)
    console.log(`  Audio duration: ${audioDurationSec.toFixed(2)}s\n`)

    const constructorArgs = {
      files: {
        model: benchmarkSettings.modelPath
      },
      opts: { stats: true }
    }

    const config = {
      path: benchmarkSettings.modelPath,
      contextParams: {
        use_gpu: benchmarkSettings.useGPU,
        gpu_device: benchmarkSettings.gpuDevice
      },
      whisperConfig: {
        language: 'en',
        audio_format: 's16le',
        temperature: 0.0,
        n_threads: benchmarkSettings.threads
      }
    }

    console.log('Loading model...')
    const loadStart = getTimeMs()
    model = new TranscriptionWhispercpp(constructorArgs, config)
    await model._load()
    const loadMs = getTimeMs() - loadStart
    console.log(`Model loaded in ${loadMs.toFixed(0)}ms\n`)

    for (let i = 0; i < benchmarkSettings.numWarmup; i++) {
      console.log(`[warmup ${i + 1}/${benchmarkSettings.numWarmup}]`)
      const warmup = await runSingleBenchmark(model, samplePath)
      console.log(
        `  RTF=${warmup.rtf.toFixed(4)}  ` +
        `wall=${warmup.wallMs.toFixed(0)}ms  ` +
        `tokens/s=${warmup.tokensPerSecond.toFixed(1)}`
      )
    }

    console.log(`\nRunning ${benchmarkSettings.numRuns} benchmark iterations...\n`)

    const allResults = []
    for (let i = 0; i < benchmarkSettings.numRuns; i++) {
      const run = await runSingleBenchmark(model, samplePath)
      const result = {
        iteration: i + 1,
        requestedUseGPU: benchmarkSettings.useGPU,
        requestedBackend: benchmarkSettings.backendHint,
        ...run
      }

      allResults.push(result)

      console.log(
        `  Run ${i + 1}/${benchmarkSettings.numRuns}: ` +
        `RTF=${result.rtf.toFixed(4)}  ` +
        `wall=${result.wallMs.toFixed(0)}ms  ` +
        `tokens/s=${result.tokensPerSecond.toFixed(1)}  ` +
        `encode=${result.whisperEncodeMs.toFixed(0)}ms  ` +
        `decode=${result.whisperDecodeMs.toFixed(0)}ms`
      )
    }

    const rtfStats = stats(allResults.map(result => result.rtf))
    const wallStats = stats(allResults.map(result => result.wallMs))
    const tpsStats = stats(allResults.map(result => result.tokensPerSecond))
    const encodeStats = stats(allResults.map(result => result.whisperEncodeMs))
    const decodeStats = stats(allResults.map(result => result.whisperDecodeMs))

    console.log('\n' + '='.repeat(70))
    console.log('WHISPER RTF BENCHMARK RESULTS')
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
    console.log('  Encode (ms):')
    console.log(`    Mean:   ${encodeStats.mean.toFixed(0)}`)
    console.log(`    P50:    ${encodeStats.p50.toFixed(0)}`)
    console.log('')
    console.log('  Decode (ms):')
    console.log(`    Mean:   ${decodeStats.mean.toFixed(0)}`)
    console.log(`    P50:    ${decodeStats.p50.toFixed(0)}`)
    console.log('')
    console.log('='.repeat(70) + '\n')

    const report = {
      timestamp: new Date().toISOString(),
      platform,
      platformName,
      arch: archName || '',
      isMobile,
      model: {
        name: path.basename(benchmarkSettings.modelPath),
        path: benchmarkSettings.modelPath
      },
      labels: {
        runner: benchmarkSettings.runnerLabel,
        device: benchmarkSettings.deviceLabel,
        backend: getRequestedBackendFamily(platformName, benchmarkSettings.useGPU, benchmarkSettings.backendHint),
        label: benchmarkSettings.label
      },
      audio: {
        path: samplePath,
        durationSec: audioDurationSec,
        sampleRate: SAMPLE_RATE
      },
      config: {
        warmupRuns: benchmarkSettings.numWarmup,
        benchmarkRuns: benchmarkSettings.numRuns,
        useGPU: benchmarkSettings.useGPU,
        threads: benchmarkSettings.threads
      },
      requested: {
        modelFile: benchmarkSettings.modelFile,
        useGPU: benchmarkSettings.useGPU,
        gpuDevice: benchmarkSettings.gpuDevice,
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
        whisperEncodeMs: encodeStats,
        whisperDecodeMs: decodeStats
      },
      runs: allResults
    }

    if (!fs.existsSync(RTF_RESULTS_DIR)) {
      fs.mkdirSync(RTF_RESULTS_DIR, { recursive: true })
    }

    const outPath = path.join(RTF_RESULTS_DIR, getArtifactFileName(benchmarkSettings))
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2))
    console.log(`Results written to ${outPath}\n`)
    console.log(`${RESULT_MARKER}${JSON.stringify({
      schemaVersion: 1,
      platform,
      platformName,
      arch: archName || '',
      modelFile: benchmarkSettings.modelFile,
      useGPU: benchmarkSettings.useGPU,
      backendHint: getRequestedBackendFamily(platformName, benchmarkSettings.useGPU, benchmarkSettings.backendHint),
      deviceLabel: benchmarkSettings.deviceLabel,
      runnerLabel: benchmarkSettings.runnerLabel,
      summary: report.summary
    })}`)
    emitMobilePerfReport(benchmarkSettings, report, platformName, archName)

    t.is(allResults.length, benchmarkSettings.numRuns, `Completed ${benchmarkSettings.numRuns} benchmark runs`)
    t.ok(rtfStats.mean > 0, 'Mean RTF should be positive')
    if (upperBound !== null) {
      t.ok(rtfStats.mean <= upperBound, `Mean RTF ${rtfStats.mean.toFixed(4)} should be <= ${upperBound}`)
    }
    t.ok(tpsStats.mean > 0, 'Tokens/second should be positive')
  } finally {
    if (model) {
      try { await model.unload() } catch {}
    }
    try { loggerBinding.releaseLogger() } catch {}
  }
})
