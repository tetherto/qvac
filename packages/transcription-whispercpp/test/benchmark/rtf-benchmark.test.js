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
  isMobile
} = require('../integration/helpers.js')
const {
  readRssBytes,
  createMemorySampler,
  buildMemorySummary,
  bytesToMb,
  meanOfPositive,
  maxOfPositive,
  RECLAIM_SETTLE_MS
} = require('../integration/memory-usage.js')

const platform = detectPlatform()
const { modelsDir, audioPath, samplesDir } = getTestPaths()

const SAMPLE_RATE = 16000
const RTF_RESULTS_DIR = path.resolve(__dirname, '../../benchmarks/results')
const RESULT_MARKER = 'QVAC_RTF_REPORT::'

function getEnvBoolean(name, fallback) {
  const value = process.env[name]
  if (value === undefined) return fallback
  return value === '1' || value === 'true' || value === 'TRUE' || value === 'yes'
}

function getEnvInteger(name, fallback) {
  const value = process.env[name]
  if (value === undefined) return fallback
  const parsed = Number.parseInt(value, 10)
  return Number.isNaN(parsed) ? fallback : parsed
}

function sanitizeTag(value) {
  if (!value) return ''
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function getBenchmarkSettings() {
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
    useGPU: getEnvBoolean('QVAC_WHISPER_BENCHMARK_USE_GPU', false),
    gpuDevice: getEnvInteger('QVAC_WHISPER_BENCHMARK_GPU_DEVICE', 0),
    threads: getEnvInteger('QVAC_WHISPER_BENCHMARK_THREADS', 0),
    backendHint,
    deviceLabel,
    runnerLabel,
    label,
    requestedUpperBound: process.env.QVAC_WHISPER_BENCHMARK_RTF_UPPER_BOUND
  }
}

function getUpperBound(benchmarkSettings) {
  if (benchmarkSettings.requestedUpperBound === undefined) return null
  const parsed = Number.parseFloat(benchmarkSettings.requestedUpperBound)
  return Number.isNaN(parsed) ? null : parsed
}

function getRequestedBackendFamily(platformName, useGPU, backendHint) {
  if (backendHint) return backendHint
  if (!useGPU) return 'cpu'
  // ggml GPU backend by platform: Metal on Apple, Vulkan on Windows (the
  // prebuild is a Vulkan build) and Linux, Vulkan/OpenCL on Android.
  if (platformName === 'darwin' || platformName === 'ios') return 'metal'
  if (platformName === 'win32') return 'vulkan'
  if (platformName === 'linux') return 'vulkan'
  if (platformName === 'android') return 'vulkan'
  return 'gpu'
}

function getArtifactFileName(benchmarkSettings) {
  const parts = ['rtf-benchmark', platform]

  if (benchmarkSettings.runnerLabel) {
    parts.push(sanitizeTag(benchmarkSettings.runnerLabel))
  }

  parts.push(
    sanitizeTag(benchmarkSettings.modelFile.replace(/\.bin$/, '')),
    benchmarkSettings.useGPU ? 'gpu' : 'cpu'
  )

  if (benchmarkSettings.label) {
    parts.push(benchmarkSettings.label)
  }

  return `${parts.join('-')}.json`
}

function getTimeMs() {
  const [sec, nsec] = process.hrtime()
  return sec * 1000 + nsec / 1e6
}

function percentile(sorted, p) {
  const idx = (p / 100) * (sorted.length - 1)
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return sorted[lo]
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo)
}

function stats(values) {
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

function getAudioDurationSec(samplePath) {
  const rawBuffer = fs.readFileSync(samplePath)
  return rawBuffer.length / 2 / SAMPLE_RATE
}

async function runSingleBenchmark(model, samplePath) {
  const audioStream = createAudioStream(samplePath)
  const sampler = createMemorySampler()
  const wallStart = getTimeMs()
  sampler.start()
  const response = await model.run(audioStream)
  await response.await()
  const memory = sampler.stop()

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
    totalWallMs: jobStats.totalWallMs || 0,
    avgRssBytes: memory.avgBytes,
    peakRssBytes: memory.peakBytes,
    rssSampleCount: memory.count,
    gpuMemTotalMb: typeof jobStats.gpuMemTotalMb === 'number' ? jobStats.gpuMemTotalMb : -1,
    gpuMemFreeMb: typeof jobStats.gpuMemFreeMb === 'number' ? jobStats.gpuMemFreeMb : -1
  }
}

async function reclaimAfterUnload(model) {
  try {
    await model.unload()
  } catch {}
  if (typeof global.gc === 'function') {
    try {
      global.gc()
    } catch {}
  }
  await new Promise((resolve) => setTimeout(resolve, RECLAIM_SETTLE_MS))
  return readRssBytes()
}

async function measureMemory(model, allResults, rssBeforeLoad, rssAfterLoad) {
  const avgRssBytes = meanOfPositive(allResults.map((result) => result.avgRssBytes)) || rssAfterLoad
  const peakRssBytes = maxOfPositive(
    allResults.map((result) => result.peakRssBytes),
    rssAfterLoad
  )
  const sampleCount = allResults.reduce((sum, result) => sum + (result.rssSampleCount || 0), 0)
  const lastResult = allResults[allResults.length - 1] || {}
  const rssAfterUnload = await reclaimAfterUnload(model)

  const summary = buildMemorySummary({
    rssBeforeLoadBytes: rssBeforeLoad,
    rssAfterLoadBytes: rssAfterLoad,
    avgRssBytes,
    peakRssBytes,
    rssAfterUnloadBytes: rssAfterUnload,
    sampleCount
  })
  summary.gpuMemTotalMb =
    typeof lastResult.gpuMemTotalMb === 'number' ? lastResult.gpuMemTotalMb : -1
  summary.gpuMemFreeMb = typeof lastResult.gpuMemFreeMb === 'number' ? lastResult.gpuMemFreeMb : -1
  return summary
}

test(
  'RTF benchmark: collect whisper real-time factor on CI device',
  { timeout: 600000 },
  async (t) => {
    if (isMobile) {
      t.pass('RTF benchmark is only collected on desktop CI runners')
      return
    }

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
      if (benchmarkSettings.backendHint)
        console.log(`  Backend hint:   ${benchmarkSettings.backendHint}`)
      if (benchmarkSettings.deviceLabel)
        console.log(`  Device label:   ${benchmarkSettings.deviceLabel}`)
      if (benchmarkSettings.runnerLabel)
        console.log(`  Runner label:   ${benchmarkSettings.runnerLabel}`)
      console.log(`  Warmup runs:    ${benchmarkSettings.numWarmup}`)
      console.log(`  Benchmark runs: ${benchmarkSettings.numRuns}`)
      console.log('='.repeat(70) + '\n')

      await ensureWhisperModel(benchmarkSettings.modelPath)

      let samplePath = path.join(samplesDir, 'sample.raw')
      if (!fs.existsSync(samplePath)) {
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
      const rssBeforeLoad = readRssBytes()
      const loadStart = getTimeMs()
      model = new TranscriptionWhispercpp(constructorArgs, config)
      await model._load()
      const loadMs = getTimeMs() - loadStart
      const rssAfterLoad = readRssBytes()
      console.log(`Model loaded in ${loadMs.toFixed(0)}ms (RSS ${bytesToMb(rssAfterLoad, 1)}MB)\n`)

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

      const rtfStats = stats(allResults.map((result) => result.rtf))
      const wallStats = stats(allResults.map((result) => result.wallMs))
      const tpsStats = stats(allResults.map((result) => result.tokensPerSecond))
      const encodeStats = stats(allResults.map((result) => result.whisperEncodeMs))
      const decodeStats = stats(allResults.map((result) => result.whisperDecodeMs))

      const memorySummary = await measureMemory(model, allResults, rssBeforeLoad, rssAfterLoad)
      model = null

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
      console.log('  Memory (RSS, MB):')
      console.log(`    Average:   ${memorySummary.avgRssMb.toFixed(2)}`)
      console.log(`    Peak:      ${memorySummary.peakRssMb.toFixed(2)}`)
      console.log(`    After load:${memorySummary.rssAfterLoadMb.toFixed(2)}`)
      console.log(`    After unload: ${memorySummary.rssAfterUnloadMb.toFixed(2)}`)
      console.log(`    Reclaimed: ${memorySummary.reclaimedMb.toFixed(2)}`)
      if (memorySummary.gpuMemTotalMb >= 0) {
        console.log(
          `    GPU total: ${memorySummary.gpuMemTotalMb}  GPU free: ${memorySummary.gpuMemFreeMb}`
        )
      }
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
          backend: getRequestedBackendFamily(
            platformName,
            benchmarkSettings.useGPU,
            benchmarkSettings.backendHint
          ),
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
          whisperDecodeMs: decodeStats,
          memory: memorySummary
        },
        runs: allResults
      }

      if (!fs.existsSync(RTF_RESULTS_DIR)) {
        fs.mkdirSync(RTF_RESULTS_DIR, { recursive: true })
      }

      const outPath = path.join(RTF_RESULTS_DIR, getArtifactFileName(benchmarkSettings))
      fs.writeFileSync(outPath, JSON.stringify(report, null, 2))
      console.log(`Results written to ${outPath}\n`)
      console.log(
        `${RESULT_MARKER}${JSON.stringify({
          schemaVersion: 1,
          platform,
          platformName,
          arch: archName || '',
          modelFile: benchmarkSettings.modelFile,
          useGPU: benchmarkSettings.useGPU,
          backendHint: getRequestedBackendFamily(
            platformName,
            benchmarkSettings.useGPU,
            benchmarkSettings.backendHint
          ),
          deviceLabel: benchmarkSettings.deviceLabel,
          runnerLabel: benchmarkSettings.runnerLabel,
          summary: report.summary
        })}`
      )

      t.is(
        allResults.length,
        benchmarkSettings.numRuns,
        `Completed ${benchmarkSettings.numRuns} benchmark runs`
      )
      t.ok(rtfStats.mean > 0, 'Mean RTF should be positive')
      if (upperBound !== null) {
        t.ok(
          rtfStats.mean <= upperBound,
          `Mean RTF ${rtfStats.mean.toFixed(4)} should be <= ${upperBound}`
        )
      }
      t.ok(tpsStats.mean > 0, 'Tokens/second should be positive')
      t.ok(memorySummary.peakRssMb > 0, 'Peak memory (RSS) should be positive')
      t.ok(memorySummary.avgRssMb > 0, 'Average memory (RSS) should be positive')
      t.ok(
        memorySummary.peakRssMb >= memorySummary.avgRssMb,
        'Peak memory should be >= average memory'
      )
      t.ok(memorySummary.reclaimedMb >= 0, 'Reclaimed memory should be non-negative')
    } finally {
      if (model) {
        try {
          await model.unload()
        } catch {}
      }
      try {
        loggerBinding.releaseLogger()
      } catch {}
    }
  }
)
