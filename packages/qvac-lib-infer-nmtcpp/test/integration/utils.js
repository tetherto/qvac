'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const os = require('bare-os')
const process = require('bare-process')

// ============================================================================
// Platform Detection
// ============================================================================

/** Current platform (darwin, linux, win32, ios, android) */
const platform = process.platform

/** Whether running on mobile device (iOS or Android) */
const isMobile = platform === 'ios' || platform === 'android'

// ============================================================================
// Singleton Performance Reporter
// ============================================================================

// Dynamic require via path.join prevents bare-pack from statically resolving
// the path during mobile bundling (the script lives outside the addon package).
let createPerformanceReporter, evaluateTranslationQuality, findTranslationGroundTruth
const _scriptBase = path.join('..', '..', '..', '..', 'scripts', 'test-utils')
try {
  const perfReporterMod = require(path.join(_scriptBase, 'performance-reporter'))
  perfReporterMod.configure({ fs, path, process, os })
  createPerformanceReporter = perfReporterMod.createPerformanceReporter
} catch (_) {
  // Mobile bundle — inline lightweight reporter that records metrics and
  // emits [PERF_REPORT_START]...[PERF_REPORT_END] markers to console so the
  // NMT mobile workflow (or a manual `grep` on Device Farm logs) can pull
  // the numbers out. Mirrors the OCR pattern from PR #1625.
  createPerformanceReporter = function (opts) {
    const _results = []
    const _startedAt = new Date().toISOString()
    const _addon = (opts && opts.addon) || 'unknown'
    const _addonType = (opts && opts.addonType) || 'generic'
    const _platform = (process && process.platform) || ''
    const _device = {
      name: _platform,
      platform: _platform,
      os_version: '',
      arch: (os && os.arch) ? os.arch() : '',
      runner: 'device-farm'
    }

    return {
      record (testName, metrics, extra) {
        const entry = {
          test: testName,
          execution_provider: (extra && extra.execution_provider) || null,
          metrics: Object.assign({
            total_time_ms: null,
            decode_time_ms: null,
            generated_tokens: null,
            tps: null,
            chrfpp: null
          }, metrics || {}),
          input: (extra && extra.input) || null,
          output: (extra && extra.output) || null,
          reference: (extra && extra.reference) || null
        }
        // Store quality separately so aggregate.js's Quality Summary
        // section can render chrF++ in the mobile HTML / MD report.
        if (extra && extra.quality) entry.quality = extra.quality
        _results.push(entry)
      },
      toJSON () {
        return {
          schema_version: '1.0',
          addon: _addon,
          addon_type: _addonType,
          timestamp: _startedAt,
          device: _device,
          results: _results
        }
      },
      writeReport (destPath) {
        const json = JSON.stringify(this.toJSON())
        // Write JSON to best-effort device paths so Device Farm artifact
        // collection can grab it. Mirrors OCR's inline reporter.
        //
        // On iOS, `global.testDir` (set by qvac-test-addon-mobile) maps
        // to the app's Documents directory, which Appium's `pullFile`
        // can reach as `@<bundle>:documents/perf-report.json`. We also
        // try `os.tmpdir()` (the app's tmp container) which is reachable
        // as `@<bundle>:tmp/perf-report.json`.
        const dirs = []
        if (typeof global !== 'undefined' && global.testDir) dirs.push(global.testDir)
        if (_platform === 'android') {
          dirs.push('/sdcard/Android/data/io.tether.test.qvac/files')
          dirs.push('/storage/emulated/0/Android/data/io.tether.test.qvac/files')
          dirs.push('/data/local/tmp')
        }
        try {
          if (os && typeof os.tmpdir === 'function') dirs.push(os.tmpdir())
        } catch (_) {}
        dirs.push('/tmp')
        for (const d of dirs) {
          try {
            try { fs.mkdirSync(d, { recursive: true }) } catch (_) {}
            const p = path.join(d, 'perf-report.json')
            fs.writeFileSync(p, json)
            console.log('[PERF_REPORT_PATH]' + p)
          } catch (_) {}
        }
        // Also write to the explicit destPath the desktop reporter uses,
        // when it is writable (e.g. when running integration tests on a
        // simulator host with shared filesystem).
        if (destPath) {
          try {
            try { fs.mkdirSync(path.dirname(destPath), { recursive: true }) } catch (_) {}
            fs.writeFileSync(destPath, json)
          } catch (_) {}
        }
      },
      writeStepSummary () { /* no step summary on mobile */ },
      writeToConsole () {
        try {
          const json = JSON.stringify(this.toJSON())
          // Chunk large payloads so Android logcat per-entry size limits
          // don't truncate the report.
          const CHUNK = 800
          if (json.length <= CHUNK) {
            console.log('[PERF_REPORT_START]' + json + '[PERF_REPORT_END]')
          } else {
            const id = Date.now().toString(36)
            const n = Math.ceil(json.length / CHUNK)
            for (let i = 0; i < n; i++) {
              console.log('[PERF_CHUNK:' + id + ':' + i + ':' + n + ']' + json.substring(i * CHUNK, (i + 1) * CHUNK))
            }
          }
        } catch (err) {
          console.log('[perf-reporter] mobile console write failed: ' + err.message)
        }
      },
      get length () { return _results.length }
    }
  }
}

try {
  const translationQualityMod = require(path.join(_scriptBase, 'translation-quality'))
  translationQualityMod.configure({ fs, path })
  evaluateTranslationQuality = translationQualityMod.evaluateTranslationQuality
  findTranslationGroundTruth = translationQualityMod.findTranslationGroundTruth
} catch (_) {
  // Mobile bundle fallback — inline chrF++ + fixture data so quality
  // scoring works on device without file I/O for fixture JSONs.
  //
  // The inline fixtures are a verbatim copy of the three
  // packages/qvac-lib-infer-nmtcpp/test/integration/fixtures/*.quality.json
  // files. Keep them in sync if the on-disk fixtures change.
  const _inlineFixtures = {
    'bergamot.quality.json': [
      { source: 'Hello, how are you?', src_lang: 'en', dst_lang: 'it', reference: 'Ciao, come stai?', notes: 'validated 2026-04-23 (informal register)' }
    ],
    'indictrans.quality.json': [
      { source: 'Hello, how are you?', src_lang: 'eng_Latn', dst_lang: 'hin_Deva', reference: 'नमस्ते, आप कैसे हैं?', notes: 'validated 2026-04-23 (formal register, आप)' }
    ],
    'pivot-bergamot.quality.json': [
      { source: 'Buenos días, ¿cómo estás hoy?', src_lang: 'es', dst_lang: 'it', reference: 'Buongiorno, come stai oggi?', notes: 'validated 2026-04-23 (informal register)' },
      { source: "Bonjour, comment allez-vous aujourd'hui?", src_lang: 'fr', dst_lang: 'es', reference: 'Hola, ¿cómo está usted hoy?', notes: 'validated 2026-04-23 (formal register, usted)' }
    ]
  }

  function _cleanWhitespace (text) {
    return String(text).replace(/\r\n/g, '\n').replace(/[\t\v\f]/g, ' ').replace(/ {2,}/g, ' ').trim()
  }

  function _extractCharNgrams (text, n) {
    const stripped = text.replace(/\s+/g, '')
    const grams = new Map()
    if (stripped.length < n) return grams
    for (let i = 0; i <= stripped.length - n; i++) {
      const g = stripped.slice(i, i + n)
      grams.set(g, (grams.get(g) || 0) + 1)
    }
    return grams
  }

  function _extractWordNgrams (text, n) {
    const words = text.split(/\s+/).filter(Boolean)
    const grams = new Map()
    if (words.length < n) return grams
    for (let i = 0; i <= words.length - n; i++) {
      const g = words.slice(i, i + n).join(' ')
      grams.set(g, (grams.get(g) || 0) + 1)
    }
    return grams
  }

  function _computePR (hGrams, rGrams) {
    let hTotal = 0
    for (const c of hGrams.values()) hTotal += c
    let rTotal = 0
    for (const c of rGrams.values()) rTotal += c
    if (hTotal === 0 || rTotal === 0) return null
    let matches = 0
    for (const [g, hc] of hGrams) {
      const rc = rGrams.get(g)
      if (rc !== undefined) matches += Math.min(hc, rc)
    }
    return { p: matches / hTotal, r: matches / rTotal }
  }

  function _chrfpp (hypothesis, reference) {
    const h = _cleanWhitespace(hypothesis)
    const r = _cleanWhitespace(reference)
    if (h.length === 0 || r.length === 0) return 0
    let precSum = 0
    let recSum = 0
    let validOrders = 0
    for (let n = 1; n <= 6; n++) {
      const res = _computePR(_extractCharNgrams(h, n), _extractCharNgrams(r, n))
      if (res) {
        precSum += res.p
        recSum += res.r
        validOrders++
      }
    }
    for (let n = 1; n <= 2; n++) {
      const res = _computePR(_extractWordNgrams(h, n), _extractWordNgrams(r, n))
      if (res) {
        precSum += res.p
        recSum += res.r
        validOrders++
      }
    }
    if (validOrders === 0) return 0
    const avgP = precSum / validOrders
    const avgR = recSum / validOrders
    if (avgP === 0 && avgR === 0) return 0
    const b2 = 4 // beta=2 squared
    return (1 + b2) * avgP * avgR / (b2 * avgP + avgR)
  }

  function _round4 (v) { return Math.round(v * 10000) / 10000 }

  evaluateTranslationQuality = function (hypothesis, groundTruthEntry) {
    if (!groundTruthEntry || typeof groundTruthEntry !== 'object') return null
    const reference = groundTruthEntry.reference || ''
    return {
      source: groundTruthEntry.source || null,
      reference,
      src_lang: groundTruthEntry.src_lang || null,
      dst_lang: groundTruthEntry.dst_lang || null,
      chrfpp: _round4(_chrfpp(hypothesis, reference))
    }
  }

  findTranslationGroundTruth = function (fixturePath, source, srcLang, dstLang) {
    // Map fixture file basename → inline entries. Works on mobile where
    // the fixture JSON isn't bundled as a readable file.
    const key = String(fixturePath).split(/[\\/]/).pop()
    const entries = _inlineFixtures[key]
    if (!Array.isArray(entries)) return null
    for (const entry of entries) {
      if (entry.source === source && entry.src_lang === srcLang && entry.dst_lang === dstLang) {
        return entry
      }
    }
    return null
  }
}

const _perfReporter = createPerformanceReporter({
  addon: 'nmtcpp',
  addonType: 'translation'
})

const _reportPath = path.resolve(__dirname, '../../test/results/performance-report.json')
let _reportScheduled = false

function _scheduleReportWrite () {
  if (_reportScheduled) return
  _reportScheduled = true
  process.on('exit', () => {
    if (_perfReporter.length > 0) {
      _perfReporter.writeReport(_reportPath)
      _perfReporter.writeStepSummary()
      // On mobile, also emit the report to console so Device Farm log
      // collection captures it. No-op on desktop (writeToConsole is
      // only defined on the mobile inline reporter).
      if (isMobile && typeof _perfReporter.writeToConsole === 'function') {
        _perfReporter.writeToConsole()
      }
    }
  })
}

// ============================================================================
// Test Timeouts
// ============================================================================

/** Mobile timeout: 10 minutes (model downloads can be slow) */
const MOBILE_TIMEOUT = 600 * 1000

/** Desktop timeout: 2 minutes (models pre-downloaded) */
const DESKTOP_TIMEOUT = 120 * 1000

/** Appropriate timeout based on platform */
const TEST_TIMEOUT = isMobile ? MOBILE_TIMEOUT : DESKTOP_TIMEOUT

// ============================================================================
// Download Helpers
// ============================================================================

/**
 * Downloads a file from URL to destination path with redirect support
 * Handles HTTP 301/302/307/308 redirects up to maxRedirects times
 *
 * @param {string} url - Source URL to download from
 * @param {string} destPath - Local file path to save to
 * @param {number} [maxRedirects=5] - Maximum number of redirects to follow
 * @returns {Promise<void>}
 * @throws {Error} If download fails or redirects exceed limit
 */
async function downloadFile (url, destPath, maxRedirects = 5, maxRetries = 3) {
  const fetch = require('bare-fetch')

  // Retry loop for transient network errors (CONNECTION_LOST, socket hang up).
  // Without this an unhandled rejection from bare-fetch on Device Farm's
  // flaky mobile network can abort the whole Bare process — which surfaced
  // on Samsung Galaxy S25 Ultra as a SIGABRT inside libbare-kit.so::
  // js_callback_s::on_call during the second IndicTrans re-download.
  let lastErr = null
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (attempt > 0) {
      const backoffMs = 500 * (2 ** (attempt - 1))
      console.log(`   Retry ${attempt}/${maxRetries - 1} after ${backoffMs}ms (last error: ${lastErr && lastErr.message})`)
      await new Promise(resolve => setTimeout(resolve, backoffMs))
    }
    try {
      console.log(`Downloading: ${url.substring(0, 60)}...`)
      const response = await fetch(url, { redirect: 'follow', follow: maxRedirects })

      if ([301, 302, 307, 308].includes(response.status)) {
        const location = response.headers.get('location')
        if (location && maxRedirects > 0) {
          console.log(`   Following redirect to: ${location.substring(0, 60)}...`)
          return downloadFile(location, destPath, maxRedirects - 1, maxRetries)
        }
        throw new Error(`HTTP ${response.status}: Redirect not followed (no location header or max redirects exceeded)`)
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }

      const buffer = await response.arrayBuffer()
      fs.writeFileSync(destPath, Buffer.from(buffer))
      console.log(`Downloaded: ${path.basename(destPath)} (${(buffer.byteLength / 1024 / 1024).toFixed(1)}MB)`)
      return
    } catch (err) {
      lastErr = err
      // Only retry on network errors; HTTP status errors are deterministic.
      if (err && /HTTP \d{3}/.test(err.message || '')) throw err
    }
  }
  throw new Error(`downloadFile failed after ${maxRetries} attempts: ${lastErr && lastErr.message}`)
}

// ============================================================================
// Asset Configuration Loading
// ============================================================================

/**
 * Loads JSON configuration from testAssets directory
 * Searches multiple candidate paths to support both mobile and desktop environments
 *
 * Mobile: Uses global.assetPaths provided by test framework
 * Desktop: Uses filesystem paths relative to test directory
 *
 * @param {string} filename - Configuration filename (e.g., 'bergamot-urls.json')
 * @returns {Object|null} Parsed JSON configuration or null if not found
 */
function loadConfigFromAssets (filename) {
  let urlConfig = null

  // Mobile: Check global.assetPaths (set by test framework)
  if (global.assetPaths) {
    const candidates = [
      `../../testAssets/${filename}`,
      `../mobile/testAssets/${filename}`,
      `testAssets/${filename}`,
      `../testAssets/${filename}`
    ]

    for (const candidate of candidates) {
      if (global.assetPaths[candidate]) {
        try {
          const configData = fs.readFileSync(global.assetPaths[candidate].replace('file://', ''), 'utf8')
          urlConfig = JSON.parse(configData)
          console.log(`   Loaded config from asset: ${candidate}`)
          return urlConfig
        } catch (e) {
          console.log(`   Failed to load asset ${candidate}: ${e.message}`)
        }
      }
    }
  }

  // Desktop: Check filesystem paths
  const fallbackPaths = [
    path.resolve(__dirname, `../mobile/testAssets/${filename}`),
    path.resolve(__dirname, `../../test/mobile/testAssets/${filename}`)
  ]

  for (const fallbackPath of fallbackPaths) {
    if (fs.existsSync(fallbackPath)) {
      try {
        urlConfig = JSON.parse(fs.readFileSync(fallbackPath, 'utf8'))
        console.log(`   Loaded config from file: ${fallbackPath}`)
        return urlConfig
      } catch (e) {
        console.log(`   Failed to parse ${fallbackPath}: ${e.message}`)
      }
    }
  }

  return null
}

// ============================================================================
// Model Availability Helpers
// ============================================================================

/**
 * Ensures IndicTrans model is available
 * Desktop: Expects model at ../../model/indictrans/ggml-indictrans2-en-indic-dist-200M-q4_0.bin
 * Mobile: Downloads from presigned URL configured in indictrans-model-urls.json
 *
 * @returns {Promise<string>} Path to IndicTrans model file
 * @throws {Error} If model not found/available or corrupted (< 100MB)
 */
async function ensureIndicTransModel () {
  const modelFilename = 'ggml-indictrans2-en-indic-dist-200M-q4_0.bin'
  const relativeDir = '../../model/indictrans'
  const modelPath = path.resolve(__dirname, relativeDir, modelFilename)

  // Desktop: Check if model exists locally
  if (fs.existsSync(modelPath)) {
    const stats = fs.statSync(modelPath)
    const sizeMB = stats.size / (1024 * 1024)
    if (sizeMB < 100) {
      throw new Error(`IndicTrans model file seems corrupted (expected ~127MB, got ${sizeMB.toFixed(2)}MB)`)
    }
    return modelPath
  }

  // Desktop without model: Error (should be pre-downloaded)
  if (!isMobile) {
    throw new Error(`IndicTrans model not found at ${modelPath}. Please download it first.`)
  }

  // Mobile: Download from presigned URL
  const configFilename = 'indictrans-model-urls.json'
  const urlConfig = loadConfigFromAssets(configFilename)

  if (!urlConfig || !urlConfig.modelUrl) {
    throw new Error('IndicTrans model URLs config not found - cannot download model on mobile')
  }

  const writableRoot = global.testDir || '/tmp'
  const modelsDir = path.join(writableRoot, 'translation-models', 'indictrans')
  fs.mkdirSync(modelsDir, { recursive: true })

  const destPath = path.join(modelsDir, modelFilename)

  // Cache hit: IndicTrans is 200MB+, so re-downloading for every test
  // variant (GPU/CPU) wastes bandwidth and exposes each run to transient
  // S3/Device-Farm network failures — the root cause of the Samsung
  // Galaxy S25 Ultra CONNECTION_LOST → SIGABRT seen in CI run 1212.
  if (fs.existsSync(destPath)) {
    const cachedStats = fs.statSync(destPath)
    const cachedMB = cachedStats.size / (1024 * 1024)
    if (cachedMB >= 100) {
      console.log(`Reusing cached IndicTrans model: ${destPath} (${cachedMB.toFixed(1)}MB)`)
      return destPath
    }
    console.log(`Cached IndicTrans model is undersized (${cachedMB.toFixed(2)}MB) — re-downloading`)
  }

  await downloadFile(urlConfig.modelUrl, destPath)

  // Validate downloaded model size
  const stats = fs.statSync(destPath)
  const sizeMB = stats.size / (1024 * 1024)
  if (sizeMB < 100) {
    throw new Error(`Downloaded IndicTrans model seems corrupted (expected ~127MB, got ${sizeMB.toFixed(2)}MB)`)
  }

  return destPath
}

/**
 * Ensures Bergamot model is available
 *
 * Download priority:
 *   1. Check local path (../../model/bergamot/enit/)
 *   2. Fallback: download directly from Firefox Remote Settings CDN
 *
 * @returns {Promise<string>} Path to Bergamot model directory
 * @throws {Error} If model files not found/available
 */
async function ensureBergamotModel () {
  const { ensureBergamotModelFiles } = require('@qvac/translation-nmtcpp/lib/bergamot-model-fetcher')

  // Check pre-existing local model first
  const relativeDir = '../../model/bergamot/enit'
  const modelDir = path.resolve(__dirname, relativeDir)

  if (fs.existsSync(modelDir)) {
    const files = fs.readdirSync(modelDir)
    const hasIntgemm = files.some(f => f.includes('.intgemm'))
    const hasVocab = files.some(f => f.includes('.spm'))

    if (hasIntgemm && hasVocab) {
      return modelDir
    }
  }

  // Not found locally — download from Firefox CDN
  const writableRoot = isMobile ? (global.testDir || '/tmp') : path.resolve(__dirname, '../..')
  const destDir = path.join(writableRoot, 'model', 'bergamot', 'enit')

  return ensureBergamotModelFiles('en', 'it', destDir)
}

// ============================================================================
// Logger and Status Helpers
// ============================================================================

/**
 * Creates a logger for capturing C++ addon output
 * Routes all log levels to console with prefix for easy identification.
 * Exposes getLevel() so @qvac/logging uses level 'debug' and does not filter debug messages.
 *
 * @returns {Object} Logger object with error, warn, info, debug methods and getLevel
 */
function createLogger () {
  return {
    error: (msg) => console.log('[C++ ERROR]:', msg),
    warn: (msg) => console.log('[C++ WARN]:', msg),
    info: (msg) => console.log('[C++ INFO]:', msg),
    debug: (msg) => console.log('[C++ DEBUG]:', msg)
  }
}

// ============================================================================
// Performance Metrics Helpers
// ============================================================================

/**
 * Creates a performance collector for tracking translation metrics
 * Tracks timing, tokens, and output during streaming translation
 * Can be combined with native addon stats for complete metrics
 *
 * @returns {Object} Collector with tracking methods and metrics getters
 */
function createPerformanceCollector () {
  let startTime = null
  let firstTokenTime = null
  let generatedText = ''

  return {
    /**
     * Sets the start time for performance measurement
     */
    start () {
      startTime = Date.now()
      firstTokenTime = null
      generatedText = ''
    },

    /**
     * Called when new output is received (onUpdate handler)
     * @param {string} data - The output chunk received
     */
    onToken (data) {
      if (firstTokenTime === null && startTime) {
        firstTokenTime = Date.now()
      }
      generatedText += data
    },

    /**
     * Gets the collected metrics after translation completes
     * Fetches computed statistics from native addon
     *
     * @param {string} prompt - The input prompt text
     * @param {Object} [addonStats={}] - Native stats from response.stats (totalTime, totalTokens, decodeTime, TPS)
     * @returns {Object} Performance metrics
     */
    getMetrics (prompt, addonStats = {}) {
      // The pivot addon reports per-sub-model stats under prefixed keys
      // (e.g. "BERGAMOT : ->totalTokens", "BERGAMOT : ->TPS") rather than
      // flat keys, so a naive `addonStats.totalTokens` read returns 0 for
      // pivot rows even though the data is present.
      //
      // We read prefixed values for TOKENS and TPS (better than showing 0
      // or "-"), but NOT for time — when the addon only reports prefix
      // stats, those reflect a single sub-model, and wall-clock time is
      // a more faithful "pivot total time" for the composite operation.
      function _extractStat (key, { allowPrefix = true } = {}) {
        if (addonStats == null) return null
        if (typeof addonStats[key] === 'number') return addonStats[key]
        if (!allowPrefix) return null
        for (const k of Object.keys(addonStats)) {
          if (k === key) return addonStats[k]
          if (k.endsWith('->' + key) || k.endsWith(key)) {
            if (typeof addonStats[k] === 'number') return addonStats[k]
          }
        }
        return null
      }

      // Time columns: flat addon time only. Fall back to wall-clock when
      // the addon omits it (pivot case). For decode, when there is no
      // better signal we approximate decode ≈ total — prompt processing
      // is negligible for short NMT sentences, and the pivot addon fires
      // onUpdate once at the end rather than streaming, so firstTokenTime
      // ≈ completion time.
      const now = Date.now()
      const wallClockTotalMs = startTime ? (now - startTime) : 0

      const addonTotalSec = _extractStat('totalTime', { allowPrefix: false })
      const addonDecodeSec = _extractStat('decodeTime', { allowPrefix: false })

      const totalTimeMs = (addonTotalSec && addonTotalSec > 0)
        ? addonTotalSec * 1000
        : wallClockTotalMs
      const decodeTimeMs = (addonDecodeSec && addonDecodeSec > 0)
        ? addonDecodeSec * 1000
        : totalTimeMs

      // Token count and TPS: accept prefixed values too (pivot). If TPS
      // is missing but tokens + decode are available, compute it so the
      // column is never "0" when data is in fact inferrable.
      const generatedTokens = _extractStat('totalTokens') || 0
      let tps = _extractStat('TPS') || 0
      if (!tps && generatedTokens > 0 && decodeTimeMs > 0) {
        tps = (generatedTokens / decodeTimeMs) * 1000
      }

      return {
        totalTime: totalTimeMs,
        generatedTokens,
        prompt,
        tps,
        fullOutput: generatedText,
        decodeTime: decodeTimeMs
      }
    }
  }
}

/**
 * Formats performance metrics for test output
 * Outputs in a structured format for easy parsing by log analyzers
 *
 * @param {string} label - Test label prefix (e.g., '[Bergamot]')
 * @param {Object} metrics - Metrics object from createPerformanceCollector().getMetrics()
 * @param {Object} [qualityOpts] - Optional translation-quality context
 * @param {string} [qualityOpts.fixturePath] - Path to the ground-truth fixture JSON
 * @param {string} [qualityOpts.srcLang]     - Source language code (matches fixture entry)
 * @param {string} [qualityOpts.dstLang]     - Destination language code (matches fixture entry)
 * @returns {string} Formatted performance metrics string
 */
function formatPerformanceMetrics (label, metrics, qualityOpts) {
  const {
    totalTime,
    generatedTokens,
    prompt,
    tps,
    fullOutput,
    decodeTime
  } = metrics

  const totalTimeMs = typeof totalTime === 'number' ? totalTime : 0
  const totalSeconds = (totalTimeMs / 1000).toFixed(2)
  const tpsValue = typeof tps === 'number' ? tps.toFixed(2) : '0.00'
  const decodeTimeMs = typeof decodeTime === 'number' ? decodeTime : 0

  let quality = null
  if (qualityOpts && qualityOpts.fixturePath && prompt && qualityOpts.srcLang && qualityOpts.dstLang) {
    try {
      const gt = findTranslationGroundTruth(qualityOpts.fixturePath, prompt, qualityOpts.srcLang, qualityOpts.dstLang)
      if (gt) {
        quality = evaluateTranslationQuality(fullOutput || '', gt)
      }
    } catch (err) {
      console.log(`[translation-quality] evaluation failed: ${err.message}`)
    }
  }

  const ep = /\[gpu\]/i.test(label) ? 'gpu' : /\[cpu\]/i.test(label) ? 'cpu' : null

  _perfReporter.record(label, {
    total_time_ms: Math.round(totalTimeMs),
    decode_time_ms: Math.round(decodeTimeMs),
    generated_tokens: generatedTokens || null,
    tps: (typeof tps === 'number' && tps > 0) ? parseFloat(tpsValue) : null,
    chrfpp: quality ? quality.chrfpp : null
  }, {
    execution_provider: ep,
    input: prompt || null,
    output: fullOutput || null,
    // `quality` is duplicated from metrics.chrfpp so that aggregate.js's
    // Quality Summary section (which reads `result.quality.*`) renders a
    // chrF++ column in the HTML/MD mobile + desktop perf-reports. The
    // Step Summary table keeps reading metrics.chrfpp — no behaviour
    // change there.
    quality: quality ? { chrfpp: quality.chrfpp, reference: quality.reference } : null,
    reference: quality ? quality.reference : null
  })
  _scheduleReportWrite()

  // On mobile, the Bare process is hosted inside the native app and
  // typically does not exit between test runs, so `process.on('exit')`
  // never fires. Flush the perf report after every record() so that
  // WDIO's after: hook finds a ready-to-pull perf-report.json in the
  // app's Documents/ (iOS) or /sdcard/.../files/ (Android) directory.
  // Also emit markers to stdout so Device Farm log collection can
  // recover the report via extract-from-log.js if pullFile fails.
  if (isMobile && typeof _perfReporter.writeReport === 'function') {
    try { _perfReporter.writeReport(_reportPath) } catch (_) {}
    if (typeof _perfReporter.writeToConsole === 'function') {
      try { _perfReporter.writeToConsole() } catch (_) {}
    }
  }

  let out = `${label} Performance Metrics:
    - Total time: ${totalTimeMs.toFixed(0)}ms (${totalSeconds}s)
    - Decode time: ${decodeTimeMs.toFixed(2)}ms
    - Generated tokens: ${generatedTokens} tokens
    - Prompt: "${prompt}"
    - Tokens per second (TPS): ${tpsValue} t/s
    - Full output: "${fullOutput}"`

  if (quality && typeof quality.chrfpp === 'number') {
    out += `\n    - chrF++: ${quality.chrfpp.toFixed(4)}`
  }

  return out
}

// ============================================================================
// Module Exports
// ============================================================================

module.exports = {
  // Platform detection
  platform,
  isMobile,

  // Model helpers
  ensureIndicTransModel,
  ensureBergamotModel,

  // Utilities
  createLogger,
  TEST_TIMEOUT,

  // Performance metrics
  createPerformanceCollector,
  formatPerformanceMetrics
}
