'use strict'

const os = require('bare-os')
const path = require('bare-path')
const fs = require('bare-fs')
const { ditVariants, DEFAULT_DIT_VARIANT } = require('../../models.js')
const { ensureAudiogenModels, expectedModelFiles, getBaseDir } = require('./downloadModel')
const { loadAudioGen, runAudioGen } = require('./runAudioGen')
const {
  computeStats,
  stddevOverMean,
  isNoisy,
  resolveRealTimeFactor
} = require('./benchmark-stats')
const {
  RTF_REPORT_SCHEMA_VERSION,
  backendIdToName,
  resolveBackend,
  sanitizeTag,
  buildArtifactFileName,
  buildCanonicalReport
} = require('./benchmark-report')
const {
  readRssBytes,
  createMemorySampler,
  summarizeRunMemory,
  measureUnload,
  bytesToMb,
  RECLAIM_SETTLE_MS
} = require('./memory-usage')
const {
  assertBenchmarkResult,
  evaluateBenchmarkResult,
  BenchmarkResultError
} = require('./benchmark-validate')
const { applyDeviceEnv } = require('./device-env')

const ENV_PREFIX = 'QVAC_AUDIOGEN_GGML_BENCHMARK'
const ARTIFACT_PREFIX = 'rtf-benchmark'
const DEVICE_ENV_FILE = 'qvacPerfConfig.txt'

const DEFAULT_DURATION_S = 15
const DEFAULT_WARMUP_RUNS = 1
const DEFAULT_DESKTOP_RUNS = 3
const DEFAULT_MOBILE_RUNS = 2

const BENCHMARK_SEED = 42
const INSTRUMENTAL_LYRICS = '[Instrumental]'

const PERF_CHUNK_SIZE = 400

const CAPTIONS = [
  'lo-fi hip hop, mellow piano, soft vinyl crackle, rainy night',
  'upbeat pop rock, driving electric guitars, punchy drums, catchy hook',
  'ambient synth pad, slow evolving texture, deep sub bass, cinematic'
]

const platform = os.platform()
const arch = os.arch()
const platformArch = `${platform}-${arch}`
const isMobile = platform === 'ios' || platform === 'android'

const DEVICE_INFO = { platform, arch, platformArch, isMobile }

function envKey(suffix) {
  return `${ENV_PREFIX}_${suffix}`
}

function getEnv(name) {
  if (typeof os.getEnv !== 'function') return ''
  try {
    return os.getEnv(name) || ''
  } catch {
    return ''
  }
}

function getEnvBoolean(name, fallback) {
  const value = getEnv(name)
  if (!value) return fallback
  const normalized = value.toLowerCase()
  return normalized === '1' || normalized === 'true' || normalized === 'yes'
}

function getEnvInteger(name, fallback) {
  const parsed = Number.parseInt(getEnv(name), 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

function getEnvFloat(name, fallback) {
  const parsed = Number.parseFloat(getEnv(name))
  return Number.isFinite(parsed) ? parsed : fallback
}

function getOptionalPositiveInteger(name) {
  const parsed = Number.parseInt(getEnv(name), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

function getOptionalFloat(name) {
  const parsed = Number.parseFloat(getEnv(name))
  return Number.isFinite(parsed) ? parsed : undefined
}

function getOptionalBound(name) {
  const parsed = Number.parseFloat(getEnv(name))
  return Number.isFinite(parsed) ? parsed : null
}

function readDitVariant() {
  const variant = (getEnv(envKey('DIT_VARIANT')) || DEFAULT_DIT_VARIANT).toLowerCase()
  const valid = ditVariants()
  if (!valid.includes(variant)) {
    throw new Error(`Invalid ditVariant: ${variant}. Valid: ${valid.join(', ')}`)
  }
  return variant
}

function readCorrelation() {
  return {
    githubRunId: getEnv('GITHUB_RUN_ID'),
    githubRunAttempt: getEnv('GITHUB_RUN_ATTEMPT'),
    githubSha: getEnv('GITHUB_SHA'),
    githubRefName: getEnv('GITHUB_REF_NAME'),
    githubActor: getEnv('GITHUB_ACTOR'),
    githubWorkflow: getEnv('GITHUB_WORKFLOW'),
    githubJob: getEnv('GITHUB_JOB')
  }
}

function setEnv(key, value) {
  try {
    os.setEnv(key, value)
  } catch (err) {
    console.log(`[device-env] setEnv failed for ${key}: ${err.message}`)
  }
}

function loadDeviceEnvFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return false
    const injected = applyDeviceEnv(fs.readFileSync(filePath, 'utf-8'), setEnv)
    console.log(`[device-env] loaded ${injected} override(s) from ${filePath}`)
    return injected > 0
  } catch (err) {
    console.log(`[device-env] read error at ${filePath}: ${err.message}`)
    return false
  }
}

function deviceEnvCandidates() {
  const candidates = []
  if (global.testDir) candidates.push(path.join(global.testDir, DEVICE_ENV_FILE))
  if (platform === 'android') candidates.push(`/data/local/tmp/${DEVICE_ENV_FILE}`)
  return candidates
}

let deviceEnvLoaded = false

function loadDeviceEnvOnce() {
  if (deviceEnvLoaded) return
  deviceEnvLoaded = true
  for (const candidate of deviceEnvCandidates()) {
    if (loadDeviceEnvFile(candidate)) return
  }
}

function readBenchmarkSettings() {
  loadDeviceEnvOnce()
  return {
    ditVariant: readDitVariant(),
    useGPU: getEnvBoolean(envKey('USE_GPU'), false),
    backendHint: getEnv(envKey('BACKEND')),
    deviceLabel: getEnv(envKey('DEVICE')),
    runnerLabel: getEnv(envKey('RUNNER')),
    label: sanitizeTag(getEnv(envKey('LABEL'))),
    numWarmup: getEnvInteger(envKey('WARMUP_RUNS'), DEFAULT_WARMUP_RUNS),
    numRuns: getEnvInteger(envKey('RUNS'), isMobile ? DEFAULT_MOBILE_RUNS : DEFAULT_DESKTOP_RUNS),
    durationS: getEnvFloat(envKey('DURATION_S'), DEFAULT_DURATION_S),
    inferenceSteps: getOptionalPositiveInteger(envKey('INFERENCE_STEPS')),
    shift: getOptionalFloat(envKey('SHIFT')),
    numThreads: getOptionalPositiveInteger(envKey('NUM_THREADS')),
    rtfUpperBound: getOptionalBound(envKey('RTF_UPPER_BOUND')),
    correlation: readCorrelation()
  }
}

function modelsDir() {
  return path.join(getBaseDir(), 'models')
}

function resultsDir() {
  return path.join(getBaseDir(), 'benchmarks', 'results')
}

function collectFilesSizeBytes(files) {
  let total = 0
  for (const file of files) {
    try {
      const stat = fs.statSync(file)
      if (stat.isFile()) total += Number(stat.size) || 0
    } catch {}
  }
  return total
}

function modelSizeBytesFor(variant, dir) {
  return collectFilesSizeBytes(expectedModelFiles(variant).map((name) => path.join(dir, name)))
}

function loadEngine(settings, modelDir) {
  const options = { modelDir, ditVariant: settings.ditVariant, useGPU: settings.useGPU }
  if (settings.inferenceSteps !== undefined) options.inferenceSteps = settings.inferenceSteps
  if (settings.shift !== undefined) options.shift = settings.shift
  if (settings.numThreads !== undefined) options.threads = settings.numThreads
  return loadAudioGen(options)
}

function generateOptions(settings) {
  return { lyrics: INSTRUMENTAL_LYRICS, duration: settings.durationS, seed: BENCHMARK_SEED }
}

function captionFor(iteration) {
  return CAPTIONS[iteration % CAPTIONS.length]
}

async function generateOnce(gen, settings, iteration) {
  const sampler = createMemorySampler()
  const startedAt = Date.now()
  sampler.start()
  const { data } = await runAudioGen(gen, {
    caption: captionFor(iteration),
    opts: generateOptions(settings)
  })
  const memory = sampler.stop()
  const wallMs = Date.now() - startedAt

  const stats = data.stats || {}
  const audioDurationMs = stats.audioDurationMs || data.durationMs || 0
  return {
    wallMs,
    audioDurationMs,
    rtf: resolveRealTimeFactor({ statsRtf: stats.realTimeFactor, wallMs, audioDurationMs }),
    totalTimeMs: stats.totalTimeMs || wallMs,
    sampleCount: data.sampleCount,
    sampleRate: data.sampleRate,
    channels: data.channels,
    peak: data.peak,
    rms: data.rms,
    backendId: typeof stats.backendId === 'number' ? stats.backendId : null,
    backendDevice: typeof stats.backendDevice === 'number' ? stats.backendDevice : null,
    avgRssBytes: memory.avgBytes,
    peakRssBytes: memory.peakBytes,
    rssSampleCount: memory.count
  }
}

async function runWarmups(gen, settings) {
  const warmups = []
  for (let i = 0; i < settings.numWarmup; i++) {
    const run = await generateOnce(gen, settings, i)
    warmups.push({ iteration: i + 1, ...run })
    console.log(
      `  warmup ${i + 1}/${settings.numWarmup}: rtf=${run.rtf.toFixed(4)} wall=${run.wallMs}ms`
    )
  }
  return warmups
}

async function runMeasured(gen, settings) {
  const runs = []
  for (let i = 0; i < settings.numRuns; i++) {
    const run = await generateOnce(gen, settings, i)
    runs.push({ iteration: i + 1, caption: captionFor(i), ...run })
    console.log(
      `  run ${i + 1}/${settings.numRuns}: ` +
        `rtf=${run.rtf.toFixed(4)} ` +
        `wall=${run.wallMs}ms ` +
        `audio=${(run.audioDurationMs / 1000).toFixed(2)}s ` +
        `rss avg=${bytesToMb(run.avgRssBytes, 0)}MB peak=${bytesToMb(run.peakRssBytes, 0)}MB`
    )
  }
  return runs
}

async function settledRssBytes() {
  await new Promise((resolve) => setTimeout(resolve, RECLAIM_SETTLE_MS))
  return readRssBytes()
}

async function reclaimAfterUnload(gen) {
  const unload = await measureUnload(() => gen.destroy(), settledRssBytes)
  if (!unload.unloaded) {
    console.log(
      `Warning: engine unload failed, reclaimed memory unavailable: ${unload.error.message}`
    )
  }
  return unload
}

function lastObservedBackendId(runs) {
  for (let i = runs.length - 1; i >= 0; i--) {
    if (typeof runs[i].backendId === 'number') return runs[i].backendId
  }
  return null
}

function buildSummary({ runs, memorySummary, coldRun, modelLoadMs, modelSizeBytes }) {
  const rtf = computeStats(runs.map((run) => run.rtf))
  const backendId = lastObservedBackendId(runs)
  return {
    rtf,
    wallMs: computeStats(runs.map((run) => run.wallMs)),
    audioDurationMs: computeStats(runs.map((run) => run.audioDurationMs)),
    coldRtf: coldRun ? coldRun.rtf : null,
    coldWallMs: coldRun ? coldRun.wallMs : null,
    modelLoadMs,
    modelSizeBytes,
    memory: memorySummary,
    backendId,
    activeBackend: backendId === null ? '' : backendIdToName(backendId),
    stddevOverMean: stddevOverMean(rtf),
    noisy: isNoisy(rtf)
  }
}

function buildReport({ settings, backend, summary, runs, warmupRuns }) {
  return {
    schemaVersion: RTF_REPORT_SCHEMA_VERSION,
    timestamp: new Date().toISOString(),
    platform: platformArch,
    platformName: platform,
    arch,
    isMobile,
    engine: 'acestep',
    model: {
      type: 'acestep',
      ditVariant: settings.ditVariant,
      sizeBytes: summary.modelSizeBytes
    },
    labels: {
      runner: settings.runnerLabel,
      device: settings.deviceLabel,
      backend,
      activeBackend: summary.activeBackend,
      requestedBackend: settings.useGPU ? 'gpu' : 'cpu',
      label: settings.label
    },
    config: {
      warmupRuns: settings.numWarmup,
      benchmarkRuns: settings.numRuns,
      useGPU: settings.useGPU,
      ditVariant: settings.ditVariant,
      durationS: settings.durationS,
      inferenceSteps: settings.inferenceSteps ?? null,
      shift: settings.shift ?? null,
      numThreads: settings.numThreads ?? null,
      seed: BENCHMARK_SEED,
      modelLoadMs: summary.modelLoadMs
    },
    correlation: settings.correlation,
    summary,
    runs,
    warmupRuns
  }
}

function writeRtfArtifact(settings, report) {
  const dir = resultsDir()
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const outPath = path.join(dir, buildArtifactFileName(ARTIFACT_PREFIX, platformArch, settings))
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n')
    console.log(`Results written to ${outPath}`)
    return outPath
  } catch (err) {
    console.log(`Warning: could not write results file: ${err.message}`)
    return null
  }
}

function emitPerfChunks(json) {
  const chunkCount = Math.max(1, Math.ceil(json.length / PERF_CHUNK_SIZE))
  const chunkId = `audiogenggml-${Date.now()}`
  for (let i = 0; i < chunkCount; i++) {
    const fragment = json.slice(i * PERF_CHUNK_SIZE, (i + 1) * PERF_CHUNK_SIZE)
    console.log(`[PERF_CHUNK:${chunkId}:${i}:${chunkCount}]${fragment}`)
  }
}

function emitCanonicalReport(settings, summary, backend) {
  const canonical = buildCanonicalReport({ settings, summary, backend, device: DEVICE_INFO })
  const json = JSON.stringify(canonical)
  console.log(`[PERF_REPORT_START]${json}[PERF_REPORT_END]`)
  if (isMobile) emitPerfChunks(json)
  return canonical
}

function logHeader(settings, backend) {
  console.log(`\nACE-STEP RTF BENCHMARK (${platformArch})`)
  console.log(`  DiT variant:   ${settings.ditVariant}`)
  console.log(`  GPU requested: ${settings.useGPU}`)
  console.log(`  Backend:       ${backend}`)
  console.log(`  Clip duration: ${settings.durationS}s`)
  console.log(`  Warmup runs:   ${settings.numWarmup}`)
  console.log(`  Measured runs: ${settings.numRuns}`)
  if (settings.label) console.log(`  Label:         ${settings.label}`)
  console.log('')
}

function logSummary(summary, backend) {
  const { rtf, wallMs, memory } = summary
  console.log('\nACE-STEP RTF BENCHMARK RESULTS')
  const fellBack = summary.activeBackend && summary.activeBackend !== backend
  console.log(`  Backend:     ${backend}${fellBack ? ` (active: ${summary.activeBackend})` : ''}`)
  console.log(
    `  RTF mean:    ${rtf.mean.toFixed(4)} (p50 ${rtf.p50.toFixed(4)}, p95 ${rtf.p95.toFixed(4)})`
  )
  console.log(
    `  RTF stddev:  ${rtf.stddev.toFixed(4)} ` +
      `(${(summary.stddevOverMean * 100).toFixed(1)}% of mean${summary.noisy ? ' — noisy' : ''})`
  )
  if (summary.coldRtf !== null) console.log(`  RTF cold:    ${summary.coldRtf.toFixed(4)}`)
  console.log(
    `  Wall mean:   ${wallMs.mean.toFixed(0)}ms (load ${summary.modelLoadMs.toFixed(0)}ms)`
  )
  console.log(
    `  RSS avg:     ${memory.avgRssMb.toFixed(2)}MB (peak ${memory.peakRssMb.toFixed(2)}MB)`
  )
  console.log(`  Model size:  ${bytesToMb(summary.modelSizeBytes, 1)}MB\n`)
}

function describeSummary(settings, summary, backend) {
  return (
    `acestep ${settings.ditVariant} on ${backend}: ` +
    `RTF mean ${summary.rtf.mean.toFixed(4)} ` +
    `(p50 ${summary.rtf.p50.toFixed(4)}, cold ${(summary.coldRtf || 0).toFixed(4)}), ` +
    `wall ${summary.wallMs.mean.toFixed(0)}ms over ${summary.rtf.count} run(s), ` +
    `load ${summary.modelLoadMs.toFixed(0)}ms, peak RSS ${summary.memory.peakRssMb.toFixed(0)}MB`
  )
}

class ModelsUnavailableError extends Error {
  constructor(variant) {
    super(
      `ACE-Step ${variant} GGUFs unavailable — run \`npm run download-models:registry -- --variant ${variant}\` ` +
        'or set AUDIOGEN_GGML_LOCAL_MODELS_DIR.'
    )
    this.name = 'ModelsUnavailableError'
  }
}

async function ensureModelsOrThrow(settings) {
  const download = await ensureAudiogenModels({
    targetDir: modelsDir(),
    variant: settings.ditVariant
  })
  if (!download.success) throw new ModelsUnavailableError(settings.ditVariant)
  return download.modelDir
}

async function measureEngine(gen, settings, loadContext) {
  const warmupRuns = await runWarmups(gen, settings)
  const runs = await runMeasured(gen, settings)
  if (runs.length === 0) throw new Error('no benchmark runs completed')

  const unload = await reclaimAfterUnload(gen)
  const memorySummary = summarizeRunMemory(runs, {
    rssBeforeLoadBytes: loadContext.rssBeforeLoad,
    rssAfterLoadBytes: loadContext.rssAfterLoad,
    rssAfterUnloadBytes: unload.rssAfterUnloadBytes
  })
  const summary = buildSummary({
    runs,
    memorySummary,
    coldRun: warmupRuns[0] || runs[0],
    modelLoadMs: loadContext.modelLoadMs,
    modelSizeBytes: loadContext.modelSizeBytes
  })
  return { warmupRuns, runs, summary, unloaded: unload.unloaded }
}

async function runRtfBenchmark(settings, { ensureModels = ensureModelsOrThrow } = {}) {
  const backend = resolveBackend(platform, settings.useGPU, settings.backendHint)
  logHeader(settings, backend)

  const modelDir = await ensureModels(settings)

  const rssBeforeLoad = readRssBytes()
  const loadStartedAt = Date.now()
  const gen = await loadEngine(settings, modelDir)
  const modelLoadMs = Date.now() - loadStartedAt
  console.log(`Model loaded in ${modelLoadMs}ms`)

  const loadContext = {
    rssBeforeLoad,
    rssAfterLoad: readRssBytes(),
    modelLoadMs,
    modelSizeBytes: modelSizeBytesFor(settings.ditVariant, modelDir)
  }

  let destroyed = false
  const destroy = async () => {
    if (destroyed) return
    destroyed = true
    try {
      await gen.destroy()
    } catch {}
  }

  try {
    const { warmupRuns, runs, summary, unloaded } = await measureEngine(gen, settings, loadContext)
    destroyed = unloaded
    logSummary(summary, backend)
    assertBenchmarkResult({ settings, summary, runs })
    return {
      settings,
      backend,
      summary,
      runs,
      warmupRuns,
      report: buildReport({ settings, backend, summary, runs, warmupRuns }),
      destroy
    }
  } catch (err) {
    await destroy()
    throw err
  }
}

module.exports = {
  ENV_PREFIX,
  ARTIFACT_PREFIX,
  BENCHMARK_SEED,
  DEFAULT_DURATION_S,
  DEFAULT_WARMUP_RUNS,
  DEFAULT_DESKTOP_RUNS,
  DEFAULT_MOBILE_RUNS,
  CAPTIONS,
  DEVICE_INFO,
  envKey,
  loadDeviceEnvOnce,
  readBenchmarkSettings,
  resultsDir,
  runRtfBenchmark,
  writeRtfArtifact,
  emitCanonicalReport,
  describeSummary,
  evaluateBenchmarkResult,
  BenchmarkResultError,
  ModelsUnavailableError
}
