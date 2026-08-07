#!/usr/bin/env node
'use strict'

/**
 * Unified RTF/perf aggregator for @qvac/asr-ggml (merge of the retired
 * aggregate-whisper-rtf.js + aggregate-parakeet-rtf.js).
 *
 * The merged addon ships two engines behind one package, so one aggregator
 * renders one table with an `Engine` column instead of two reports that could
 * never be compared side by side. Every record carries `engine`
 * ('whisper'|'parakeet'), resolved from the artifact itself:
 *   - desktop: the `engine` field the merged matrix runner stamps, falling back
 *     to `model.type` presence (pre-merge parakeet artifacts still in manual
 *     dirs) and finally to whisper.
 *   - mobile: `report.addon` when it is still an engine name (pre-merge
 *     artifacts), else the parakeet model-type token in the test name.
 */

const fs = require('fs')
const path = require('path')

// GGML GPU backend cascade shared by both engines: Vulkan (linux/win32/Mali
// android), Metal (darwin/ios), OpenCL (Adreno android, e.g. Samsung Galaxy
// S25). CUDA is not supported on any platform.
const SUPPORTED_GPU_BACKENDS = ['vulkan', 'metal', 'opencl']

// ggml active-backend ids reported by the addon (post-merge this is the unified
// BackendId enum — one map serves both engines), mapped to the backend label.
// Used to recover the REAL backend a mobile device selected at runtime rather
// than guessing it from the platform family.
const BACKEND_BY_ID = { 0: 'cpu', 1: 'metal', 2: 'cuda', 3: 'vulkan', 4: 'opencl' }

const ENGINES = ['whisper', 'parakeet']

// Mobile perf reports we own. Pre-merge artifacts stamp the engine name as the
// addon; the merged addon stamps 'asr-ggml' and the engine is recovered from the
// test-name tokens below.
const ASR_ADDONS = new Set(['whisper', 'parakeet', 'asr-ggml'])

// Parakeet model types, in test-name bracket form. `sortformer-streaming`
// (v2.1) must precede `sortformer` (v1) so the more specific token wins the
// alternation.
const PARAKEET_MODEL_TYPE_RE = /\[(tdt|ctc|eou|sortformer-streaming|sortformer)\]/
const PARAKEET_MODEL_TYPES = new Set(['tdt', 'ctc', 'eou', 'sortformer-streaming', 'sortformer'])

function parseArgs (argv) {
  const args = {
    input: '',
    output: '',
    jsonOutput: '',
    htmlOutput: '',
    manualDir: path.resolve('packages/asr-ggml/benchmarks/manual-results')
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = argv[i + 1]
    if ((arg === '--input' || arg === '--dir') && next) {
      args.input = next
      i++
    } else if (arg === '--output' && next) {
      args.output = next
      i++
    } else if ((arg === '--json-output' || arg === '--output-json') && next) {
      args.jsonOutput = next
      i++
    } else if (arg === '--output-html' && next) {
      args.htmlOutput = next
      i++
    } else if (arg === '--manual-dir' && next) {
      args.manualDir = next
      i++
    }
  }

  if (!args.input) {
    throw new Error('Missing required --input argument')
  }

  return args
}

function escapeHtml (value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function walkFiles (dir) {
  const files = []
  if (!fs.existsSync(dir)) return files

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...walkFiles(fullPath))
      continue
    }
    files.push(fullPath)
  }

  return files
}

function ensureParentDir (filePath) {
  const dirPath = path.dirname(filePath)
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true })
  }
}

function formatNumber (value, digits = 4) {
  if (value === null || value === undefined || Number.isNaN(value)) return 'n/a'
  return Number(value).toFixed(digits)
}

function formatMaybeInteger (value) {
  if (value === null || value === undefined || Number.isNaN(value)) return 'n/a'
  return String(Math.round(Number(value)))
}

function mean (values) {
  const nums = values.filter(value => Number.isFinite(value))
  if (nums.length === 0) return NaN
  return nums.reduce((sum, value) => sum + value, 0) / nums.length
}

// Population standard deviation, matching the desktop benchmark's stats().
function stddev (values) {
  const nums = values.filter(value => Number.isFinite(value))
  if (nums.length === 0) return NaN
  const avg = nums.reduce((sum, value) => sum + value, 0) / nums.length
  const variance = nums.reduce((sum, value) => sum + (value - avg) ** 2, 0) / nums.length
  return Math.sqrt(variance)
}

function maxFinite (values) {
  const nums = values.filter(value => Number.isFinite(value))
  if (nums.length === 0) return NaN
  return nums.reduce((current, value) => (value > current ? value : current), nums[0])
}

function percentile (values, p) {
  const nums = values
    .filter(value => Number.isFinite(value))
    .slice()
    .sort((a, b) => a - b)
  if (nums.length === 0) return NaN
  const idx = Math.min(nums.length - 1, Math.max(0, Math.ceil((p / 100) * nums.length) - 1))
  return nums[idx]
}

function numberOrNaN (value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : NaN
}

const ADRENO_GPU_RE = /adreno/i
const ADRENO_DEVICE_NAME_RE = /(?:samsung|galaxy)[\s_-]*(?:galaxy[\s_-]*)?s25(?![0-9])/i
const ADRENO_ANDROID_BACKEND = 'opencl'
const PLACEHOLDER_BACKEND_HINTS = new Set(['mobile-accelerated', 'gpu'])
const GUESSED_ANDROID_GPU_HINTS = new Set(['', 'vulkan', 'mobile-accelerated', 'gpu'])
const HAND_AUTHORED_BACKEND_SOURCES = new Set(['manual'])

function isAdrenoDevice (gpuModel, deviceName) {
  return ADRENO_GPU_RE.test(String(gpuModel || '')) ||
    ADRENO_DEVICE_NAME_RE.test(String(deviceName || ''))
}

function isHandAuthoredBackend (source, backendHint) {
  return Boolean(backendHint) && HAND_AUTHORED_BACKEND_SOURCES.has(String(source || ''))
}

function needsAdrenoCorrection (source, backendHint, gpuModel, deviceName) {
  return !isHandAuthoredBackend(source, backendHint) && isAdrenoDevice(gpuModel, deviceName)
}

function normalizeBackend (platformName, useGPU, backendHint, adreno) {
  const platform = String(platformName || '').toLowerCase()
  const hint = String(backendHint || '').toLowerCase()
  if (adreno && useGPU && platform === 'android' && GUESSED_ANDROID_GPU_HINTS.has(hint)) {
    return ADRENO_ANDROID_BACKEND
  }
  if (hint && !PLACEHOLDER_BACKEND_HINTS.has(hint)) return hint
  if (!useGPU) return 'cpu'

  switch (platform) {
    case 'android':
      return 'vulkan'
    case 'ios':
    case 'darwin':
      return 'metal'
    case 'linux':
    case 'win32':
      return hint || 'vulkan'
    default:
      return hint || 'gpu'
  }
}

// Prefer the observed ggml backend id (per-device ground truth) over the
// platform-family guess. Falls back to normalizeBackend when the addon did not
// report an id (older prebuilds, a snapshot without stats, or the parakeet
// mobile path which never stamped one).
function resolveMobileBackend (backendId, platformName, useGPU, adreno) {
  if (typeof backendId === 'number' && BACKEND_BY_ID[backendId]) {
    return BACKEND_BY_ID[backendId]
  }
  return normalizeBackend(platformName, useGPU, '', adreno)
}

function humanizeSourceFile (sourceFile) {
  if (!sourceFile) return 'unknown'
  return path.basename(sourceFile).replace(/\.[^.]+$/, '').replace(/_/g, ' ')
}

// Quantisation token from a model/GGUF/GGML file name (e.g. `q8_0`, `q5_1`,
// `f16`). Used as a fallback when a record predates the explicit `model.quant`
// field; the q5_1/q5_0 alternatives cover whisper's `ggml-base-q5_1.bin` naming.
function quantFromName (name) {
  const match = String(name || '').match(/(?:\.|-)(q8_0|q5_1|q5_0|q4_0|f16|f32)(?:\.(?:gguf|bin)|[-.]|$)/i)
  return match ? match[1].toLowerCase() : ''
}

/**
 * Which engine produced a report/record.
 *
 * `engine` (stamped by the merged matrix runner and the merged benchmark
 * server) wins. Everything else is back-compat with pre-merge artifacts that
 * still live in the manual-results dirs: parakeet reports key the model as
 * `model.type` (or a flat `modelType`/model-type string), whisper reports key it
 * as `model.name`.
 */
function resolveEngine (report) {
  const explicit = String((report && report.engine) || '').toLowerCase()
  if (ENGINES.includes(explicit)) return explicit
  if (report && report.model && report.model.type) return 'parakeet'
  if (report && report.modelType) return 'parakeet'
  if (report && typeof report.model === 'string' && PARAKEET_MODEL_TYPES.has(report.model.toLowerCase())) {
    return 'parakeet'
  }
  return 'whisper'
}

function reportModelName (report, engine) {
  const model = report.model || {}
  if (engine === 'parakeet') return model.type || model.name || 'unknown'
  if (!model.name) return 'unknown'
  // whisper reports carry the on-disk file name; drop the extension so the
  // Model column reads `ggml-tiny-q5_1` rather than `ggml-tiny-q5_1.bin`.
  return String(model.name).replace(/\.(?:bin|gguf)$/, '')
}

function reportQuant (report, sourceFile) {
  const model = report.model || {}
  return model.quant ||
    quantFromName(model.name) ||
    quantFromName(model.dirName) ||
    quantFromName(model.path) ||
    quantFromName(sourceFile) ||
    ''
}

/**
 * One normalizer for both engines' desktop-shaped reports (`summary.rtf` etc.).
 * whisper reports do not carry `addonVersion` or a probed GPU name yet, so those
 * columns render empty for whisper rows.
 */
function normalizeReport (report, sourceFile, source) {
  const engine = resolveEngine(report)
  const summary = report.summary || {}
  const rtf = summary.rtf || {}
  const wallMs = summary.wallMs || {}
  const memory = summary.memory || {}
  const platformName = report.platformName || report.platform || ''
  const useGPU = Boolean(
    report.requested && report.requested.useGPU !== undefined
      ? report.requested.useGPU
      : report.config && report.config.useGPU
  )
  const backendHint = (report.labels && report.labels.backend) ||
    (report.requested && report.requested.backendHint)
  const label = report.labels && (report.labels.device || report.labels.runner || report.labels.label)
  const gpuModel = (report.labels && report.labels.gpuModel) || (report.device && report.device.gpu) || null

  return {
    source,
    engine,
    device: label || report.platform || 'unknown',
    platform: report.platform || 'unknown',
    platformFamily: platformName || 'unknown',
    model: reportModelName(report, engine),
    quant: reportQuant(report, sourceFile),
    gpu: useGPU ? 'gpu' : 'cpu',
    backend: normalizeBackend(platformName, useGPU, backendHint,
      needsAdrenoCorrection(source, backendHint, gpuModel, label)),
    // CPU-only rows never ran on the GPU, so don't attribute the host's GPU
    // to them — the probe stamps the GPU name onto every report regardless of
    // whether that run used it.
    gpuModel: useGPU ? gpuModel : null,
    version: report.addonVersion || '',
    meanRtf: Number(rtf.mean),
    stddevRtf: Number(rtf.stddev),
    p50: Number(rtf.p50),
    p95: Number(rtf.p95),
    wallMs: Number(wallMs.mean),
    avgRssMb: numberOrNaN(memory.avgRssMb),
    peakRssMb: numberOrNaN(memory.peakRssMb),
    reclaimedMb: numberOrNaN(memory.reclaimedMb),
    notes: sourceFile ? path.basename(sourceFile) : ''
  }
}

function normalizeDesktopRecord (report, sourceFile) {
  return normalizeReport(report, sourceFile, 'desktop-ci')
}

// A manual-results entry may either be a raw benchmark report (with `summary`)
// or an already-flattened row; only the former goes through normalizeReport.
function isRawReport (item) {
  return Boolean(item && (item.summary || (item.model && (item.model.type || item.model.name))))
}

function normalizeManualRecord (record, sourceFile) {
  const engine = resolveEngine(record)
  const platformFamily = String(record.platformFamily || record.platform || '').toLowerCase()
  const useGPU = record.gpu ? record.gpu === 'gpu' : Boolean(record.useGPU)
  const source = record.source || 'manual'
  const adreno = needsAdrenoCorrection(source, record.backend,
    record.gpuModel || record.gpu_model, record.device)

  return {
    source: record.source || 'manual',
    engine,
    device: record.device || humanizeSourceFile(sourceFile),
    platform: record.platform || 'unknown',
    platformFamily: platformFamily || 'unknown',
    model: record.model || record.modelType || 'unknown',
    quant: record.quant || quantFromName(record.dirName) || quantFromName(record.model) || '',
    gpu: useGPU ? 'gpu' : 'cpu',
    backend: normalizeBackend(platformFamily, useGPU, record.backend, adreno),
    gpuModel: useGPU ? (record.gpuModel || record.gpu_model || null) : null,
    version: record.version || '',
    meanRtf: Number(record.meanRtf),
    stddevRtf: Number(record.stddevRtf !== undefined ? record.stddevRtf : record.stddev),
    p50: Number(record.p50),
    p95: Number(record.p95),
    wallMs: Number(record.wallMs),
    avgRssMb: numberOrNaN(record.avgRssMb),
    peakRssMb: numberOrNaN(record.peakRssMb),
    reclaimedMb: numberOrNaN(record.reclaimedMb),
    notes: record.notes || ''
  }
}

function isMobilePerformanceReport (report) {
  if (!report || !report.device || !Array.isArray(report.results)) return false
  const addon = String(report.addon || '').toLowerCase()
  const addonType = String(report.addon_type || '').toLowerCase()
  return ASR_ADDONS.has(addon) || ASR_ADDONS.has(addonType)
}

function mobileExecutionProvider (result) {
  const explicit = String(result.execution_provider || '').toLowerCase()
  if (explicit === 'gpu' || explicit === 'cpu') return explicit

  const testName = String(result.test || '').toLowerCase()
  if (testName.includes('[gpu]')) return 'gpu'
  if (testName.includes('[cpu]')) return 'cpu'
  return 'cpu'
}

// Engine for one mobile result row. Pre-merge artifacts still name the engine as
// the addon; merged ('asr-ggml') artifacts are disambiguated by the parakeet
// model-type token the mobile perf runner stamps into the test name.
function resolveMobileEngine (report, result) {
  const addon = String((report && report.addon) || (report && report.addon_type) || '').toLowerCase()
  if (addon === 'whisper' || addon === 'parakeet') return addon
  return PARAKEET_MODEL_TYPE_RE.test(String((result && result.test) || '').toLowerCase())
    ? 'parakeet'
    : 'whisper'
}

function mobileModelType (result) {
  const match = String(result.test || '').toLowerCase().match(PARAKEET_MODEL_TYPE_RE)
  return match ? match[1] : 'tdt'
}

function mobileModelTag (result) {
  const testName = String(result.test || '')
  // Test names look like '[ggml-tiny] [CPU] mobile-perf run 1' — pull the
  // first bracketed token that isn't a [CPU]/[GPU] execution-provider tag or a
  // quantisation tag.
  const matches = testName.match(/\[([^\]]+)\]/g) || []
  for (const raw of matches) {
    const value = raw.slice(1, -1)
    const lower = value.toLowerCase()
    if (lower === 'cpu' || lower === 'gpu') continue
    if (/^(q8_0|q5_1|q5_0|q4_0|f16|f32)$/.test(lower)) continue
    return value.replace(/^ggml-/, '')
  }
  return 'unknown'
}

// Quantisation token from the mobile test label (e.g. `[q4_0]`), stamped by
// mobile-perf-runner.js.
function mobileQuantTag (result) {
  const match = String(result.test || '').toLowerCase().match(/\[(q8_0|q5_1|q5_0|q4_0|f16|f32)\]/)
  return match ? match[1] : ''
}

function mobileQuant (result, engine, modelTag) {
  const tagged = mobileQuantTag(result)
  if (tagged) return tagged
  // whisper's model tag carries the quant inline (`ggml-base-q5_1`).
  const inline = quantFromName(modelTag)
  if (inline) return inline
  // Older parakeet mobile artifacts predate the [quant] tag; those runs only
  // staged q4_0 models, so default them to q4_0 instead of rendering "-".
  return engine === 'parakeet' ? 'q4_0' : ''
}

function normalizeMobileRecords (report, sourceFile) {
  const grouped = new Map()
  const device = report.device || {}
  const platformFamily = String(device.platform || '').toLowerCase()
  const notes = path.basename(path.dirname(sourceFile))

  for (const result of report.results || []) {
    const engine = resolveMobileEngine(report, result)
    const provider = mobileExecutionProvider(result)
    const modelTag = engine === 'parakeet' ? mobileModelType(result) : mobileModelTag(result)
    const quant = mobileQuant(result, engine, modelTag)
    const metrics = result.metrics || {}
    const key = `${engine}|${modelTag}|${quant}|${provider}`
    if (!grouped.has(key)) {
      grouped.set(key, {
        engine,
        modelTag,
        quant,
        provider,
        rtf: [],
        wallMs: [],
        avgRss: [],
        peakRss: [],
        afterLoadRss: [],
        reclaimed: [],
        backendId: null
      })
    }
    const group = grouped.get(key)
    // Mobile runs can report real_time_factor as null (the mobile inference
    // stats don't always carry it), which left the RTF/P50/P95 columns empty and
    // made the Android/iOS rows look unpopulated. Derive RTF from the wall time
    // over the audio duration when the explicit value is missing.
    const rtf = typeof metrics.real_time_factor === 'number'
      ? metrics.real_time_factor
      : (typeof metrics.wall_time_ms === 'number' &&
         typeof metrics.audio_duration_ms === 'number' &&
         metrics.audio_duration_ms > 0
          ? metrics.wall_time_ms / metrics.audio_duration_ms
          : null)
    if (typeof rtf === 'number' && Number.isFinite(rtf)) group.rtf.push(rtf)
    if (typeof metrics.wall_time_ms === 'number') group.wallMs.push(metrics.wall_time_ms)
    if (typeof metrics.avg_rss_mb === 'number') group.avgRss.push(metrics.avg_rss_mb)
    if (typeof metrics.peak_rss_mb === 'number') group.peakRss.push(metrics.peak_rss_mb)
    if (typeof metrics.rss_after_load_mb === 'number') group.afterLoadRss.push(metrics.rss_after_load_mb)
    if (typeof metrics.reclaimed_mb === 'number') group.reclaimed.push(metrics.reclaimed_mb)
    if (group.backendId === null && typeof metrics.backend_id === 'number') group.backendId = metrics.backend_id
  }

  const records = []
  for (const values of grouped.values()) {
    const useGPU = values.provider === 'gpu'
    records.push({
      source: 'mobile-ci',
      engine: values.engine,
      device: device.name || humanizeSourceFile(sourceFile),
      platform: device.platform || 'unknown',
      platformFamily: platformFamily || 'unknown',
      model: values.modelTag,
      quant: values.quant || '',
      gpu: values.provider,
      backend: resolveMobileBackend(values.backendId, platformFamily, useGPU,
        isAdrenoDevice(device.gpu, device.name)),
      gpuModel: useGPU ? (device.gpu || null) : null,
      version: report.addonVersion || '',
      meanRtf: mean(values.rtf),
      stddevRtf: stddev(values.rtf),
      p50: percentile(values.rtf, 50),
      p95: percentile(values.rtf, 95),
      wallMs: mean(values.wallMs),
      avgRssMb: mean(values.avgRss),
      // Floor the mobile peak at the recorded post-activation footprint so it is
      // computed on the same basis as the desktop peak (which buildMemorySummary
      // clamps to rssAfterLoad); a run whose sampler missed the true peak can't
      // then report below the load footprint.
      peakRssMb: maxFinite(values.peakRss.concat(values.afterLoadRss)),
      reclaimedMb: maxFinite(values.reclaimed),
      notes
    })
  }

  return records
}

function loadArtifactRecords (inputDir) {
  const records = []
  const files = walkFiles(inputDir).filter(file => /^rtf-benchmark-.*\.json$/.test(path.basename(file)))
  for (const file of files) {
    const report = JSON.parse(fs.readFileSync(file, 'utf8'))
    const platformName = String(report.platformName || report.platform || '').toLowerCase()
    const source = platformName === 'android' || platformName === 'ios' ? 'mobile-ci' : 'desktop-ci'
    records.push(normalizeReport(report, file, source))
  }
  return records
}

function loadMobilePerformanceRecords (inputDir) {
  const records = []
  const files = walkFiles(inputDir).filter(file => path.basename(file) === 'performance-report.json')
  for (const file of files) {
    const report = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (isMobilePerformanceReport(report)) {
      records.push(...normalizeMobileRecords(report, file))
    }
  }
  return records
}

// Recurses, so manual-results/{whisper,parakeet}/ both load.
function loadManualRecords (manualDir) {
  const records = []
  if (!fs.existsSync(manualDir)) return records

  const files = walkFiles(manualDir).filter(file => file.endsWith('.json'))
  for (const file of files) {
    const payload = JSON.parse(fs.readFileSync(file, 'utf8'))
    const items = Array.isArray(payload) ? payload : (payload.records || [payload])
    for (const item of items) {
      if (isRawReport(item)) {
        records.push(normalizeReport(item, file, item.source || 'manual'))
      } else {
        records.push(normalizeManualRecord(item, file))
      }
    }
  }
  return records
}

function scoreRecord (record) {
  let score = 0
  if (Number.isFinite(record.meanRtf)) score += 8
  if (Number.isFinite(record.p50)) score += 4
  if (Number.isFinite(record.p95)) score += 4
  if (Number.isFinite(record.wallMs)) score += 2
  if (Number.isFinite(record.avgRssMb)) score += 2
  if (Number.isFinite(record.peakRssMb)) score += 2
  if (Number.isFinite(record.reclaimedMb)) score += 1
  if (record.device && record.device !== 'unknown') score += 1
  if (record.notes) score += 1
  return score
}

// `engine` is part of the key: the two engines legitimately run the same device
// in the same lane, and collapsing them would drop half the table.
function dedupeRecords (records) {
  const byKey = new Map()

  for (const record of records) {
    const key = [
      record.source,
      record.engine,
      record.platform,
      record.platformFamily,
      record.model,
      record.quant,
      record.gpu,
      record.backend,
      record.device
    ].join('|')
    const existing = byKey.get(key)
    if (!existing || scoreRecord(record) > scoreRecord(existing)) {
      byKey.set(key, record)
    }
  }

  return [...byKey.values()]
}

function sortRecords (records) {
  const sortKey = record => [
    record.source,
    record.engine,
    record.platform,
    record.model,
    record.quant,
    record.gpu,
    record.device
  ].join('|')
  return records.sort((left, right) => sortKey(left).localeCompare(sortKey(right)))
}

function coverageFor (records) {
  const gpuCoverage = new Set(
    records
      .filter(record => record.gpu === 'gpu')
      .map(record => record.backend)
      .filter(Boolean)
  )
  return {
    rowCount: records.length,
    gpuBackendsCovered: Array.from(gpuCoverage).sort(),
    missingBackends: SUPPORTED_GPU_BACKENDS.filter(backend => !gpuCoverage.has(backend))
  }
}

function buildCoverage (records) {
  const versions = Array.from(new Set(
    records.map(record => record.version).filter(Boolean)
  )).sort()

  // Per-engine coverage: one engine covering Metal says nothing about whether
  // the other engine was ever exercised there, so the gaps are reported per
  // engine as well as overall.
  const byEngine = {}
  for (const engine of ENGINES) {
    byEngine[engine] = coverageFor(records.filter(record => record.engine === engine))
  }

  return Object.assign(coverageFor(records), {
    addonVersions: versions,
    byEngine
  })
}

// Fastest config per device (lowest mean RTF). Mirrors the LLM suite's
// "best configuration per device" block; for an ASR addon "best" means the
// lowest real-time factor (fastest relative to audio length).
function buildBestPerDevice (records) {
  const byDevice = new Map()
  for (const record of records) {
    if (!Number.isFinite(record.meanRtf)) continue
    const key = `${record.source}|${record.device}`
    const existing = byDevice.get(key)
    if (!existing || record.meanRtf < existing.meanRtf) {
      byDevice.set(key, record)
    }
  }
  return [...byDevice.values()].sort((left, right) => {
    return `${left.source}|${left.device}`.localeCompare(`${right.source}|${right.device}`)
  })
}

function renderMarkdown (records) {
  const lines = []
  const coverage = buildCoverage(records)

  lines.push('## ASR GGML Performance Findings')
  lines.push('')
  lines.push('| Source | Engine | Device | Platform | Model | Quant | GPU | Backend | GPU Model | Version | Mean RTF | ± Stddev | P50 | P95 | Mean Wall (ms) | Avg RSS (MB) | Peak RSS (MB) | Reclaimed (MB) | Notes |')
  lines.push('|--------|--------|--------|----------|-------|-------|-----|---------|-----------|---------|----------|----------|-----|-----|----------------|--------------|---------------|----------------|-------|')

  for (const record of records) {
    lines.push(
      `| ${record.source} | ${record.engine} | ${record.device} | ${record.platform} | ${record.model} | ${record.quant || '-'} | ${record.gpu} | ${record.backend} | ${record.gpuModel || '-'} | ${record.version || '-'} | ${formatNumber(record.meanRtf)} | ${formatNumber(record.stddevRtf)} | ${formatNumber(record.p50)} | ${formatNumber(record.p95)} | ${formatMaybeInteger(record.wallMs)} | ${formatMaybeInteger(record.avgRssMb)} | ${formatMaybeInteger(record.peakRssMb)} | ${formatMaybeInteger(record.reclaimedMb)} | ${record.notes || ''} |`
    )
  }

  lines.push('')
  lines.push('### Best configuration per device')
  lines.push('')
  lines.push('Lowest mean RTF per device (fastest relative to audio length), across engines.')
  lines.push('')
  lines.push('| Source | Engine | Device | Model | Quant | GPU | Backend | Mean RTF | ± Stddev |')
  lines.push('|--------|--------|--------|-------|-------|-----|---------|----------|----------|')
  for (const record of buildBestPerDevice(records)) {
    lines.push(
      `| ${record.source} | ${record.engine} | ${record.device} | ${record.model} | ${record.quant || '-'} | ${record.gpu} | ${record.backend} | ${formatNumber(record.meanRtf)} | ${formatNumber(record.stddevRtf)} |`
    )
  }

  lines.push('')
  lines.push('### Coverage')
  lines.push('')
  lines.push(`- Rows aggregated: ${coverage.rowCount}`)
  lines.push(`- Addon version(s): ${coverage.addonVersions.join(', ') || 'unknown'}`)
  lines.push(`- GPU backends covered: ${coverage.gpuBackendsCovered.join(', ') || 'none'}`)
  lines.push(`- GPU backends still missing: ${coverage.missingBackends.join(', ') || 'none'}`)
  for (const engine of ENGINES) {
    const engineCoverage = coverage.byEngine[engine]
    lines.push(`- ${engine}: ${engineCoverage.rowCount} row(s), GPU backends covered: ${engineCoverage.gpuBackendsCovered.join(', ') || 'none'}, still missing: ${engineCoverage.missingBackends.join(', ') || 'none'}`)
  }

  return lines.join('\n') + '\n'
}

function renderHtml (records) {
  const coverage = buildCoverage(records)
  const rows = records.map(record => {
    return [
      record.source,
      record.engine,
      record.device,
      record.platform,
      record.model,
      record.quant || '-',
      record.gpu,
      record.backend,
      record.gpuModel || '-',
      record.version || '-',
      formatNumber(record.meanRtf),
      formatNumber(record.stddevRtf),
      formatNumber(record.p50),
      formatNumber(record.p95),
      formatMaybeInteger(record.wallMs),
      formatMaybeInteger(record.avgRssMb),
      formatMaybeInteger(record.peakRssMb),
      formatMaybeInteger(record.reclaimedMb),
      record.notes || ''
    ].map(value => `<td>${escapeHtml(value)}</td>`).join('')
  }).map(cells => `<tr>${cells}</tr>`).join('\n')

  const bestRows = buildBestPerDevice(records).map(record => {
    return [
      record.source,
      record.engine,
      record.device,
      record.model,
      record.quant || '-',
      record.gpu,
      record.backend,
      formatNumber(record.meanRtf),
      formatNumber(record.stddevRtf)
    ].map(value => `<td>${escapeHtml(value)}</td>`).join('')
  }).map(cells => `<tr>${cells}</tr>`).join('\n')

  const engineCoverageItems = ENGINES.map(engine => {
    const engineCoverage = coverage.byEngine[engine]
    return `    <li>${escapeHtml(engine)}: <code>${escapeHtml(String(engineCoverage.rowCount))}</code> row(s), covered: <code>${escapeHtml(engineCoverage.gpuBackendsCovered.join(', ') || 'none')}</code>, still missing: <code>${escapeHtml(engineCoverage.missingBackends.join(', ') || 'none')}</code></li>`
  }).join('\n')

  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '  <meta charset="utf-8">',
    '  <meta name="viewport" content="width=device-width, initial-scale=1">',
    '  <title>ASR GGML Performance Findings</title>',
    '  <style>',
    '    body { font-family: Arial, sans-serif; margin: 24px; color: #1f2937; }',
    '    h1, h2 { margin-bottom: 12px; }',
    '    table { border-collapse: collapse; width: 100%; margin-top: 16px; }',
    '    th, td { border: 1px solid #d1d5db; padding: 8px 10px; text-align: left; }',
    '    th { background: #f3f4f6; }',
    '    tr:nth-child(even) td { background: #f9fafb; }',
    '    ul { margin-top: 0; }',
    '    code { font-family: Menlo, Consolas, monospace; }',
    '  </style>',
    '</head>',
    '<body>',
    '  <h1>ASR GGML Performance Findings</h1>',
    '  <table>',
    '    <thead>',
    '      <tr>',
    '        <th>Source</th>',
    '        <th>Engine</th>',
    '        <th>Device</th>',
    '        <th>Platform</th>',
    '        <th>Model</th>',
    '        <th>Quant</th>',
    '        <th>GPU</th>',
    '        <th>Backend</th>',
    '        <th>GPU Model</th>',
    '        <th>Version</th>',
    '        <th>Mean RTF</th>',
    '        <th>± Stddev</th>',
    '        <th>P50</th>',
    '        <th>P95</th>',
    '        <th>Mean Wall (ms)</th>',
    '        <th>Avg RSS (MB)</th>',
    '        <th>Peak RSS (MB)</th>',
    '        <th>Reclaimed (MB)</th>',
    '        <th>Notes</th>',
    '      </tr>',
    '    </thead>',
    '    <tbody>',
    rows,
    '    </tbody>',
    '  </table>',
    '  <h2>Best configuration per device</h2>',
    '  <p>Lowest mean RTF per device (fastest relative to audio length), across engines.</p>',
    '  <table>',
    '    <thead>',
    '      <tr>',
    '        <th>Source</th>',
    '        <th>Engine</th>',
    '        <th>Device</th>',
    '        <th>Model</th>',
    '        <th>Quant</th>',
    '        <th>GPU</th>',
    '        <th>Backend</th>',
    '        <th>Mean RTF</th>',
    '        <th>± Stddev</th>',
    '      </tr>',
    '    </thead>',
    '    <tbody>',
    bestRows,
    '    </tbody>',
    '  </table>',
    '  <h2>Coverage</h2>',
    '  <ul>',
    `    <li>Rows aggregated: <code>${escapeHtml(String(coverage.rowCount))}</code></li>`,
    `    <li>Addon version(s): <code>${escapeHtml(coverage.addonVersions.join(', ') || 'unknown')}</code></li>`,
    `    <li>GPU backends covered: <code>${escapeHtml(coverage.gpuBackendsCovered.join(', ') || 'none')}</code></li>`,
    `    <li>GPU backends still missing: <code>${escapeHtml(coverage.missingBackends.join(', ') || 'none')}</code></li>`,
    engineCoverageItems,
    '  </ul>',
    '</body>',
    '</html>',
    ''
  ].join('\n')
}

function main () {
  const args = parseArgs(process.argv.slice(2))
  const inputDir = path.resolve(args.input)
  const manualDir = path.resolve(args.manualDir)

  const desktopRecords = loadArtifactRecords(inputDir)
  const mobileRecords = loadMobilePerformanceRecords(inputDir)
  const manualRecords = loadManualRecords(manualDir)
  const records = sortRecords(dedupeRecords(desktopRecords.concat(mobileRecords, manualRecords)))
  const markdown = renderMarkdown(records)
  const html = renderHtml(records)

  if (args.output) {
    const outputPath = path.resolve(args.output)
    ensureParentDir(outputPath)
    fs.writeFileSync(outputPath, markdown, 'utf8')
  }

  if (args.jsonOutput) {
    const jsonOutputPath = path.resolve(args.jsonOutput)
    ensureParentDir(jsonOutputPath)
    fs.writeFileSync(jsonOutputPath, JSON.stringify({ records, coverage: buildCoverage(records) }, null, 2) + '\n', 'utf8')
  }

  if (args.htmlOutput) {
    const htmlOutputPath = path.resolve(args.htmlOutput)
    ensureParentDir(htmlOutputPath)
    fs.writeFileSync(htmlOutputPath, html, 'utf8')
  }

  process.stdout.write(markdown)
}

if (require.main === module) {
  main()
}

module.exports = {
  resolveEngine,
  normalizeReport,
  normalizeDesktopRecord,
  normalizeMobileRecords,
  normalizeManualRecord,
  dedupeRecords,
  renderMarkdown,
  renderHtml,
  buildCoverage
}
