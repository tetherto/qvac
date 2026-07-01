'use strict'

/**
 * BCI throughput benchmark.
 *
 * Captures BCI runtime stats directly from the high-level response object when
 * `opts.stats=true` is enabled, then writes them to JSON so the desktop
 * integration workflow can upload them as artifacts for aggregation across CI
 * runners (scripts/perf-report/aggregate-bci-rtf.js).
 *
 * BCI transcribes neural-signal traces (not audio), so the headline metric is
 * throughput (tokens/sec) + wall time rather than an audio real-time-factor.
 * realTimeFactor is recorded too when the engine reports it, otherwise n/a.
 */

const test = require('brittle')
const fs = require('bare-fs')
const path = require('bare-path')
const os = require('bare-os')
const process = require('bare-process')
const BCIWhispercpp = require('../../index')
const { flattenSegments } = require('@qvac/bci-whispercpp/util')
const {
  detectPlatform,
  getTestPaths,
  getModelPath,
  isMobile
} = require('../integration/helpers.js')

const { label: platformLabel, platform: platformName, arch: archName } = detectPlatform()
const { manifest, getSamplePath } = getTestPaths()

const RTF_RESULTS_DIR = path.resolve(__dirname, '../../benchmarks/results')
const RESULT_MARKER = 'QVAC_BCI_RTF_REPORT::'

function getEnv (name) {
  return os.hasEnv(name) ? os.getEnv(name) : undefined
}

function getEnvBoolean (name, fallback) {
  const value = getEnv(name)
  if (value === undefined) return fallback
  return value === '1' || value === 'true' || value === 'TRUE' || value === 'yes'
}

function getEnvInteger (name, fallback) {
  const value = getEnv(name)
  if (value === undefined) return fallback
  const parsed = Number.parseInt(value, 10)
  return Number.isNaN(parsed) ? fallback : parsed
}

function sanitizeTag (value) {
  if (!value) return ''
  return String(value).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
}

function getBenchmarkSettings () {
  const modelFile = getEnv('QVAC_BCI_BENCHMARK_MODEL_FILE') || 'ggml-bci-windowed.bin'
  return {
    modelFile,
    modelPath: getModelPath(modelFile),
    numWarmup: getEnvInteger('QVAC_BCI_BENCHMARK_WARMUP_RUNS', 1),
    numRuns: getEnvInteger('QVAC_BCI_BENCHMARK_RUNS', isMobile ? 3 : 5),
    useGPU: getEnvBoolean('QVAC_BCI_BENCHMARK_USE_GPU', false),
    threads: getEnvInteger('QVAC_BCI_BENCHMARK_THREADS', 0),
    backendHint: getEnv('QVAC_BCI_BENCHMARK_BACKEND') || '',
    deviceLabel: getEnv('QVAC_BCI_BENCHMARK_DEVICE') || '',
    runnerLabel: getEnv('QVAC_BCI_BENCHMARK_RUNNER') || '',
    label: sanitizeTag(getEnv('QVAC_BCI_BENCHMARK_LABEL') || '')
  }
}

function getRequestedBackendFamily (platform, useGPU, backendHint) {
  if (backendHint) return backendHint
  if (!useGPU) return 'cpu'
  if (platform === 'darwin' || platform === 'ios') return 'metal'
  if (platform === 'win32') return 'vulkan'
  if (platform === 'linux') return 'vulkan'
  if (platform === 'android') return 'vulkan'
  return 'gpu'
}

function getArtifactFileName (s) {
  const parts = ['rtf-benchmark', platformName, sanitizeTag(s.modelFile.replace(/\.bin$/, '')), s.useGPU ? 'gpu' : 'cpu']
  if (s.label) parts.push(s.label)
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
  const clean = values.filter((v) => typeof v === 'number' && Number.isFinite(v))
  if (clean.length === 0) {
    return { mean: null, min: null, max: null, stddev: null, p50: null, p95: null, count: 0 }
  }
  const sorted = [...clean].sort((a, b) => a - b)
  const sum = sorted.reduce((a, b) => a + b, 0)
  const mean = sum / sorted.length
  const variance = sorted.reduce((acc, v) => acc + (v - mean) ** 2, 0) / sorted.length
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

async function runSingleBenchmark (bci, samplePath) {
  const wallStart = getTimeMs()
  const response = await bci.transcribeFile(samplePath)
  const output = await response.await()
  const wallMs = getTimeMs() - wallStart

  const segments = flattenSegments(output)
  const text = segments.map((s) => s.text).join('').trim()
  const jobStats = response.stats || {}

  return {
    wallMs,
    text,
    tokensPerSecond: typeof jobStats.tokensPerSecond === 'number' ? jobStats.tokensPerSecond : null,
    totalTimeSec: typeof jobStats.totalTime === 'number' ? jobStats.totalTime : null,
    totalWallMs: typeof jobStats.totalWallMs === 'number' ? jobStats.totalWallMs : null,
    realTimeFactor: typeof jobStats.realTimeFactor === 'number' ? jobStats.realTimeFactor : null,
    backendDevice: typeof jobStats.backendDevice === 'number' ? jobStats.backendDevice : null,
    backendId: typeof jobStats.backendId === 'number' ? jobStats.backendId : null
  }
}

test('BCI throughput benchmark: collect runtime stats on CI device', { timeout: 600000 }, async (t) => {
  if (isMobile) {
    t.pass('RTF benchmark is only collected on desktop CI runners')
    return
  }

  const s = getBenchmarkSettings()
  const embedderPath = path.join(path.dirname(s.modelPath), 'bci-embedder.bin')

  if (!fs.existsSync(s.modelPath) || !fs.existsSync(embedderPath)) {
    t.pass('RTF benchmark skipped: model/embedder not found at ' + s.modelPath)
    return
  }
  if (!manifest.samples || manifest.samples.length === 0) {
    t.pass('RTF benchmark skipped: no fixtures in manifest')
    return
  }

  const sample = manifest.samples[0]
  const samplePath = getSamplePath(sample.file)
  if (!fs.existsSync(samplePath)) {
    t.pass('RTF benchmark skipped: fixture ' + sample.file + ' not found')
    return
  }

  console.log('\n' + '='.repeat(70))
  console.log('BCI THROUGHPUT BENCHMARK')
  console.log('='.repeat(70))
  console.log(`  Platform:       ${platformLabel}`)
  console.log(`  Model:          ${s.modelPath}`)
  console.log(`  GPU requested:  ${s.useGPU}`)
  if (s.backendHint) console.log(`  Backend hint:   ${s.backendHint}`)
  if (s.deviceLabel) console.log(`  Device label:   ${s.deviceLabel}`)
  console.log(`  Warmup runs:    ${s.numWarmup}`)
  console.log(`  Benchmark runs: ${s.numRuns}`)
  console.log('='.repeat(70) + '\n')

  let bci = null
  try {
    bci = new BCIWhispercpp({
      files: { model: s.modelPath, embedder: embedderPath },
      opts: { stats: true }
    }, {
      whisperConfig: { language: 'en', temperature: 0.0 },
      miscConfig: { caption_enabled: false },
      contextParams: { use_gpu: s.useGPU },
      ...(typeof sample.day_idx === 'number' ? { bciConfig: { day_idx: sample.day_idx } } : {})
    })

    const loadStart = getTimeMs()
    await bci.load()
    console.log(`Model loaded in ${(getTimeMs() - loadStart).toFixed(0)}ms\n`)

    for (let i = 0; i < s.numWarmup; i++) {
      const warmup = await runSingleBenchmark(bci, samplePath)
      console.log(`[warmup ${i + 1}/${s.numWarmup}] wall=${warmup.wallMs.toFixed(0)}ms tokens/s=${warmup.tokensPerSecond ?? 'n/a'}`)
    }

    console.log(`\nRunning ${s.numRuns} benchmark iterations...\n`)
    const allResults = []
    for (let i = 0; i < s.numRuns; i++) {
      const run = await runSingleBenchmark(bci, samplePath)
      allResults.push(run)
      console.log(`  Run ${i + 1}/${s.numRuns}: wall=${run.wallMs.toFixed(0)}ms tokens/s=${run.tokensPerSecond ?? 'n/a'} rtf=${run.realTimeFactor ?? 'n/a'}`)
    }

    const tpsStats = stats(allResults.map((r) => r.tokensPerSecond))
    const wallStats = stats(allResults.map((r) => r.wallMs))
    const rtfStats = stats(allResults.map((r) => r.realTimeFactor))
    const last = allResults[allResults.length - 1]

    const report = {
      timestamp: new Date().toISOString(),
      platform: platformLabel,
      platformName,
      arch: archName || '',
      isMobile,
      model: { name: s.modelFile, path: s.modelPath },
      labels: {
        runner: s.runnerLabel,
        device: s.deviceLabel,
        backend: getRequestedBackendFamily(platformName, s.useGPU, s.backendHint),
        label: s.label
      },
      config: { warmupRuns: s.numWarmup, benchmarkRuns: s.numRuns, useGPU: s.useGPU, threads: s.threads },
      requested: {
        modelFile: s.modelFile,
        useGPU: s.useGPU,
        backendHint: s.backendHint,
        deviceLabel: s.deviceLabel,
        runnerLabel: s.runnerLabel
      },
      observed: { backendDevice: last.backendDevice, backendId: last.backendId },
      summary: {
        tokensPerSecond: tpsStats,
        wallMs: wallStats,
        rtf: rtfStats
      },
      runs: allResults.map((r, i) => ({ iteration: i + 1, wallMs: r.wallMs, tokensPerSecond: r.tokensPerSecond, totalTimeSec: r.totalTimeSec, realTimeFactor: r.realTimeFactor }))
    }

    if (!fs.existsSync(RTF_RESULTS_DIR)) fs.mkdirSync(RTF_RESULTS_DIR, { recursive: true })
    const outPath = path.join(RTF_RESULTS_DIR, getArtifactFileName(s))
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2))
    console.log(`\nResults written to ${outPath}\n`)
    console.log(`${RESULT_MARKER}${JSON.stringify({
      schemaVersion: 1,
      platform: platformLabel,
      platformName,
      modelFile: s.modelFile,
      useGPU: s.useGPU,
      backendHint: getRequestedBackendFamily(platformName, s.useGPU, s.backendHint),
      summary: report.summary
    })}`)

    t.is(allResults.length, s.numRuns, `Completed ${s.numRuns} benchmark runs`)
    t.ok(wallStats.mean > 0, 'Mean wall time should be positive')
  } finally {
    if (bci) {
      try { await bci.destroy() } catch {}
    }
  }
})
