'use strict'

/**
 * Real-Time Factor (RTF) Benchmark for GGML TTS (tts-cpp)
 *
 * Captures RTF and related inference performance metrics from the addon's
 * runtimeStats (`response.stats`, emitted for both the Chatterbox and
 * Supertonic GGML engines via tts-cpp's Engine::runtime_stats()).
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
 * Unlike the ONNX backend, the GGML quantisation level is baked into the GGUF
 * (the QVAC registry serves q4_0 for the T3 / Supertonic weights and f16 for
 * the S3Gen vocoder). The `variant` field is therefore a *label* used for the
 * artifact filename + report columns, not a file-selection axis.
 *
 * GPU backends differ from ONNX too: tts-cpp resolves to Metal (darwin/ios),
 * Vulkan (linux/win32), or Vulkan/OpenCL (android). The active backend is
 * reported by the addon as `stats.backendId` (0=CPU, 1=Metal, 2=CUDA,
 * 3=Vulkan, 4=OpenCL, 99=other-GPU) / `stats.backendDevice` (0=CPU, 1=GPU).
 *
 * Environment variables (all optional):
 *   QVAC_TTS_GGML_BENCHMARK_ENGINE       chatterbox | chatterbox-mtl | supertonic | supertonic-mtl | supertonic3
 *                                        (default: chatterbox)
 *   QVAC_TTS_GGML_BENCHMARK_VARIANT      q4 | q8 | f16 | mixed       (default: q4, label only)
 *   QVAC_TTS_GGML_BENCHMARK_ENHANCER     none | lavasr               (default: none)
 *                                        `lavasr` layers the LavaSR 48 kHz
 *                                        bandwidth-extension enhancer on top of
 *                                        the engine; GGUF fetched from the QVAC
 *                                        registry — a published tier hard-fails if
 *                                        unresolved, an unpublished tier soft-skips
 *                                        (see lavasrResolve)
 *   QVAC_TTS_GGML_BENCHMARK_DENOISER     none | lavasr               (default: none)
 *                                        `lavasr` runs the LavaSR UL-UNAS denoiser
 *                                        before the engine output (independent of
 *                                        the enhancer axis); GGUF fetched from the
 *                                        QVAC registry — published, so it hard-fails
 *                                        if unresolved (see lavasrResolve)
 *   QVAC_TTS_GGML_BENCHMARK_USE_GPU      1 | true | 0 | false        (default: false)
 *   QVAC_TTS_GGML_BENCHMARK_BACKEND      cpu | metal | vulkan | cuda | opencl
 *                                        (free-form hint; defaults derived from
 *                                         platform + useGPU)
 *   QVAC_TTS_GGML_BENCHMARK_DEVICE       label for the device/runner used in reports
 *   QVAC_TTS_GGML_BENCHMARK_RUNNER       label for the CI runner used in reports
 *   QVAC_TTS_GGML_BENCHMARK_LABEL        free-form tag appended to artifact filenames
 *   QVAC_TTS_GGML_BENCHMARK_NUM_THREADS  override std::thread::hardware_concurrency()
 *   QVAC_TTS_GGML_BENCHMARK_WARMUP_RUNS  number of warmup iterations (default: 1)
 *   QVAC_TTS_GGML_BENCHMARK_RUNS         number of measured iterations (default: 5 desktop, 3 mobile)
 *   QVAC_TTS_GGML_BENCHMARK_RTF_UPPER_BOUND  assertion cap for mean RTF (optional)
 *   QVAC_TTS_GGML_BENCHMARK_QUALITY      enable Whisper round-trip CER/WER (default: true)
 *   QVAC_TTS_GGML_BENCHMARK_WHISPER_MODEL Whisper GGML filename (default: ggml-small.bin)
 *   QVAC_TTS_GGML_BENCHMARK_WER_UPPER_BOUND assertion cap for mean WER (optional)
 *   QVAC_TTS_GGML_BENCHMARK_CER_UPPER_BOUND assertion cap for mean CER (optional)
 */

const test = require('brittle')
const os = require('bare-os')
const path = require('bare-path')
const fs = require('bare-fs')
const process = require('bare-process')
const { loadChatterboxTTS, runChatterboxTTS } = require('../utils/runChatterboxTTS')
const { loadSupertonicTTS, runSupertonicTTS } = require('../utils/runSupertonicTTS')
const {
  ensureChatterboxModels,
  ensureChatterboxMtlModels,
  ensureSupertonicModel,
  ensureSupertonicMtlModel,
  ensureSupertonic3Model,
  supertonic3QuantFromVariant,
  normalizeEnhancer,
  normalizeDenoiser,
  normalizeEnhancerVariant,
  enhancerTag,
  denoiserTag,
  ensureWhisperModel
} = require('../utils/downloadModel')
const { resolveEnhancer, resolveDenoiser } = require('../utils/lavasrResolve')
const { loadWhisper, runWhisper } = require('../utils/runWhisper')
const { buildBenchmarkArtifactFileName } = require('../utils/artifactName')
const {
  readRssBytes,
  createMemorySampler,
  summarizeRunMemory,
  bytesToMb,
  RECLAIM_SETTLE_MS
} = require('../utils/memory-usage')

const VALID_ENGINES = [
  'chatterbox',
  'chatterbox-mtl',
  'supertonic',
  'supertonic-mtl',
  'supertonic3'
]
// GGUF quant is baked into the file (registry serves q4_0 weights + f16 s3gen),
// so the variant is a label, not a model selector. The list stays permissive so
// future re-quantised registry drops can be tagged without a code change here.
const VALID_VARIANTS = ['q4', 'q8', 'f16', 'mixed']
const VALID_WHISPER_MODELS = ['ggml-tiny.bin', 'ggml-small.bin', 'ggml-medium.bin']
// Schema version for the rich on-disk `rtf-benchmark-*.json` artifact
// consumed by `scripts/perf-report/aggregate-tts-ggml-rtf.js`.
const RTF_REPORT_SCHEMA_VERSION = 3
const RTF_RESULTS_DIR = path.resolve(__dirname, '../../benchmarks/results')

const platform = os.platform()
const arch = os.arch()
const platformArch = `${platform}-${arch}`
const isMobile = platform === 'ios' || platform === 'android'

// detect the desktop GPU/CPU hardware name (e.g. "NVIDIA RTX 4000
// SFF Ada") via the shared perf reporter's detectDevice(), which shells out to
// nvidia-smi / vulkaninfo / system_profiler through bare-subprocess. The
// reporter lives outside the addon bundle, so require it dynamically (path.join
// keeps bare-pack from statically resolving it during mobile bundling) and
// guard with try/catch — on mobile it's absent and the GPU stays null (the
// Device Farm device name is the proxy there). Probed once at module load.
let _hwDevice = null
try {
  let _subprocess = null
  try {
    _subprocess = require('bare-subprocess')
  } catch (_) {}
  const _perfBase = path.join('..', '..', '..', '..', 'scripts', 'test-utils')
  const _perfMod = require(path.join(_perfBase, 'performance-reporter'))
  _perfMod.configure({ fs, path, process, os, subprocess: _subprocess })
  _hwDevice = _perfMod.detectDevice()
} catch (_) {}

function _hwGpu() {
  return _hwDevice && _hwDevice.gpu ? _hwDevice.gpu : null
}

function _hwCpu() {
  return _hwDevice && _hwDevice.cpu ? _hwDevice.cpu : null
}

// Build a canonical performance-report record that the shared
// scripts/perf-report/extract-from-log.js + aggregate.js pipeline understands.
// Mobile Device Farm logs are scraped for
// [PERF_REPORT_START]<json>[PERF_REPORT_END] markers carrying this shape.
// Schema must satisfy isValidReport() in extract-from-log.js (string
// schema_version + results array).
function buildCanonicalReport(settings, summary, backend) {
  const useGPU = !!settings.useGPU
  const ep = useGPU ? 'gpu' : 'cpu'
  const engine = settings.engine
  const variant = settings.variant
  const enhancer = settings.enhancer || 'none'
  const enhancerVariant = settings.enhancerVariant || 'f16'
  const denoiser = settings.denoiser || 'none'
  // Append the enhancer / denoiser tokens only when enabled so existing 5-token
  // labels (`[CPU] engine variant backend`) parse unchanged in the aggregator.
  // Distinct tokens (`lavasr` / `denoise`) keep the two axes unambiguous.
  const lavasrTokens = [enhancerTag(enhancer), denoiserTag(denoiser)].filter(Boolean)
  const lavasrSuffix = lavasrTokens.length ? ` ${lavasrTokens.join(' ')}` : ''
  const testLabel = `[${ep.toUpperCase()}] ${engine} ${variant} ${backend}${lavasrSuffix}`

  const rtf = summary.rtf || {}
  const wallMs = summary.wallMs || {}
  const tps = summary.tokensPerSecond || {}
  const memory = summary.memory || {}
  const quality = summary.quality || {}

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
      gpu: _hwGpu(),
      cpu: _hwCpu(),
      runner: settings.runnerLabel || (isMobile ? 'device-farm' : 'github-actions')
    },
    results: [
      {
        test: testLabel,
        execution_provider: ep,
        enhancer,
        enhancerVariant,
        denoiser,
        qualityModel: quality.model || null,
        metrics: {
          real_time_factor: typeof rtf.mean === 'number' ? rtf.mean : null,
          rtf_p50: typeof rtf.p50 === 'number' ? rtf.p50 : null,
          rtf_p95: typeof rtf.p95 === 'number' ? rtf.p95 : null,
          wall_time_ms: typeof wallMs.mean === 'number' ? Math.round(wallMs.mean) : null,
          cold_rtf: typeof summary.coldRtf === 'number' ? summary.coldRtf : null,
          model_load_ms:
            typeof summary.modelLoadMs === 'number' ? Math.round(summary.modelLoadMs) : null,
          tps: typeof tps.mean === 'number' ? tps.mean : null,
          sample_count: typeof rtf.count === 'number' ? rtf.count : null,
          avg_rss_mb: typeof memory.avgRssMb === 'number' ? memory.avgRssMb : null,
          peak_rss_mb: typeof memory.peakRssMb === 'number' ? memory.peakRssMb : null,
          reclaimed_mb: typeof memory.reclaimedMb === 'number' ? memory.reclaimedMb : null,
          word_error_rate:
            quality.wer && typeof quality.wer.mean === 'number' ? quality.wer.mean : null,
          character_error_rate:
            quality.cer && typeof quality.cer.mean === 'number' ? quality.cer.mean : null
        }
      }
    ]
  }
}

function getEnv(name) {
  if (typeof os.getEnv === 'function') {
    try {
      return os.getEnv(name) || ''
    } catch (_) {
      return ''
    }
  }
  return (process.env && process.env[name]) || ''
}

function getEnvBoolean(name, fallback) {
  const value = getEnv(name)
  if (value === undefined || value === '') return fallback
  return value === '1' || value.toLowerCase() === 'true' || value.toLowerCase() === 'yes'
}

function getEnvInteger(name, fallback) {
  const value = getEnv(name)
  if (value === undefined || value === '') return fallback
  const parsed = Number.parseInt(value, 10)
  return Number.isNaN(parsed) ? fallback : parsed
}

function sanitizeTag(value) {
  if (!value) return ''
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function getSettings() {
  const engine = (getEnv('QVAC_TTS_GGML_BENCHMARK_ENGINE') || 'chatterbox').toLowerCase()
  if (!VALID_ENGINES.includes(engine)) {
    throw new Error(`Invalid benchmark engine: ${engine}. Valid: ${VALID_ENGINES.join(', ')}`)
  }

  const variant = (getEnv('QVAC_TTS_GGML_BENCHMARK_VARIANT') || 'q4').toLowerCase()
  if (!VALID_VARIANTS.includes(variant)) {
    throw new Error(`Invalid benchmark variant: ${variant}. Valid: ${VALID_VARIANTS.join(', ')}`)
  }

  const enhancer = normalizeEnhancer(getEnv('QVAC_TTS_GGML_BENCHMARK_ENHANCER'))
  const denoiser = normalizeDenoiser(getEnv('QVAC_TTS_GGML_BENCHMARK_DENOISER'))
  // Enhancer quant tier (f16 default | f32 | q8_0). Only meaningful when
  // enhancer=lavasr; picks which enhancer GGUF the registry fetch resolves.
  // Validated here so a typo fails loudly.
  const enhancerVariant = normalizeEnhancerVariant(
    getEnv('QVAC_TTS_GGML_BENCHMARK_ENHANCER_VARIANT')
  )

  const numThreadsRaw = getEnv('QVAC_TTS_GGML_BENCHMARK_NUM_THREADS') || ''
  const numThreadsParsed = Number.parseInt(numThreadsRaw, 10)
  const numThreads =
    Number.isFinite(numThreadsParsed) && numThreadsParsed > 0 ? numThreadsParsed : undefined
  const whisperModel = getEnv('QVAC_TTS_GGML_BENCHMARK_WHISPER_MODEL') || 'ggml-small.bin'
  if (!VALID_WHISPER_MODELS.includes(whisperModel)) {
    throw new Error(
      `Invalid Whisper quality model: ${whisperModel}. Valid: ${VALID_WHISPER_MODELS.join(', ')}`
    )
  }

  return {
    engine,
    variant,
    enhancer,
    denoiser,
    enhancerVariant,
    // Optional registry-path override (e.g. to pull a one-off enhancer build);
    // empty uses the tier resolved from enhancerVariant in ensureLavaSREnhancerGguf.
    enhancerRegistryPath: getEnv('LAVASR_ENHANCER_REGISTRY_PATH') || '',
    enhancerRegistrySource: getEnv('LAVASR_ENHANCER_REGISTRY_SOURCE') || '',
    // Same override for the denoiser leg (e.g. the fp32 build); empty uses the
    // baked-in default in ensureLavaSRDenoiserGguf.
    denoiserRegistryPath: getEnv('LAVASR_DENOISER_REGISTRY_PATH') || '',
    denoiserRegistrySource: getEnv('LAVASR_DENOISER_REGISTRY_SOURCE') || '',
    useGPU: getEnvBoolean('QVAC_TTS_GGML_BENCHMARK_USE_GPU', false),
    backendHint: getEnv('QVAC_TTS_GGML_BENCHMARK_BACKEND') || '',
    deviceLabel: getEnv('QVAC_TTS_GGML_BENCHMARK_DEVICE') || '',
    runnerLabel: getEnv('QVAC_TTS_GGML_BENCHMARK_RUNNER') || '',
    label: sanitizeTag(getEnv('QVAC_TTS_GGML_BENCHMARK_LABEL') || ''),
    numWarmup: getEnvInteger('QVAC_TTS_GGML_BENCHMARK_WARMUP_RUNS', 1),
    numRuns: getEnvInteger('QVAC_TTS_GGML_BENCHMARK_RUNS', isMobile ? 3 : 5),
    numThreads,
    requestedUpperBound: getEnv('QVAC_TTS_GGML_BENCHMARK_RTF_UPPER_BOUND') || '',
    qualityEnabled: getEnvBoolean('QVAC_TTS_GGML_BENCHMARK_QUALITY', true),
    whisperModel,
    requestedWerUpperBound: getEnv('QVAC_TTS_GGML_BENCHMARK_WER_UPPER_BOUND') || '',
    requestedCerUpperBound: getEnv('QVAC_TTS_GGML_BENCHMARK_CER_UPPER_BOUND') || '',
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

// tts-cpp's vcpkg port wires Metal on darwin/ios, Vulkan on linux/win32, and
// Vulkan + OpenCL on android (see test/integration/gpu-smoke.test.js). There is
// no CUDA in the default backend cascade today, so CUDA only appears here when
// it is explicitly requested via the backend hint on a CUDA-capable runner.
function resolveBackend(platformName, useGPU, backendHint) {
  const hint = String(backendHint || '').toLowerCase()
  if (hint) return hint
  if (!useGPU) return 'cpu'
  if (platformName === 'darwin' || platformName === 'ios') return 'metal'
  if (platformName === 'android') return 'vulkan'
  if (platformName === 'linux' || platformName === 'win32') return 'vulkan'
  return 'gpu'
}

function getArtifactFileName(settings) {
  return buildBenchmarkArtifactFileName('rtf-benchmark', platformArch, settings)
}

function nowMs() {
  const [sec, nsec] = process.hrtime()
  return sec * 1000 + nsec / 1e6
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0
  const idx = (p / 100) * (sorted.length - 1)
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return sorted[lo]
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo)
}

function computeStats(values) {
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

async function reclaimAfterUnload(model) {
  try {
    if (model) await model.unload()
  } catch (_) {
    /* ignore */
  }
  if (typeof global.gc === 'function') {
    try {
      global.gc()
    } catch (_) {
      /* ignore */
    }
  }
  await new Promise((resolve) => setTimeout(resolve, RECLAIM_SETTLE_MS))
  return readRssBytes()
}

function collectFilesSizeBytes(files) {
  let total = 0
  for (const file of files || []) {
    try {
      const stat = fs.statSync(file)
      if (stat.isFile()) total += Number(stat.size) || 0
    } catch (_) {
      /* file may be absent on a soft-skip path */
    }
  }
  return total
}

function backendIdToName(id) {
  switch (id) {
    case 0:
      return 'cpu'
    case 1:
      return 'metal'
    case 2:
      return 'cuda'
    case 3:
      return 'vulkan'
    case 4:
      return 'opencl'
    case 99:
      return 'other-gpu'
    default:
      return ''
  }
}

// Deterministic benchmark corpora (do not depend on network).
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

function isMultilingualEngine(engine) {
  return engine === 'chatterbox-mtl' || engine === 'supertonic-mtl'
}

function getCorpus(engine) {
  return isMultilingualEngine(engine) ? CORPUS_ES : CORPUS_EN
}

function getBaseDir() {
  return isMobile && global.testDir ? global.testDir : '.'
}

function writeQualityInput(iteration, wavBuffer) {
  const dir = path.join(getBaseDir(), 'benchmarks', 'quality-inputs')
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const filePath = path.join(dir, `rtf-quality-${Date.now()}-${iteration}.wav`)
  fs.writeFileSync(filePath, wavBuffer)
  return filePath
}

function cleanupQualityInputs(inputs) {
  for (const input of inputs) {
    if (!input.wavPath) continue
    try {
      if (fs.existsSync(input.wavPath)) fs.unlinkSync(input.wavPath)
    } catch (_) {}
  }
}

async function loadModelForEngine(settings) {
  const baseDir = getBaseDir()
  const modelsDir = path.join(baseDir, 'models')
  const threadOpts = settings.numThreads !== undefined ? { threads: settings.numThreads } : {}

  const enhancer = await resolveEnhancer(settings, baseDir)
  if (enhancer.skip) return { skip: true, skipReason: enhancer.skipReason }
  const denoiser = await resolveDenoiser(settings, baseDir)
  if (denoiser.skip) return { skip: true, skipReason: denoiser.skipReason }
  // The enhancer / denoiser GGUFs load alongside the engine, so fold them into
  // the model options + the on-disk size accounting when present.
  const lavasrOpts = {
    ...(enhancer.path ? { lavasrEnhancerPath: enhancer.path } : {}),
    ...(denoiser.path ? { lavasrDenoiserPath: denoiser.path } : {})
  }
  const lavasrFiles = [
    ...(enhancer.path ? [enhancer.path] : []),
    ...(denoiser.path ? [denoiser.path] : [])
  ]

  if (settings.engine === 'chatterbox') {
    const download = await ensureChatterboxModels({ targetDir: modelsDir })
    if (!download.success) throw new Error('Chatterbox GGUFs unavailable (registry fetch failed)')
    const dir = download.targetDir || modelsDir
    const model = await loadChatterboxTTS({
      modelDir: dir,
      language: 'en',
      useGPU: settings.useGPU,
      ...threadOpts,
      ...lavasrOpts
    })
    return {
      model,
      modelFiles: [
        path.join(dir, 'chatterbox-t3-turbo.gguf'),
        path.join(dir, 'chatterbox-s3gen.gguf'),
        ...lavasrFiles
      ]
    }
  }

  if (settings.engine === 'chatterbox-mtl') {
    const download = await ensureChatterboxMtlModels({ targetDir: modelsDir })
    if (!download.success)
      throw new Error('Chatterbox MTL GGUFs unavailable (registry fetch failed)')
    const dir = download.targetDir || modelsDir
    const model = await loadChatterboxTTS({
      modelDir: dir,
      t3ModelPath: path.join(dir, 'chatterbox-t3-mtl.gguf'),
      s3genModelPath: path.join(dir, 'chatterbox-s3gen-mtl.gguf'),
      language: 'es',
      useGPU: settings.useGPU,
      ...threadOpts,
      ...lavasrOpts
    })
    return {
      model,
      modelFiles: [
        path.join(dir, 'chatterbox-t3-mtl.gguf'),
        path.join(dir, 'chatterbox-s3gen-mtl.gguf'),
        ...lavasrFiles
      ]
    }
  }

  if (settings.engine === 'supertonic-mtl') {
    const download = await ensureSupertonicMtlModel({ targetDir: modelsDir })
    if (!download || !download.success)
      throw new Error('Supertonic MTL GGUF unavailable (registry fetch failed)')
    const supertonicPath =
      download.path || path.join(download.targetDir || modelsDir, 'supertonic2.gguf')
    const model = await loadSupertonicTTS({
      supertonicModelPath: supertonicPath,
      voice: 'F1',
      language: 'es',
      useGPU: settings.useGPU,
      ...threadOpts,
      ...lavasrOpts
    })
    return { model, modelFiles: [supertonicPath, ...lavasrFiles] }
  }

  if (settings.engine === 'supertonic3') {
    const quant = supertonic3QuantFromVariant(settings.variant)
    const download = await ensureSupertonic3Model({ targetDir: modelsDir, quant })
    if (!download || !download.success)
      throw new Error(`Supertonic 3 GGUF (${quant}) unavailable (registry fetch failed)`)
    const supertonicPath =
      download.path || path.join(download.targetDir || modelsDir, `supertonic3-${quant}.gguf`)
    const model = await loadSupertonicTTS({
      supertonicModelPath: supertonicPath,
      voice: 'F1',
      language: 'en',
      useGPU: settings.useGPU,
      ...threadOpts,
      ...lavasrOpts
    })
    return { model, modelFiles: [supertonicPath, ...lavasrFiles] }
  }

  const download = await ensureSupertonicModel({ targetDir: modelsDir })
  if (!download || !download.success)
    throw new Error('Supertonic GGUF unavailable (registry fetch failed)')
  const supertonicPath =
    download.path || path.join(download.targetDir || modelsDir, 'supertonic.gguf')
  const model = await loadSupertonicTTS({
    supertonicModelPath: supertonicPath,
    voice: 'F1',
    language: 'en',
    useGPU: settings.useGPU,
    ...threadOpts,
    ...lavasrOpts
  })
  return { model, modelFiles: [supertonicPath, ...lavasrFiles] }
}

// All Supertonic tiers (v1 / v2-mtl / v3) run through the Supertonic runner;
// everything else is Chatterbox.
const SUPERTONIC_ENGINES = ['supertonic', 'supertonic-mtl', 'supertonic3']

async function runSynthesis(engine, model, text) {
  const runner = SUPERTONIC_ENGINES.includes(engine) ? runSupertonicTTS : runChatterboxTTS
  return runner(model, { text }, {})
}

function getUpperBound(settings) {
  if (!settings.requestedUpperBound) return null
  const parsed = Number.parseFloat(settings.requestedUpperBound)
  return Number.isNaN(parsed) ? null : parsed
}

function parseOptionalBound(value) {
  if (!value) return null
  const parsed = Number.parseFloat(value)
  return Number.isNaN(parsed) ? null : parsed
}

test('RTF benchmark: GGML TTS on CI device', { timeout: 1800000 }, async (t) => {
  const settings = getSettings()
  const backend = resolveBackend(platform, settings.useGPU, settings.backendHint)
  const upperBound = getUpperBound(settings)
  const werUpperBound = parseOptionalBound(settings.requestedWerUpperBound)
  const cerUpperBound = parseOptionalBound(settings.requestedCerUpperBound)
  const corpus = getCorpus(settings.engine)

  console.log('\n' + '='.repeat(70))
  console.log('GGML TTS RTF BENCHMARK')
  console.log('='.repeat(70))
  console.log(`  Platform:       ${platformArch}`)
  console.log(`  Engine:         ${settings.engine}`)
  console.log(`  Variant:        ${settings.variant}`)
  console.log(
    `  Enhancer:       ${settings.enhancer}${settings.enhancer === 'lavasr' ? ` (${settings.enhancerVariant})` : ''}`
  )
  console.log(`  Denoiser:       ${settings.denoiser}`)
  console.log(`  GPU requested:  ${settings.useGPU}`)
  console.log(`  Backend:        ${backend}`)
  if (settings.deviceLabel) console.log(`  Device label:   ${settings.deviceLabel}`)
  if (settings.runnerLabel) console.log(`  Runner label:   ${settings.runnerLabel}`)
  if (settings.label) console.log(`  Label:          ${settings.label}`)
  if (settings.numThreads !== undefined) console.log(`  numThreads:     ${settings.numThreads}`)
  console.log(`  Warmup runs:    ${settings.numWarmup}`)
  console.log(`  Measured runs:  ${settings.numRuns}`)
  console.log(`  Corpus:         ${corpus.length} sentence(s)`)
  console.log(
    `  CER/WER:        ${settings.qualityEnabled ? `enabled (${settings.whisperModel})` : 'disabled'}`
  )
  if (settings.correlation.githubRunId) {
    console.log(
      `  GitHub run:     ${settings.correlation.githubWorkflow || ''} #${settings.correlation.githubRunId}`
    )
  }
  console.log('='.repeat(70) + '\n')

  console.log(`Loading model for engine: ${settings.engine}...`)
  const rssBeforeLoad = readRssBytes()
  const loadStart = nowMs()
  let model
  let modelFiles = []
  let loaded
  try {
    loaded = await loadModelForEngine(settings)
  } catch (err) {
    t.fail(`Model load failed: ${err.message}`)
    return
  }
  if (loaded && loaded.skip) {
    t.comment(loaded.skipReason || 'benchmark configuration unavailable')
    t.pass(`skipped — ${loaded.skipReason || 'unavailable'}`)
    return
  }
  model = loaded.model
  modelFiles = loaded.modelFiles || []
  const loadMs = nowMs() - loadStart
  const rssAfterLoad = readRssBytes()
  const modelSizeBytes = collectFilesSizeBytes(modelFiles)
  console.log(
    `Model loaded in ${loadMs.toFixed(0)}ms (rss +${((rssAfterLoad - rssBeforeLoad) / 1024 / 1024).toFixed(1)}MB, model ${(modelSizeBytes / 1024 / 1024).toFixed(1)}MB on disk)\n`
  )

  const runs = []
  const warmupRuns = []
  const qualityInputs = []
  let coldRtf = null
  let coldWallMs = null
  let peakRssBytes = rssAfterLoad
  let observedBackendId = null
  let whisperModel = null

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
      const rtfFromWall = durationMs > 0 ? wallMs / 1000 / (durationMs / 1000) : 0
      const rtf =
        rtfFromStats !== undefined && rtfFromStats !== null && rtfFromStats > 0
          ? rtfFromStats
          : rtfFromWall

      const currentRss = readRssBytes()
      if (currentRss > peakRssBytes) peakRssBytes = currentRss
      if (stats && typeof stats.backendId === 'number') observedBackendId = stats.backendId

      warmupRuns.push({ iteration: w + 1, wallMs, rtf, durationMs })
      if (w === 0) {
        coldRtf = rtf
        coldWallMs = wallMs
      }
      console.log(`  warmup wall=${wallMs.toFixed(0)}ms  rtf=${rtf.toFixed(4)}`)
    }

    // --- Measured runs ---
    console.log(
      `\nRunning ${settings.numRuns} measured iteration(s) over ${corpus.length} sentence(s)...\n`
    )
    for (let i = 0; i < settings.numRuns; i++) {
      const text = corpus[i % corpus.length]
      const sampler = createMemorySampler()
      const runStart = nowMs()
      sampler.start()
      const result = await runSynthesis(settings.engine, model, text)
      const runMemory = sampler.stop()
      const wallMs = nowMs() - runStart

      const currentRss = runMemory.peakBytes || readRssBytes()
      if (currentRss > peakRssBytes) peakRssBytes = currentRss

      if (!result.passed) {
        console.log(`  Run ${i + 1}: FAILED (${result.output})`)
        continue
      }

      const stats = (result.data && result.data.stats) || {}
      const durationMs = result.data ? result.data.durationMs : 0
      const sampleCount = result.data ? result.data.sampleCount : 0
      const rtfFromStats = stats.realTimeFactor
      const rtfFromWall = durationMs > 0 ? wallMs / 1000 / (durationMs / 1000) : 0
      const rtf =
        rtfFromStats !== undefined && rtfFromStats !== null && rtfFromStats > 0
          ? rtfFromStats
          : rtfFromWall
      if (typeof stats.backendId === 'number') observedBackendId = stats.backendId

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
        backendId: typeof stats.backendId === 'number' ? stats.backendId : null,
        rssBytes: currentRss,
        avgRssBytes: runMemory.avgBytes,
        peakRssBytes: runMemory.peakBytes,
        rssSampleCount: runMemory.count
      }
      runs.push(run)
      if (settings.qualityEnabled && result.data && result.data.wavBuffer) {
        try {
          qualityInputs.push({
            runIndex: runs.length - 1,
            reference: text,
            wavPath: writeQualityInput(i + 1, result.data.wavBuffer)
          })
        } catch (qualityWriteError) {
          console.log(
            `  Warning: could not persist quality input for run ${i + 1}: ${qualityWriteError.message}`
          )
        }
      }

      console.log(
        `  Run ${i + 1}/${settings.numRuns}: ` +
          `RTF=${rtf.toFixed(4)}  ` +
          `wall=${wallMs.toFixed(0)}ms  ` +
          `audio=${(durationMs / 1000).toFixed(2)}s  ` +
          `tokens/s=${(run.tokensPerSecond || 0).toFixed(1)}  ` +
          `rss avg=${bytesToMb(runMemory.avgBytes, 0)}MB peak=${bytesToMb(runMemory.peakBytes, 0)}MB`
      )
    }

    if (runs.length === 0) {
      t.fail('No benchmark runs completed')
      return
    }

    // --- Aggregate stats ---
    const rtfStats = computeStats(runs.map((r) => r.rtf))
    const wallStats = computeStats(runs.map((r) => r.wallMs))
    const tpsStats = computeStats(runs.map((r) => r.tokensPerSecond).filter((v) => v > 0))
    const stddevOverMean = rtfStats.mean > 0 ? rtfStats.stddev / rtfStats.mean : 0
    const noisy = stddevOverMean > 0.15
    const activeBackend = observedBackendId !== null ? backendIdToName(observedBackendId) : ''

    // --- Memory: unload here (not in finally) to measure the RSS the allocator
    // returns to the OS, then fold the per-run sampler records into the summary.
    // The cross-run aggregation (sample-weighted average, peak floor, fallback)
    // lives in the pure summarizeRunMemory helper so it is unit-tested.
    const rssAfterUnload = await reclaimAfterUnload(model)
    model = null
    const memorySummary = summarizeRunMemory(runs, {
      rssBeforeLoadBytes: rssBeforeLoad,
      rssAfterLoadBytes: rssAfterLoad,
      rssAfterUnloadBytes: rssAfterUnload
    })

    let qualitySummary = null
    let qualityUnavailableReason = null
    if (settings.qualityEnabled) {
      try {
        if (qualityInputs.length !== runs.length) {
          throw new Error(
            `quality input unavailable for one or more runs (${qualityInputs.length}/${runs.length})`
          )
        }

        const whisperModelDir = path.join(getBaseDir(), 'models', 'whisper')
        const whisperModelPath = path.join(whisperModelDir, settings.whisperModel)
        console.log(`\nLoading Whisper quality model: ${settings.whisperModel}...`)
        const whisperDownload = await ensureWhisperModel(whisperModelPath)
        if (!whisperDownload || !whisperDownload.success) {
          throw new Error(`Whisper model unavailable: ${whisperModelPath}`)
        }
        whisperModel = await loadWhisper({
          modelName: settings.whisperModel,
          diskPath: whisperModelDir,
          language: isMultilingualEngine(settings.engine) ? 'es' : 'en'
        })

        const wordErrorRates = []
        const characterErrorRates = []
        for (let i = 0; i < qualityInputs.length; i++) {
          const input = qualityInputs[i]
          console.log(`\n[quality ${i + 1}/${qualityInputs.length}]`)
          const wavBuffer = fs.readFileSync(input.wavPath)
          const quality = await runWhisper(whisperModel, input.reference, wavBuffer)
          wordErrorRates.push(quality.wer)
          characterErrorRates.push(quality.cer)
          runs[input.runIndex].quality = {
            transcription: quality.text,
            wer: quality.wer,
            cer: quality.cer
          }
          console.log(
            `  WER=${(quality.wer * 100).toFixed(2)}%  CER=${(quality.cer * 100).toFixed(2)}%`
          )
        }

        qualitySummary = {
          evaluator: 'whisper',
          model: settings.whisperModel,
          language: isMultilingualEngine(settings.engine) ? 'es' : 'en',
          wer: computeStats(wordErrorRates),
          cer: computeStats(characterErrorRates)
        }
      } catch (qualityError) {
        qualityUnavailableReason = qualityError.message
        qualitySummary = null
        for (const run of runs) delete run.quality
        t.comment(`CER/WER unavailable: ${qualityUnavailableReason}`)
        console.log(`\nWarning: CER/WER unavailable: ${qualityUnavailableReason}`)
      } finally {
        if (whisperModel) {
          try {
            await whisperModel.unload()
          } catch (_) {}
          whisperModel = null
        }
      }
    }

    console.log('\n' + '='.repeat(70))
    console.log('RTF BENCHMARK RESULTS')
    console.log('='.repeat(70))
    console.log(`  Platform:        ${platformArch}`)
    console.log(`  Engine:          ${settings.engine}`)
    console.log(
      `  Backend:         ${backend}${activeBackend && activeBackend !== backend ? ` (active: ${activeBackend})` : ''}`
    )
    console.log(`  Iterations:      ${runs.length}`)
    if (settings.numThreads !== undefined) console.log(`  numThreads:      ${settings.numThreads}`)
    console.log('')
    console.log('  Real-Time Factor (RTF):')
    console.log(`    Mean:   ${rtfStats.mean.toFixed(4)}`)
    console.log(`    Min:    ${rtfStats.min.toFixed(4)}`)
    console.log(`    Max:    ${rtfStats.max.toFixed(4)}`)
    console.log(
      `    Stddev: ${rtfStats.stddev.toFixed(4)} (${(stddevOverMean * 100).toFixed(1)}% of mean${noisy ? ' ⚠ noisy' : ''})`
    )
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
    console.log('  Memory (RSS, MB):')
    console.log(`    Average:      ${memorySummary.avgRssMb.toFixed(2)}`)
    console.log(`    Peak:         ${memorySummary.peakRssMb.toFixed(2)}`)
    console.log(
      `    After load:   ${memorySummary.rssAfterLoadMb.toFixed(2)} (pre-load ${memorySummary.rssBeforeLoadMb.toFixed(2)})`
    )
    console.log(`    After unload: ${memorySummary.rssAfterUnloadMb.toFixed(2)}`)
    console.log(`    Reclaimed:    ${memorySummary.reclaimedMb.toFixed(2)}`)
    console.log(`    Model size:   ${(modelSizeBytes / 1024 / 1024).toFixed(1)}`)
    if (qualitySummary) {
      console.log('')
      console.log('  Round-trip speech quality:')
      console.log(`    Mean WER:     ${(qualitySummary.wer.mean * 100).toFixed(2)}%`)
      console.log(`    Mean CER:     ${(qualitySummary.cer.mean * 100).toFixed(2)}%`)
      console.log(`    WER P95:      ${(qualitySummary.wer.p95 * 100).toFixed(2)}%`)
      console.log(`    CER P95:      ${(qualitySummary.cer.p95 * 100).toFixed(2)}%`)
    } else if (qualityUnavailableReason) {
      console.log('')
      console.log(`  Round-trip speech quality: unavailable (${qualityUnavailableReason})`)
    }
    console.log('='.repeat(70) + '\n')

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
        enhancer: settings.enhancer,
        enhancerVariant: settings.enhancerVariant,
        denoiser: settings.denoiser,
        sizeBytes: modelSizeBytes
      },
      labels: {
        runner: settings.runnerLabel,
        device: settings.deviceLabel,
        backend,
        activeBackend,
        gpuModel: _hwGpu(),
        cpuModel: _hwCpu(),
        requestedBackend: settings.useGPU ? 'gpu' : 'cpu',
        label: settings.label
      },
      config: {
        warmupRuns: settings.numWarmup,
        benchmarkRuns: settings.numRuns,
        useGPU: settings.useGPU,
        variant: settings.variant,
        enhancer: settings.enhancer,
        enhancerVariant: settings.enhancerVariant,
        denoiser: settings.denoiser,
        modelLoadMs: loadMs,
        numThreads: settings.numThreads !== undefined ? settings.numThreads : null,
        qualityEnabled: settings.qualityEnabled,
        whisperModel: settings.qualityEnabled ? settings.whisperModel : null
      },
      requested: {
        engine: settings.engine,
        variant: settings.variant,
        enhancer: settings.enhancer,
        enhancerVariant: settings.enhancerVariant,
        denoiser: settings.denoiser,
        useGPU: settings.useGPU,
        backendHint: settings.backendHint,
        deviceLabel: settings.deviceLabel,
        runnerLabel: settings.runnerLabel,
        numThreads: settings.numThreads !== undefined ? settings.numThreads : null,
        qualityEnabled: settings.qualityEnabled
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
        rssAfterUnloadBytes: rssAfterUnload,
        memory: memorySummary,
        quality: qualitySummary,
        qualityUnavailableReason,
        modelSizeBytes,
        backendId: observedBackendId,
        activeBackend,
        stddevOverMean,
        noisy
      },
      runs,
      warmupRuns
    }

    // --- Write JSON artifact ---
    // The flat per-config `rtf-benchmark-*.json` file is the input for the
    // desktop aggregator (`scripts/perf-report/aggregate-tts-ggml-rtf.js`),
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
    // and feeds them into the shared aggregate.js.
    const canonicalReport = buildCanonicalReport(settings, report.summary, backend)
    const canonicalJson = JSON.stringify(canonicalReport)
    console.log(`[PERF_REPORT_START]${canonicalJson}[PERF_REPORT_END]`)

    // Mobile: emit chunked copy too, because some Device Farm log sinks truncate long lines.
    // extract-from-log.js reassembles `[PERF_CHUNK:id:idx:total]<fragment>` runs.
    if (isMobile) {
      const CHUNK_SIZE = 400
      const chunkCount = Math.max(1, Math.ceil(canonicalJson.length / CHUNK_SIZE))
      const chunkId = `ttsggml-${Date.now()}`
      for (let i = 0; i < chunkCount; i++) {
        const fragment = canonicalJson.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE)
        console.log(`[PERF_CHUNK:${chunkId}:${i}:${chunkCount}]${fragment}`)
      }
    }

    // --- Assertions ---
    t.ok(
      runs.length === settings.numRuns,
      `Completed ${settings.numRuns} benchmark runs (got ${runs.length})`
    )
    t.ok(rtfStats.mean > 0, 'Mean RTF should be positive')

    if (upperBound !== null) {
      t.ok(
        rtfStats.mean <= upperBound,
        `Mean RTF ${rtfStats.mean.toFixed(4)} should be <= ${upperBound}`
      )
    }

    if (qualitySummary && werUpperBound !== null) {
      t.ok(
        qualitySummary.wer.mean <= werUpperBound,
        `Mean WER ${(qualitySummary.wer.mean * 100).toFixed(2)}% should be <= ${(werUpperBound * 100).toFixed(2)}%`
      )
    }

    if (qualitySummary && cerUpperBound !== null) {
      t.ok(
        qualitySummary.cer.mean <= cerUpperBound,
        `Mean CER ${(qualitySummary.cer.mean * 100).toFixed(2)}% should be <= ${(cerUpperBound * 100).toFixed(2)}%`
      )
    }

    t.ok(memorySummary.peakRssMb > 0, 'Peak memory (RSS) should be positive')
    t.ok(memorySummary.avgRssMb > 0, 'Average memory (RSS) should be positive')
    t.ok(
      memorySummary.peakRssMb >= memorySummary.avgRssMb,
      'Peak memory should be >= average memory'
    )
    t.ok(memorySummary.reclaimedMb >= 0, 'Reclaimed memory should be non-negative')

    console.log('RTF benchmark completed successfully.\n')
  } finally {
    cleanupQualityInputs(qualityInputs)
    if (model) {
      try {
        await model.unload()
      } catch (_) {}
    }
    if (whisperModel) {
      try {
        await whisperModel.unload()
      } catch (_) {}
    }
  }
})
