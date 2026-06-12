'use strict'

/**
 * Streaming Latency Benchmark for GGML TTS (tts-cpp)
 *
 * Measures user-perceived streaming metrics — these matter more than end-to-end
 * RTF for interactive/real-time TTS:
 *   - TTFA (Time To First Audio): wall time from `model.run({ streamOutput: true })`
 *     call to the first PCM chunk delivered through `onUpdate`.
 *   - Inter-chunk latency: gap between successive chunks.
 *   - Chunk count + chunk audio duration distribution.
 *
 * Chatterbox emits multiple native chunks (the C++ Engine's chunked S3Gen+HiFT
 * loop, see streamChunkTokens). Supertonic returns a single chunk today, so its
 * TTFA equals total wall time — still a useful first-audio latency number.
 *
 * Uses the same ENV contract as `rtf-benchmark.test.js`, plus
 * `QVAC_TTS_GGML_STREAMING_WARMUP_RUNS` / `QVAC_TTS_GGML_STREAMING_RUNS`.
 * Writes a separate `streaming-benchmark-*.json` artifact that the aggregator
 * (`scripts/perf-report/aggregate-tts-ggml-rtf.js`) picks up alongside the RTF
 * JSON files.
 *
 * Environment variables (all optional):
 *   QVAC_TTS_GGML_BENCHMARK_ENGINE       chatterbox | chatterbox-mtl | supertonic | supertonic-mtl
 *   QVAC_TTS_GGML_BENCHMARK_VARIANT      q4 | q8 | f16 | mixed (default: q4, label only)
 *   QVAC_TTS_GGML_BENCHMARK_USE_GPU      1 | 0 (default 0)
 *   QVAC_TTS_GGML_BENCHMARK_BACKEND      cpu | metal | vulkan | cuda | opencl
 *   QVAC_TTS_GGML_BENCHMARK_DEVICE       device label for reports
 *   QVAC_TTS_GGML_BENCHMARK_RUNNER       CI runner label for reports
 *   QVAC_TTS_GGML_BENCHMARK_LABEL        free-form tag appended to artifact filename
 *   QVAC_TTS_GGML_BENCHMARK_NUM_THREADS  override std::thread::hardware_concurrency()
 *   QVAC_TTS_GGML_STREAMING_WARMUP_RUNS  default 1
 *   QVAC_TTS_GGML_STREAMING_RUNS         default 3 desktop, 2 mobile
 */

const test = require('brittle')
const os = require('bare-os')
const path = require('bare-path')
const fs = require('bare-fs')
const process = require('bare-process')
const { loadChatterboxTTS } = require('../utils/runChatterboxTTS')
const { loadSupertonicTTS } = require('../utils/runSupertonicTTS')
const {
  ensureChatterboxModels,
  ensureChatterboxMtlModels,
  ensureSupertonicModel,
  ensureSupertonicMtlModel
} = require('../utils/downloadModel')

const VALID_ENGINES = ['chatterbox', 'chatterbox-mtl', 'supertonic', 'supertonic-mtl']
const VALID_VARIANTS = ['q4', 'q8', 'f16', 'mixed']
const RESULTS_DIR = path.resolve(__dirname, '../../benchmarks/results')
// Schema version for the rich on-disk `streaming-benchmark-*.json` artifact.
const SCHEMA_VERSION = 1

const platform = os.platform()
const arch = os.arch()
const platformArch = `${platform}-${arch}`
const isMobile = platform === 'ios' || platform === 'android'

// Build a canonical performance-report record for the shared mobile pipeline
// (extract-from-log.js -> aggregate.js). One result per
// (engine, variant, backend, useGPU) configuration. Schema must satisfy
// isValidReport() in extract-from-log.js (string schema_version + results array).
function buildCanonicalStreamingReport (settings, summary, backend) {
  const useGPU = !!settings.useGPU
  const ep = useGPU ? 'gpu' : 'cpu'
  const testLabel = `[${ep.toUpperCase()}] streaming ${settings.engine} ${settings.variant} ${backend}`

  const ttfa = summary.ttfaMs || {}
  const totalWall = summary.totalWallMs || {}
  const interChunk = summary.interChunkMs || {}
  const chunkCount = summary.chunkCount || {}

  return {
    schema_version: '1.0',
    addon: 'tts-ggml',
    addon_type: 'tts-ggml',
    timestamp: new Date().toISOString(),
    device: {
      name: settings.deviceLabel || platformArch,
      platform,
      os_version: '',
      arch,
      runner: settings.runnerLabel || (isMobile ? 'device-farm' : 'github-actions')
    },
    results: [{
      test: testLabel,
      execution_provider: ep,
      metrics: {
        ttfa_ms: typeof ttfa.mean === 'number' ? Math.round(ttfa.mean) : null,
        inter_chunk_p95_ms: typeof interChunk.p95 === 'number' ? Math.round(interChunk.p95) : null,
        wall_time_ms: typeof totalWall.mean === 'number' ? Math.round(totalWall.mean) : null,
        // Consumed by aggregate-tts-ggml-rtf.js expandCanonicalReport ->
        // chunkCount.mean (the "Chunks/run" column for mobile streaming rows).
        chunks_per_run_mean: typeof chunkCount.mean === 'number' ? Number(chunkCount.mean.toFixed(2)) : null
      }
    }]
  }
}

function getEnv (name) {
  if (typeof os.getEnv === 'function') {
    try { return os.getEnv(name) || '' } catch (_) { return '' }
  }
  return (process.env && process.env[name]) || ''
}

function getEnvBoolean (name, fallback) {
  const value = getEnv(name)
  if (value === undefined || value === '') return fallback
  return value === '1' || value.toLowerCase() === 'true' || value.toLowerCase() === 'yes'
}

function getEnvInteger (name, fallback) {
  const value = getEnv(name)
  if (value === undefined || value === '') return fallback
  const parsed = Number.parseInt(value, 10)
  return Number.isNaN(parsed) ? fallback : parsed
}

function sanitizeTag (value) {
  if (!value) return ''
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

function nowMs () {
  const [sec, nsec] = process.hrtime()
  return sec * 1000 + nsec / 1e6
}

function percentile (sorted, p) {
  if (sorted.length === 0) return 0
  const idx = (p / 100) * (sorted.length - 1)
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return sorted[lo]
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo)
}

function computeStats (values) {
  if (values.length === 0) return { mean: 0, min: 0, max: 0, stddev: 0, p50: 0, p95: 0, count: 0 }
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

function getSettings () {
  const engine = (getEnv('QVAC_TTS_GGML_BENCHMARK_ENGINE') || 'chatterbox').toLowerCase()
  if (!VALID_ENGINES.includes(engine)) {
    throw new Error(`Invalid benchmark engine: ${engine}. Valid: ${VALID_ENGINES.join(', ')}`)
  }
  const variant = (getEnv('QVAC_TTS_GGML_BENCHMARK_VARIANT') || 'q4').toLowerCase()
  if (!VALID_VARIANTS.includes(variant)) {
    throw new Error(`Invalid benchmark variant: ${variant}. Valid: ${VALID_VARIANTS.join(', ')}`)
  }

  const numThreadsRaw = getEnv('QVAC_TTS_GGML_BENCHMARK_NUM_THREADS') || ''
  const numThreadsParsed = Number.parseInt(numThreadsRaw, 10)
  const numThreads = Number.isFinite(numThreadsParsed) && numThreadsParsed > 0 ? numThreadsParsed : undefined

  return {
    engine,
    variant,
    useGPU: getEnvBoolean('QVAC_TTS_GGML_BENCHMARK_USE_GPU', false),
    backendHint: getEnv('QVAC_TTS_GGML_BENCHMARK_BACKEND') || '',
    deviceLabel: getEnv('QVAC_TTS_GGML_BENCHMARK_DEVICE') || '',
    runnerLabel: getEnv('QVAC_TTS_GGML_BENCHMARK_RUNNER') || '',
    label: sanitizeTag(getEnv('QVAC_TTS_GGML_BENCHMARK_LABEL') || ''),
    numThreads,
    numWarmup: getEnvInteger('QVAC_TTS_GGML_STREAMING_WARMUP_RUNS', 1),
    numRuns: getEnvInteger('QVAC_TTS_GGML_STREAMING_RUNS', isMobile ? 2 : 3),
    correlation: {
      githubRunId: getEnv('GITHUB_RUN_ID') || '',
      githubRunAttempt: getEnv('GITHUB_RUN_ATTEMPT') || '',
      githubSha: getEnv('GITHUB_SHA') || '',
      githubRefName: getEnv('GITHUB_REF_NAME') || '',
      githubActor: getEnv('GITHUB_ACTOR') || '',
      githubWorkflow: getEnv('GITHUB_WORKFLOW') || '',
      githubJob: getEnv('GITHUB_JOB') || ''
    }
  }
}

function resolveBackend (platformName, useGPU, backendHint) {
  const hint = String(backendHint || '').toLowerCase()
  if (hint) return hint
  if (!useGPU) return 'cpu'
  if (platformName === 'darwin' || platformName === 'ios') return 'metal'
  if (platformName === 'android') return 'vulkan'
  if (platformName === 'linux' || platformName === 'win32') return 'vulkan'
  return 'gpu'
}

function getArtifactFileName (settings) {
  const parts = [
    'streaming-benchmark',
    platformArch,
    settings.engine,
    settings.variant,
    settings.useGPU ? 'gpu' : 'cpu'
  ]
  if (settings.label) parts.push(settings.label)
  return `${parts.join('-')}.json`
}

function getBaseDir () {
  return isMobile && global.testDir ? global.testDir : '.'
}

function isMultilingualEngine (engine) {
  return engine === 'chatterbox-mtl' || engine === 'supertonic-mtl'
}

async function loadModelForEngine (settings) {
  const baseDir = getBaseDir()
  const modelsDir = path.join(baseDir, 'models')
  const threadOpts = settings.numThreads !== undefined ? { threads: settings.numThreads } : {}

  if (settings.engine === 'chatterbox') {
    const download = await ensureChatterboxModels({ targetDir: modelsDir })
    if (!download.success) throw new Error('Chatterbox GGUFs unavailable (registry fetch failed)')
    return loadChatterboxTTS({
      modelDir: download.targetDir || modelsDir,
      language: 'en',
      useGPU: settings.useGPU,
      ...threadOpts
    })
  }

  if (settings.engine === 'chatterbox-mtl') {
    const download = await ensureChatterboxMtlModels({ targetDir: modelsDir })
    if (!download.success) throw new Error('Chatterbox MTL GGUFs unavailable (registry fetch failed)')
    const dir = download.targetDir || modelsDir
    return loadChatterboxTTS({
      modelDir: dir,
      t3ModelPath: path.join(dir, 'chatterbox-t3-mtl.gguf'),
      s3genModelPath: path.join(dir, 'chatterbox-s3gen-mtl.gguf'),
      language: 'es',
      useGPU: settings.useGPU,
      ...threadOpts
    })
  }

  if (settings.engine === 'supertonic-mtl') {
    const download = await ensureSupertonicMtlModel({ targetDir: modelsDir })
    if (!download || !download.success) throw new Error('Supertonic MTL GGUF unavailable (registry fetch failed)')
    return loadSupertonicTTS({
      supertonicModelPath: download.path || path.join(download.targetDir || modelsDir, 'supertonic2.gguf'),
      voice: 'F1',
      language: 'es',
      useGPU: settings.useGPU,
      ...threadOpts
    })
  }

  const download = await ensureSupertonicModel({ targetDir: modelsDir })
  if (!download || !download.success) throw new Error('Supertonic GGUF unavailable (registry fetch failed)')
  return loadSupertonicTTS({
    supertonicModelPath: download.path || path.join(download.targetDir || modelsDir, 'supertonic.gguf'),
    voice: 'F1',
    language: 'en',
    useGPU: settings.useGPU,
    ...threadOpts
  })
}

// Text long enough that Chatterbox native chunking produces >=2 chunks.
const STREAMING_CORPUS = {
  en: 'The quick brown fox jumps over the lazy dog. ' +
      'Artificial intelligence is transforming the world in unprecedented ways. ' +
      'The weather forecast calls for sunny skies and temperatures around seventy degrees. ' +
      'In a quiet village nestled between rolling hills, a young inventor dreamed of building machines that could think and learn.',
  es: 'Hola mundo. Esta es una prueba del sistema de texto a voz. ' +
      'El clima de hoy sera soleado con temperaturas agradables. ' +
      'La inteligencia artificial esta transformando el mundo de maneras sin precedentes. ' +
      'En un pequeno pueblo entre colinas, un joven inventor sonaba con construir maquinas que pudieran pensar.'
}

function getCorpusText (engine) {
  return isMultilingualEngine(engine) ? STREAMING_CORPUS.es : STREAMING_CORPUS.en
}

async function measureStreamingRun (model, text) {
  const startMs = nowMs()
  let firstChunkAtMs = null
  const chunkTimes = []
  let chunkCount = 0
  let totalSampleCount = 0

  const response = await model.run({ input: text, type: 'text', streamOutput: true })

  await response
    .onUpdate(data => {
      if (data && data.outputArray) {
        const now = nowMs()
        if (firstChunkAtMs === null) firstChunkAtMs = now
        chunkTimes.push(now)
        chunkCount++
        totalSampleCount += data.outputArray.length
      }
    })
    .await()

  const endMs = nowMs()
  const stats = response.stats || {}

  const ttfaMs = firstChunkAtMs !== null ? firstChunkAtMs - startMs : null
  const interChunkGapsMs = []
  for (let i = 1; i < chunkTimes.length; i++) {
    interChunkGapsMs.push(chunkTimes[i] - chunkTimes[i - 1])
  }
  const totalWallMs = endMs - startMs

  return {
    ttfaMs,
    totalWallMs,
    chunkCount,
    interChunkGapsMs,
    totalSampleCount,
    audioDurationMs: stats.audioDurationMs || 0,
    backendId: typeof stats.backendId === 'number' ? stats.backendId : null,
    streamDurationMs: firstChunkAtMs !== null ? endMs - firstChunkAtMs : 0
  }
}

test('Streaming benchmark: TTFA + inter-chunk latency (GGML TTS)', { timeout: 1800000 }, async (t) => {
  const settings = getSettings()
  const backend = resolveBackend(platform, settings.useGPU, settings.backendHint)
  const text = getCorpusText(settings.engine)

  console.log('\n' + '='.repeat(70))
  console.log('GGML TTS STREAMING LATENCY BENCHMARK')
  console.log('='.repeat(70))
  console.log(`  Platform:       ${platformArch}`)
  console.log(`  Engine:         ${settings.engine}`)
  console.log(`  Variant:        ${settings.variant}`)
  console.log(`  GPU requested:  ${settings.useGPU}`)
  console.log(`  Backend:        ${backend}`)
  if (settings.deviceLabel) console.log(`  Device label:   ${settings.deviceLabel}`)
  if (settings.runnerLabel) console.log(`  Runner label:   ${settings.runnerLabel}`)
  if (settings.label) console.log(`  Label:          ${settings.label}`)
  if (settings.numThreads !== undefined) console.log(`  numThreads:     ${settings.numThreads}`)
  console.log(`  Warmup runs:    ${settings.numWarmup}`)
  console.log(`  Measured runs:  ${settings.numRuns}`)
  console.log(`  Corpus chars:   ${text.length}`)
  console.log('='.repeat(70) + '\n')

  console.log(`Loading model for engine: ${settings.engine}...`)
  const loadStart = nowMs()
  let model
  try {
    model = await loadModelForEngine(settings)
  } catch (err) {
    t.fail(`Model load failed: ${err.message}`)
    return
  }
  const loadMs = nowMs() - loadStart
  console.log(`Model loaded in ${loadMs.toFixed(0)}ms\n`)

  const runs = []
  let observedBackendId = null

  try {
    for (let w = 0; w < settings.numWarmup; w++) {
      console.log(`[streaming warmup ${w + 1}/${settings.numWarmup}]`)
      const r = await measureStreamingRun(model, text)
      if (r.backendId !== null) observedBackendId = r.backendId
      console.log(`  ttfa=${r.ttfaMs !== null ? r.ttfaMs.toFixed(0) + 'ms' : 'n/a'}  ` +
        `chunks=${r.chunkCount}  totalWall=${r.totalWallMs.toFixed(0)}ms`)
    }

    console.log(`\nRunning ${settings.numRuns} measured streaming iteration(s)...\n`)
    for (let i = 0; i < settings.numRuns; i++) {
      const r = await measureStreamingRun(model, text)
      if (r.backendId !== null) observedBackendId = r.backendId
      runs.push({ iteration: i + 1, ...r })

      const interChunkMean = r.interChunkGapsMs.length > 0
        ? r.interChunkGapsMs.reduce((a, b) => a + b, 0) / r.interChunkGapsMs.length
        : 0
      console.log(`  Run ${i + 1}/${settings.numRuns}: ` +
        `ttfa=${r.ttfaMs !== null ? r.ttfaMs.toFixed(0) + 'ms' : 'n/a'}  ` +
        `chunks=${r.chunkCount}  ` +
        `interChunkMean=${interChunkMean.toFixed(0)}ms  ` +
        `totalWall=${r.totalWallMs.toFixed(0)}ms  ` +
        `audio=${(r.audioDurationMs / 1000).toFixed(2)}s`)
    }

    if (runs.length === 0) {
      t.fail('No streaming benchmark runs completed')
      return
    }

    const ttfaStats = computeStats(runs.map(r => r.ttfaMs).filter(v => v !== null && v !== undefined))
    const totalWallStats = computeStats(runs.map(r => r.totalWallMs))
    const chunkCountStats = computeStats(runs.map(r => r.chunkCount))
    const interChunkAll = runs.flatMap(r => r.interChunkGapsMs)
    const interChunkStats = computeStats(interChunkAll)

    console.log('\n' + '='.repeat(70))
    console.log('STREAMING BENCHMARK RESULTS')
    console.log('='.repeat(70))
    console.log('  TTFA (Time To First Audio):')
    console.log(`    Mean:   ${ttfaStats.mean.toFixed(0)}ms`)
    console.log(`    P50:    ${ttfaStats.p50.toFixed(0)}ms`)
    console.log(`    P95:    ${ttfaStats.p95.toFixed(0)}ms`)
    console.log(`  Inter-chunk gap (${interChunkAll.length} samples across runs):`)
    console.log(`    Mean:   ${interChunkStats.mean.toFixed(0)}ms`)
    console.log(`    P95:    ${interChunkStats.p95.toFixed(0)}ms`)
    console.log(`  Chunks per run: ${chunkCountStats.mean.toFixed(1)} (min ${chunkCountStats.min}, max ${chunkCountStats.max})`)
    console.log(`  Total wall:     ${totalWallStats.mean.toFixed(0)}ms`)
    console.log('='.repeat(70) + '\n')

    const [platformName, archName] = platformArch.split('-')

    const report = {
      schemaVersion: SCHEMA_VERSION,
      kind: 'streaming',
      timestamp: new Date().toISOString(),
      platform: platformArch,
      platformName,
      arch: archName || '',
      isMobile,
      engine: settings.engine,
      model: {
        type: settings.engine,
        variant: settings.variant
      },
      labels: {
        runner: settings.runnerLabel,
        device: settings.deviceLabel,
        backend,
        requestedBackend: settings.useGPU ? 'gpu' : 'cpu',
        label: settings.label
      },
      config: {
        warmupRuns: settings.numWarmup,
        measuredRuns: settings.numRuns,
        useGPU: settings.useGPU,
        variant: settings.variant,
        modelLoadMs: loadMs,
        numThreads: settings.numThreads !== undefined ? settings.numThreads : null
      },
      requested: {
        engine: settings.engine,
        variant: settings.variant,
        useGPU: settings.useGPU,
        backendHint: settings.backendHint,
        deviceLabel: settings.deviceLabel,
        runnerLabel: settings.runnerLabel,
        numThreads: settings.numThreads !== undefined ? settings.numThreads : null
      },
      correlation: settings.correlation,
      summary: {
        ttfaMs: ttfaStats,
        totalWallMs: totalWallStats,
        chunkCount: chunkCountStats,
        interChunkMs: interChunkStats,
        backendId: observedBackendId
      },
      runs
    }

    // Keep the rich on-disk artifact unchanged — this is what
    // `scripts/perf-report/aggregate-tts-ggml-rtf.js` consumes alongside RTF
    // benchmark JSON files.
    try {
      if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true })
      const outPath = path.join(RESULTS_DIR, getArtifactFileName(settings))
      fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n')
      console.log(`Results written to ${outPath}\n`)
    } catch (writeErr) {
      console.log(`Warning: could not write results file: ${writeErr.message}`)
    }

    // Canonical perf-report markers for the shared mobile pipeline.
    const canonicalReport = buildCanonicalStreamingReport(settings, report.summary, backend)
    const canonicalJson = JSON.stringify(canonicalReport)
    console.log(`[PERF_REPORT_START]${canonicalJson}[PERF_REPORT_END]`)

    if (isMobile) {
      const CHUNK_SIZE = 400
      const chunkCount = Math.max(1, Math.ceil(canonicalJson.length / CHUNK_SIZE))
      const chunkId = `ttsggmlstream-${Date.now()}`
      for (let i = 0; i < chunkCount; i++) {
        const fragment = canonicalJson.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE)
        console.log(`[PERF_CHUNK:${chunkId}:${i}:${chunkCount}]${fragment}`)
      }
    }

    t.ok(runs.length === settings.numRuns, `Completed ${settings.numRuns} streaming runs (got ${runs.length})`)
    t.ok(ttfaStats.count > 0 && ttfaStats.mean > 0, 'Mean TTFA should be positive')
    t.ok(chunkCountStats.min >= 1, 'At least one chunk should be produced per run')

    console.log('Streaming benchmark completed successfully.\n')
  } finally {
    if (model) {
      try { await model.unload() } catch (_) {}
    }
  }
})
