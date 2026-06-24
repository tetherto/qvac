'use strict'

/**
 * Real-Time Factor (RTF) Benchmark for ONNX TTS
 *
 * Captures RTF and related inference performance metrics from the addon's
 * runtimeStats (emitted on JobEnded for Supertonic) or from wall-clock timing
 * combined with produced audio duration (for Chatterbox).
 *
 * RTF = processing_time / audio_duration
 *   < 1.0  → faster than real-time
 *   = 1.0  → exactly real-time
 *   > 1.0  → slower than real-time
 *
 * A single invocation benchmarks ONE (engine, useGPU) combination. The matrix
 * runner (scripts/run-rtf-benchmark-matrix.js) is responsible for iterating
 * over multiple configurations in a single CI job.
 *
 * Inputs are deterministic: fixed sentences, fixed reference audio (jfk.wav),
 * fixed q4 variant, fixed warmup + measured run counts. All of these can be
 * adjusted via environment variables listed below.
 *
 * Environment variables (all optional):
 *   QVAC_ONNX_TTS_BENCHMARK_ENGINE       chatterbox-en | chatterbox-multi | supertonic
 *                                        (default: chatterbox-en)
 *   QVAC_ONNX_TTS_BENCHMARK_VARIANT      fp32 | fp16 | q4 | q4f16   (default: q4)
 *   QVAC_ONNX_TTS_BENCHMARK_USE_GPU      1 | true | 0 | false       (default: false)
 *   QVAC_ONNX_TTS_BENCHMARK_BACKEND      cpu | coreml | cuda | directml | nnapi | rocm
 *                                        (free-form hint; defaults derived from
 *                                         platform + useGPU)
 *   QVAC_ONNX_TTS_BENCHMARK_DEVICE       label for the device/runner used in reports
 *   QVAC_ONNX_TTS_BENCHMARK_RUNNER       label for the CI runner used in reports
 *   QVAC_ONNX_TTS_BENCHMARK_LABEL        free-form tag appended to artifact filenames
 *   QVAC_ONNX_TTS_BENCHMARK_WARMUP_RUNS  number of warmup iterations (default: 1)
 *   QVAC_ONNX_TTS_BENCHMARK_RUNS         number of measured iterations (default: 5 desktop, 3 mobile)
 *   QVAC_ONNX_TTS_BENCHMARK_RTF_UPPER_BOUND  assertion cap for mean RTF (optional)
 */

const test = require('brittle')
const os = require('bare-os')
const path = require('bare-path')
const fs = require('bare-fs')
const process = require('bare-process')
const { loadChatterboxTTS, runChatterboxTTS } = require('../utils/runChatterboxTTS')
const { loadSupertonicTTS, runSupertonicTTS } = require('../utils/runSupertonicTTS')
const { ensureChatterboxModels, ensureSupertonicModels } = require('../utils/downloadModel')

const VALID_ENGINES = ['chatterbox-en', 'chatterbox-multi', 'supertonic']
const VALID_VARIANTS = ['fp32', 'fp16', 'q4', 'q4f16']
// Schema version for the rich on-disk `rtf-benchmark-*.json` artifact
// consumed by `scripts/perf-report/aggregate-onnx-tts-rtf.js`.
const RTF_REPORT_SCHEMA_VERSION = 2
const RTF_RESULTS_DIR = path.resolve(__dirname, '../../benchmarks/results')

// Build a canonical performance-report record that the shared
// scripts/perf-report/extract-from-log.js + aggregate.js + render-step-summary.js
// pipeline understands. Mobile Device Farm logs are scraped for
// [PERF_REPORT_START]<json>[PERF_REPORT_END] markers carrying this shape.
// Schema must satisfy isValidReport() in extract-from-log.js (string
// schema_version + results array).
function buildCanonicalReport (settings, summary, backend) {
  const useGPU = !!settings.useGPU
  const ep = useGPU ? 'gpu' : 'cpu'
  const engine = settings.engine
  const variant = settings.variant
  const testLabel = `[${ep.toUpperCase()}] ${engine} ${variant} ${backend}`

  const rtf = summary.rtf || {}
  const wallMs = summary.wallMs || {}
  const tps = summary.tokensPerSecond || {}

  return {
    schema_version: '1.0',
    addon: 'onnx-tts',
    addon_type: 'onnx-tts',
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
        real_time_factor: typeof rtf.mean === 'number' ? rtf.mean : null,
        rtf_p50: typeof rtf.p50 === 'number' ? rtf.p50 : null,
        rtf_p95: typeof rtf.p95 === 'number' ? rtf.p95 : null,
        wall_time_ms: typeof wallMs.mean === 'number' ? Math.round(wallMs.mean) : null,
        cold_rtf: typeof summary.coldRtf === 'number' ? summary.coldRtf : null,
        model_load_ms: typeof summary.modelLoadMs === 'number' ? Math.round(summary.modelLoadMs) : null,
        tps: typeof tps.mean === 'number' ? tps.mean : null,
        sample_count: typeof rtf.count === 'number' ? rtf.count : null
      }
    }]
  }
}

const platform = os.platform()
const arch = os.arch()
const platformArch = `${platform}-${arch}`
const isMobile = platform === 'ios' || platform === 'android'

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
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function getSettings () {
  const engine = (getEnv('QVAC_ONNX_TTS_BENCHMARK_ENGINE') || 'chatterbox-en').toLowerCase()
  if (!VALID_ENGINES.includes(engine)) {
    throw new Error(`Invalid benchmark engine: ${engine}. Valid: ${VALID_ENGINES.join(', ')}`)
  }

  const variant = (getEnv('QVAC_ONNX_TTS_BENCHMARK_VARIANT') || 'q4').toLowerCase()
  if (!VALID_VARIANTS.includes(variant)) {
    throw new Error(`Invalid benchmark variant: ${variant}. Valid: ${VALID_VARIANTS.join(', ')}`)
  }

  const numThreadsRaw = getEnv('QVAC_ONNX_TTS_BENCHMARK_NUM_THREADS') || ''
  const numThreadsParsed = Number.parseInt(numThreadsRaw, 10)
  const numThreads = Number.isFinite(numThreadsParsed) && numThreadsParsed > 0 ? numThreadsParsed : undefined

  return {
    engine,
    variant,
    useGPU: getEnvBoolean('QVAC_ONNX_TTS_BENCHMARK_USE_GPU', false),
    backendHint: getEnv('QVAC_ONNX_TTS_BENCHMARK_BACKEND') || '',
    deviceLabel: getEnv('QVAC_ONNX_TTS_BENCHMARK_DEVICE') || '',
    runnerLabel: getEnv('QVAC_ONNX_TTS_BENCHMARK_RUNNER') || '',
    label: sanitizeTag(getEnv('QVAC_ONNX_TTS_BENCHMARK_LABEL') || ''),
    numWarmup: getEnvInteger('QVAC_ONNX_TTS_BENCHMARK_WARMUP_RUNS', 1),
    numRuns: getEnvInteger('QVAC_ONNX_TTS_BENCHMARK_RUNS', isMobile ? 3 : 5),
    numThreads,
    requestedUpperBound: getEnv('QVAC_ONNX_TTS_BENCHMARK_RTF_UPPER_BOUND') || '',
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
  if (platformName === 'darwin' || platformName === 'ios') return 'coreml'
  if (platformName === 'android') return 'nnapi'
  if (platformName === 'win32') return 'directml'
  if (platformName === 'linux') return 'cuda'
  return 'gpu'
}

function getArtifactFileName (settings) {
  const parts = [
    'rtf-benchmark',
    platformArch,
    settings.engine,
    settings.variant,
    settings.useGPU ? 'gpu' : 'cpu'
  ]
  if (settings.label) parts.push(settings.label)
  return `${parts.join('-')}.json`
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
  if (values.length === 0) {
    return { mean: 0, min: 0, max: 0, stddev: 0, p50: 0, p95: 0, count: 0 }
  }
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

function getRssBytes () {
  if (process && typeof process.memoryUsage === 'function') {
    try { return process.memoryUsage().rss || 0 } catch (_) { return 0 }
  }
  return 0
}

function collectModelSizeBytes (modelDir) {
  if (!modelDir || !fs.existsSync(modelDir)) return 0
  let total = 0
  const stack = [modelDir]
  while (stack.length > 0) {
    const current = stack.pop()
    let entries = []
    try { entries = fs.readdirSync(current) } catch (_) { continue }
    for (const name of entries) {
      const full = path.join(current, name)
      let stat
      try { stat = fs.statSync(full) } catch (_) { continue }
      if (stat.isDirectory()) {
        stack.push(full)
      } else if (stat.isFile()) {
        total += Number(stat.size) || 0
      }
    }
  }
  return total
}

// Deterministic benchmark corpora (do not depend on HuggingFace/network).
// Mix of short + medium length sentences to exercise both prefill and generate.
const CORPUS_EN = [
  'The quick brown fox jumps over the lazy dog.',
  'How are you doing today?',
  'Artificial intelligence is transforming the world in unprecedented ways.',
  'The weather forecast calls for sunny skies and temperatures around seventy degrees.',
  'In a quiet village nestled between rolling hills, a young inventor dreamed of building machines that could think and learn.'
]

const CORPUS_ES = [
  'Hola mundo. Esta es una prueba del sistema de texto a voz.',
  'El clima de hoy sera soleado con temperaturas agradables.',
  'La inteligencia artificial esta transformando el mundo de maneras sin precedentes.',
  'En un pequeno pueblo entre colinas, un joven inventor sonaba con construir maquinas que pudieran pensar.',
  'Los avances en tecnologia continuan mejorando la calidad de vida de las personas en todo el mundo.'
]

function getCorpus (engine) {
  return engine === 'chatterbox-multi' ? CORPUS_ES : CORPUS_EN
}

function getBaseDir () {
  return isMobile && global.testDir ? global.testDir : '.'
}

function chatterboxPath (modelDir, baseName, isMultilingual, variantSuffix) {
  const suffix = isMultilingual ? '' : variantSuffix
  return path.join(modelDir, `${baseName}${suffix}.onnx`)
}

function chatterboxLmPath (modelDir, variantSuffix) {
  return path.join(modelDir, `language_model${variantSuffix}.onnx`)
}

async function loadModelForEngine (settings) {
  const baseDir = getBaseDir()
  const variantSuffix = settings.variant === 'fp32' ? '' : `_${settings.variant}`
  const threadOpts = settings.numThreads !== undefined ? { numThreads: settings.numThreads } : {}

  if (settings.engine === 'chatterbox-en') {
    const modelDir = path.join(baseDir, 'models', 'chatterbox')
    const downloadResult = await ensureChatterboxModels({ targetDir: modelDir, variant: settings.variant })
    if (!downloadResult.success) throw new Error('Chatterbox English models unavailable')

    const model = await loadChatterboxTTS({
      tokenizerPath: path.join(modelDir, 'tokenizer.json'),
      speechEncoderPath: chatterboxPath(modelDir, 'speech_encoder', false, variantSuffix),
      embedTokensPath: chatterboxPath(modelDir, 'embed_tokens', false, variantSuffix),
      conditionalDecoderPath: chatterboxPath(modelDir, 'conditional_decoder', false, variantSuffix),
      languageModelPath: chatterboxLmPath(modelDir, variantSuffix),
      language: 'en',
      useGPU: settings.useGPU,
      ...threadOpts
    })
    return { model, modelDir }
  }

  if (settings.engine === 'chatterbox-multi') {
    const modelDir = path.join(baseDir, 'models', 'chatterbox-multilingual')
    const downloadResult = await ensureChatterboxModels({ targetDir: modelDir, language: 'multilingual', variant: settings.variant })
    if (!downloadResult.success) throw new Error('Chatterbox multilingual models unavailable')

    const model = await loadChatterboxTTS({
      tokenizerPath: path.join(modelDir, 'tokenizer.json'),
      speechEncoderPath: chatterboxPath(modelDir, 'speech_encoder', true, variantSuffix),
      embedTokensPath: chatterboxPath(modelDir, 'embed_tokens', true, variantSuffix),
      conditionalDecoderPath: chatterboxPath(modelDir, 'conditional_decoder', true, variantSuffix),
      languageModelPath: chatterboxLmPath(modelDir, variantSuffix),
      language: 'es',
      useGPU: settings.useGPU,
      ...threadOpts
    })
    return { model, modelDir }
  }

  const modelDir = path.join(baseDir, 'models', 'supertonic')
  const downloadResult = await ensureSupertonicModels({ targetDir: modelDir })
  if (!downloadResult.success) throw new Error('Supertonic models unavailable')

  const model = await loadSupertonicTTS({
    modelDir,
    voiceName: 'F1',
    language: 'en',
    supertonicMultilingual: false,
    useGPU: settings.useGPU,
    ...threadOpts
  })
  return { model, modelDir }
}

async function runSynthesis (engine, model, text) {
  const runner = engine === 'supertonic' ? runSupertonicTTS : runChatterboxTTS
  return runner(model, { text }, {})
}

function getUpperBound (settings) {
  if (!settings.requestedUpperBound) return null
  const parsed = Number.parseFloat(settings.requestedUpperBound)
  return Number.isNaN(parsed) ? null : parsed
}

test('RTF benchmark: ONNX TTS on CI device', { timeout: 1800000 }, async (t) => {
  const settings = getSettings()
  const backend = resolveBackend(platform, settings.useGPU, settings.backendHint)
  const upperBound = getUpperBound(settings)
  const corpus = getCorpus(settings.engine)

  console.log('\n' + '='.repeat(70))
  console.log('ONNX TTS RTF BENCHMARK')
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
  console.log(`  Corpus:         ${corpus.length} sentence(s)`)
  if (settings.correlation.githubRunId) {
    console.log(`  GitHub run:     ${settings.correlation.githubWorkflow || ''} #${settings.correlation.githubRunId}`)
  }
  console.log('='.repeat(70) + '\n')

  console.log(`Loading model for engine: ${settings.engine}...`)
  const rssBeforeLoad = getRssBytes()
  const loadStart = nowMs()
  let model
  let modelDir = ''
  try {
    const loaded = await loadModelForEngine(settings)
    model = loaded.model
    modelDir = loaded.modelDir
  } catch (err) {
    t.fail(`Model load failed: ${err.message}`)
    return
  }
  const loadMs = nowMs() - loadStart
  const rssAfterLoad = getRssBytes()
  const modelSizeBytes = collectModelSizeBytes(modelDir)
  console.log(`Model loaded in ${loadMs.toFixed(0)}ms (rss +${((rssAfterLoad - rssBeforeLoad) / 1024 / 1024).toFixed(1)}MB, model ${(modelSizeBytes / 1024 / 1024).toFixed(1)}MB on disk)\n`)

  const runs = []
  const warmupRuns = []
  let coldRtf = null
  let coldWallMs = null
  let peakRssBytes = rssAfterLoad

  try {
    // --- Warmup ---
    for (let w = 0; w < settings.numWarmup; w++) {
      console.log(`[warmup ${w + 1}/${settings.numWarmup}]`)
      const text = corpus[w % corpus.length]
      const runStart = nowMs()
      const result = await runSynthesis(settings.engine, model, text)
      const wallMs = nowMs() - runStart
      const stats = result.data && result.data.stats
      const durationMs = (result.data && result.data.durationMs) || 0
      const rtfFromStats = stats && stats.realTimeFactor
      const rtfFromWall = durationMs > 0 ? (wallMs / 1000) / (durationMs / 1000) : 0
      const rtf = (rtfFromStats !== undefined && rtfFromStats !== null && rtfFromStats > 0) ? rtfFromStats : rtfFromWall

      const currentRss = getRssBytes()
      if (currentRss > peakRssBytes) peakRssBytes = currentRss

      warmupRuns.push({ iteration: w + 1, wallMs, rtf, durationMs })
      if (w === 0) {
        coldRtf = rtf
        coldWallMs = wallMs
      }
      console.log(`  warmup wall=${wallMs.toFixed(0)}ms  rtf=${rtf.toFixed(4)}`)
    }

    // --- Measured runs ---
    console.log(`\nRunning ${settings.numRuns} measured iteration(s) over ${corpus.length} sentence(s)...\n`)
    for (let i = 0; i < settings.numRuns; i++) {
      const text = corpus[i % corpus.length]
      const runStart = nowMs()
      const result = await runSynthesis(settings.engine, model, text)
      const wallMs = nowMs() - runStart

      const currentRss = getRssBytes()
      if (currentRss > peakRssBytes) peakRssBytes = currentRss

      if (!result.passed) {
        console.log(`  Run ${i + 1}: FAILED (${result.output})`)
        continue
      }

      const stats = (result.data && result.data.stats) || {}
      const durationMs = result.data ? result.data.durationMs : 0
      const sampleCount = result.data ? result.data.sampleCount : 0
      const rtfFromStats = stats.realTimeFactor
      const rtfFromWall = durationMs > 0 ? (wallMs / 1000) / (durationMs / 1000) : 0
      const rtf = (rtfFromStats !== undefined && rtfFromStats !== null && rtfFromStats > 0) ? rtfFromStats : rtfFromWall

      const run = {
        iteration: i + 1,
        textPreview: text.length > 60 ? text.slice(0, 57) + '...' : text,
        wallMs,
        rtf,
        durationMs,
        sampleCount,
        totalTimeSec: stats.totalTime || wallMs / 1000,
        tokensPerSecond: stats.tokensPerSecond || 0,
        audioDurationMs: stats.audioDurationMs || durationMs,
        totalSamples: stats.totalSamples || sampleCount,
        rssBytes: currentRss
      }
      runs.push(run)

      console.log(`  Run ${i + 1}/${settings.numRuns}: ` +
        `RTF=${rtf.toFixed(4)}  ` +
        `wall=${wallMs.toFixed(0)}ms  ` +
        `audio=${(durationMs / 1000).toFixed(2)}s  ` +
        `tokens/s=${(run.tokensPerSecond || 0).toFixed(1)}  ` +
        `rss=${(currentRss / 1024 / 1024).toFixed(0)}MB`)
    }

    if (runs.length === 0) {
      t.fail('No benchmark runs completed')
      return
    }

    // --- Aggregate stats ---
    const rtfStats = computeStats(runs.map(r => r.rtf))
    const wallStats = computeStats(runs.map(r => r.wallMs))
    const tpsStats = computeStats(runs.map(r => r.tokensPerSecond).filter(v => v > 0))
    const stddevOverMean = rtfStats.mean > 0 ? rtfStats.stddev / rtfStats.mean : 0
    const noisy = stddevOverMean > 0.15

    console.log('\n' + '='.repeat(70))
    console.log('RTF BENCHMARK RESULTS')
    console.log('='.repeat(70))
    console.log(`  Platform:        ${platformArch}`)
    console.log(`  Engine:          ${settings.engine}`)
    console.log(`  Backend:         ${backend}`)
    console.log(`  Iterations:      ${runs.length}`)
    if (settings.numThreads !== undefined) console.log(`  numThreads:      ${settings.numThreads}`)
    console.log('')
    console.log('  Real-Time Factor (RTF):')
    console.log(`    Mean:   ${rtfStats.mean.toFixed(4)}`)
    console.log(`    Min:    ${rtfStats.min.toFixed(4)}`)
    console.log(`    Max:    ${rtfStats.max.toFixed(4)}`)
    console.log(`    Stddev: ${rtfStats.stddev.toFixed(4)} (${(stddevOverMean * 100).toFixed(1)}% of mean${noisy ? ' ⚠ noisy' : ''})`)
    console.log(`    P50:    ${rtfStats.p50.toFixed(4)}`)
    console.log(`    P95:    ${rtfStats.p95.toFixed(4)}`)
    if (coldRtf !== null) {
      console.log(`    Cold:   ${coldRtf.toFixed(4)} (first warmup run)`)
    }
    console.log('')
    console.log('  Wall Time (ms):')
    console.log(`    Mean:   ${wallStats.mean.toFixed(0)}`)
    console.log(`    P50:    ${wallStats.p50.toFixed(0)}`)
    console.log(`    P95:    ${wallStats.p95.toFixed(0)}`)
    console.log(`    Load:   ${loadMs.toFixed(0)} (model)`)
    if (tpsStats.count > 0) {
      console.log('')
      console.log('  Tokens/Second:')
      console.log(`    Mean:   ${tpsStats.mean.toFixed(1)}`)
      console.log(`    P50:    ${tpsStats.p50.toFixed(1)}`)
    }
    console.log('')
    console.log('  Memory / size:')
    console.log(`    Peak RSS:    ${(peakRssBytes / 1024 / 1024).toFixed(0)}MB`)
    console.log(`    RSS @load:   ${(rssAfterLoad / 1024 / 1024).toFixed(0)}MB (pre-load ${(rssBeforeLoad / 1024 / 1024).toFixed(0)}MB)`)
    console.log(`    Model size:  ${(modelSizeBytes / 1024 / 1024).toFixed(1)}MB`)
    console.log('='.repeat(70) + '\n')

    // --- Build report (Omar-compatible shape, extended) ---
    const [platformName, archName] = platformArch.split('-')

    const report = {
      schemaVersion: RTF_REPORT_SCHEMA_VERSION,
      timestamp: new Date().toISOString(),
      platform: platformArch,
      platformName,
      arch: archName || '',
      isMobile,
      engine: settings.engine,
      model: {
        type: settings.engine,
        variant: settings.variant,
        sizeBytes: modelSizeBytes
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
        benchmarkRuns: settings.numRuns,
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
        rtf: rtfStats,
        wallMs: wallStats,
        tokensPerSecond: tpsStats,
        coldRtf,
        coldWallMs,
        modelLoadMs: loadMs,
        peakRssBytes,
        rssBeforeLoadBytes: rssBeforeLoad,
        rssAfterLoadBytes: rssAfterLoad,
        modelSizeBytes,
        stddevOverMean,
        noisy
      },
      runs,
      warmupRuns
    }

    // --- Write JSON artifact ---
    // The flat per-config `rtf-benchmark-*.json` file is the input for the
    // desktop aggregator (`scripts/perf-report/aggregate-onnx-tts-rtf.js`),
    // which expects this exact rich shape. Keep it untouched.
    try {
      if (!fs.existsSync(RTF_RESULTS_DIR)) {
        fs.mkdirSync(RTF_RESULTS_DIR, { recursive: true })
      }
      const outPath = path.join(RTF_RESULTS_DIR, getArtifactFileName(settings))
      fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n')
      console.log(`Results written to ${outPath}\n`)
    } catch (writeErr) {
      console.log(`Warning: could not write results file: ${writeErr.message}`)
    }

    // --- Canonical perf-report markers (mobile pipeline) ---
    // Emit the canonical schema understood by `scripts/perf-report/extract-from-log.js`.
    // The mobile workflow downloads Device Farm logs, scrapes these markers,
    // and feeds them into the shared aggregate.js + render-step-summary.js.
    const canonicalReport = buildCanonicalReport(settings, report.summary, backend)
    const canonicalJson = JSON.stringify(canonicalReport)
    console.log(`[PERF_REPORT_START]${canonicalJson}[PERF_REPORT_END]`)

    // Mobile: emit chunked copy too, because some Device Farm log sinks truncate long lines.
    // extract-from-log.js reassembles `[PERF_CHUNK:id:idx:total]<fragment>` runs.
    if (isMobile) {
      const CHUNK_SIZE = 400
      const chunkCount = Math.max(1, Math.ceil(canonicalJson.length / CHUNK_SIZE))
      const chunkId = `tts-${Date.now()}`
      for (let i = 0; i < chunkCount; i++) {
        const fragment = canonicalJson.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE)
        console.log(`[PERF_CHUNK:${chunkId}:${i}:${chunkCount}]${fragment}`)
      }
    }

    // --- Assertions ---
    t.ok(runs.length === settings.numRuns, `Completed ${settings.numRuns} benchmark runs (got ${runs.length})`)
    t.ok(rtfStats.mean > 0, 'Mean RTF should be positive')

    if (upperBound !== null) {
      t.ok(rtfStats.mean <= upperBound,
        `Mean RTF ${rtfStats.mean.toFixed(4)} should be <= ${upperBound}`)
    }

    console.log('RTF benchmark completed successfully.\n')
  } finally {
    if (model) {
      try { await model.unload() } catch (_) {}
    }
  }
})
