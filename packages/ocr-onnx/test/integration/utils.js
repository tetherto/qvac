'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const os = require('bare-os')
const process = require('bare-process')

// Dynamic require via path.join prevents bare-pack from statically resolving
// these paths during mobile bundling (they live outside the addon package).
let createPerformanceReporter, evaluateQuality, findGroundTruth
const _scriptBase = path.join('..', '..', '..', '..', 'scripts', 'test-utils')
try {
  const perfReporterMod = require(path.join(_scriptBase, 'performance-reporter'))
  const qualityMetricsMod = require(path.join(_scriptBase, 'quality-metrics'))
  perfReporterMod.configure({ fs, path, process, os })
  qualityMetricsMod.configure({ fs, path })
  createPerformanceReporter = perfReporterMod.createPerformanceReporter
  evaluateQuality = qualityMetricsMod.evaluateQuality
  findGroundTruth = qualityMetricsMod.findGroundTruth
} catch (_) {
  // Mobile bundle — inline lightweight reporter that records metrics and
  // can output the [PERF_REPORT_START]...[PERF_REPORT_END] markers to
  // console so extract-from-log.js can capture them from Device Farm logs.
  createPerformanceReporter = function (opts) {
    const _results = []
    const _startedAt = new Date().toISOString()
    const _addon = (opts && opts.addon) || 'unknown'
    const _addonType = (opts && opts.addonType) || 'generic'
    const _device = {
      name: platform,
      platform,
      os_version: '',
      arch: os.arch ? os.arch() : '',
      runner: 'device-farm'
    }

    return {
      record (testName, metrics, extra) {
        var entry = {
          test: testName,
          execution_provider: (extra && extra.execution_provider) || null,
          metrics: Object.assign({
            total_time_ms: null,
            detection_time_ms: null,
            recognition_time_ms: null,
            text_regions: null
          }, metrics),
          input: (extra && extra.input) || null,
          output: (extra && extra.output) || null,
          quality: (extra && extra.quality) || undefined
        }
        if (extra && extra.image_path) entry.image_path = extra.image_path
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
      writeReport () {
        var json = JSON.stringify(this.toJSON())
        var written = false
        var dirs = []
        if (global.testDir) dirs.push(global.testDir)
        if (platform === 'android') {
          dirs.push('/sdcard/Android/data/io.tether.test.qvac/files')
          dirs.push('/storage/emulated/0/Android/data/io.tether.test.qvac/files')
          dirs.push('/data/local/tmp')
        }
        dirs.push('/tmp')
        for (var di = 0; di < dirs.length; di++) {
          try {
            try { fs.mkdirSync(dirs[di], { recursive: true }) } catch (_) {}
            var p = path.join(dirs[di], 'perf-report.json')
            fs.writeFileSync(p, json)
            console.log('[PERF_REPORT_PATH]' + p)
            written = true
          } catch (e) {
            console.log('[perf-reporter] write to ' + dirs[di] + ' failed: ' + e.message)
          }
        }
        if (!written) {
          console.log('[perf-reporter] all write locations failed')
        }
      },
      writeStepSummary () {},
      writeToConsole (opts) {
        try {
          var data = this.toJSON()
          var lightweight = opts && opts.lightweight
          data.results = data.results.map(function (r) {
            var q = r.quality
            if (lightweight && q) {
              q = { cer: q.cer, wer: q.wer, word_recognition_rate: q.word_recognition_rate, keyword_detection_rate: q.keyword_detection_rate, key_value_accuracy: q.key_value_accuracy }
            }
            return { test: r.test, execution_provider: r.execution_provider, metrics: r.metrics, quality: q, image_path: r.image_path || null }
          })
          var json = JSON.stringify(data)
          // Android logcat has per-entry size limits that vary by device.
          // Use a conservative chunk size so header + content stays well
          // under any limit, even with the ReactNativeJS wrapper overhead.
          var CHUNK = 800
          if (json.length <= CHUNK) {
            console.log('[PERF_REPORT_START]' + json + '[PERF_REPORT_END]')
          } else {
            var id = Date.now().toString(36)
            var n = Math.ceil(json.length / CHUNK)
            for (var i = 0; i < n; i++) {
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
  // --- Inline quality metrics for mobile (pure computation, no external deps) ---

  function _normalize (text) {
    return String(text).replace(/\r\n/g, '\n').replace(/[\t\v\f]/g, ' ').replace(/ {2,}/g, ' ').trim().toLowerCase()
  }

  function _tokenize (text) {
    return _normalize(text).split(/\s+/).filter(Boolean)
  }

  function _levenshtein (a, b) {
    var m = a.length
    var n = b.length
    if (m === 0) return n
    if (n === 0) return m
    var prev = new Array(n + 1)
    var curr = new Array(n + 1)
    var j, i
    for (j = 0; j <= n; j++) prev[j] = j
    for (i = 1; i <= m; i++) {
      curr[0] = i
      for (j = 1; j <= n; j++) {
        var cost = a[i - 1] === b[j - 1] ? 0 : 1
        curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost)
      }
      var tmp = prev; prev = curr; curr = tmp
    }
    return prev[n]
  }

  function _round4 (v) { return Math.round(v * 10000) / 10000 }

  evaluateQuality = function (ocrTexts, groundTruth) {
    if (!groundTruth) return null
    var texts = Array.isArray(ocrTexts) ? ocrTexts : [String(ocrTexts)]
    var joined = texts.join(' ')
    var gt = groundTruth
    var result = { ground_truth_id: gt.id || null, description: gt.description || null }

    if (gt.reference_text) {
      var hTokens = _tokenize(joined).sort()
      var rTokens = _tokenize(gt.reference_text).sort()
      var h = hTokens.join(' ')
      var r = rTokens.join(' ')
      result.cer = _round4(r.length === 0 ? (h.length === 0 ? 0 : 1) : _levenshtein(h, r) / r.length)
      result.wer = _round4(rTokens.length === 0 ? (hTokens.length === 0 ? 0 : 1) : _levenshtein(hTokens, rTokens) / rTokens.length)

      var ocrLower = joined.toLowerCase()
      var uniqueRef = {}
      for (var ri = 0; ri < rTokens.length; ri++) { uniqueRef[rTokens[ri]] = true }
      var refList = Object.keys(uniqueRef)
      var wrrMatched = 0
      var wrrMissed = []
      for (var wri = 0; wri < refList.length; wri++) {
        if (ocrLower.indexOf(refList[wri]) >= 0) wrrMatched++
        else wrrMissed.push(refList[wri])
      }
      result.word_recognition_rate = _round4(refList.length > 0 ? wrrMatched / refList.length : 1)
      result.words_recognized = wrrMatched
      result.words_total = refList.length
      result.words_missed = wrrMissed
    }

    if (gt.required_keywords && gt.required_keywords.length > 0) {
      var lower = joined.toLowerCase()
      var wordSet = {}
      var _words = lower.split(/\s+/)
      for (var wi = 0; wi < _words.length; wi++) { if (_words[wi]) wordSet[_words[wi]] = true }
      var found = []
      var missing = []
      for (var ki = 0; ki < gt.required_keywords.length; ki++) {
        var kwTarget = gt.required_keywords[ki].toLowerCase()
        var kwMatch = lower.includes(kwTarget)
        if (!kwMatch) {
          var kwParts = kwTarget.split(/\s+/)
          kwMatch = true
          for (var kp = 0; kp < kwParts.length; kp++) {
            if (kwParts[kp] && !wordSet[kwParts[kp]]) { kwMatch = false; break }
          }
        }
        if (kwMatch) found.push(gt.required_keywords[ki])
        else missing.push(gt.required_keywords[ki])
      }
      result.keyword_detection_rate = _round4(found.length / gt.required_keywords.length)
      result.keywords_found = found.length
      result.keywords_total = gt.required_keywords.length
      result.keywords_missing = missing
    }

    if (gt.key_values && gt.key_values.length > 0) {
      var lowerKV = joined.toLowerCase()
      var kvWordSet = {}
      var _kvWords = lowerKV.split(/\s+/)
      for (var wj = 0; wj < _kvWords.length; wj++) { if (_kvWords[wj]) kvWordSet[_kvWords[wj]] = true }
      var matched = []
      var unmatched = []
      for (var vi = 0; vi < gt.key_values.length; vi++) {
        var pair = gt.key_values[vi]
        var kvKeyLower = pair.key.toLowerCase()
        var keyFound = lowerKV.includes(kvKeyLower)
        if (!keyFound) {
          var keyParts = kvKeyLower.split(/\s+/)
          keyFound = true
          for (var kpi = 0; kpi < keyParts.length; kpi++) {
            if (keyParts[kpi] && !kvWordSet[keyParts[kpi]]) { keyFound = false; break }
          }
        }
        var valueFound = lowerKV.includes(String(pair.value).toLowerCase())
        if (keyFound && valueFound) matched.push(pair)
        else unmatched.push({ key: pair.key, value: pair.value, key_found: keyFound, value_found: valueFound })
      }
      result.key_value_accuracy = _round4(matched.length / gt.key_values.length)
      result.key_values_matched = matched.length
      result.key_values_total = gt.key_values.length
      result.key_values_unmatched = unmatched
    }

    return result
  }

  findGroundTruth = function (imagePath) {
    var base = path.basename(imagePath).replace(/\.[^.]+$/, '')
    var gtFilename = base + '.quality.json'

    // On mobile, look for ground truth in global.assetPaths
    if (global.assetPaths) {
      var assetKey = '../../testAssets/' + gtFilename
      var gtPath = global.assetPaths[assetKey]
      if (gtPath) {
        try {
          var raw = fs.readFileSync(gtPath.replace('file://', ''), 'utf-8')
          return JSON.parse(raw)
        } catch (e) {
          console.log('[quality] failed to load mobile ground truth: ' + e.message)
        }
      }
    }

    // Fallback: look relative to imagePath (same logic as desktop)
    var dir = path.dirname(imagePath)
    var candidates = [
      path.join(dir, gtFilename),
      path.join(dir, '..', 'quality', gtFilename),
      path.join(dir, 'quality', gtFilename)
    ]
    for (var ci = 0; ci < candidates.length; ci++) {
      try {
        var exists = false
        try { fs.statSync(candidates[ci]); exists = true } catch (_) {}
        if (exists) {
          var data = fs.readFileSync(candidates[ci], 'utf-8')
          return JSON.parse(data)
        }
      } catch (_) {}
    }
    return null
  }
}

const platform = os.platform()
const isMobile = platform === 'ios' || platform === 'android'
const isWindows = platform === 'win32'

// Singleton performance reporter — collects metrics across all OCR integration tests
const _perfReporter = createPerformanceReporter({
  addon: 'ocr-onnx',
  addonType: 'ocr'
})

const _reportPath = path.resolve('.', 'test/results/performance-report.json')
let _reportScheduled = false

function _flushPerfReport () {
  if (_perfReporter.length > 0) {
    _perfReporter.writeReport(_reportPath)
    _perfReporter.writeToConsole()
  }
}

function _scheduleReportWrite () {
  if (_reportScheduled) return
  _reportScheduled = true
  process.on('exit', _flushPerfReport)
}

// Windows CI runners have limited memory (~7GB): use BASIC optimization,
// disable BFC arena pre-allocation, and limit to 1 thread to reduce
// per-thread scratch buffer memory. XNNPACK is left disabled (default)
// to be consistent with all other platforms.
const windowsOrtParams = isWindows
  ? { graphOptimization: 'basic', enableCpuMemArena: false, intraOpThreads: 1 }
  : {}

// DocTR model download URLs and SHA-256 checksums from OnnxTR GitHub releases
const DOCTR_MODELS = {
  'db_resnet50.onnx': {
    url: 'https://github.com/felixdittrich92/OnnxTR/releases/download/v0.0.1/db_resnet50-69ba0015.onnx',
    sha256: '69ba00155c16b198d062f5a7b9cdb446c82aed81812d7ff5a74e01ab41421d55'
  },
  'parseq.onnx': {
    url: 'https://github.com/felixdittrich92/OnnxTR/releases/download/v0.0.1/parseq-00b40714.onnx',
    sha256: '00b40714e00039c8c04891e5fd98ad5cb46c34fa7133ba09e2a55d4b28d42a68'
  },
  'db_mobilenet_v3_large.onnx': {
    url: 'https://github.com/felixdittrich92/OnnxTR/releases/download/v0.2.0/db_mobilenet_v3_large-4987e7bd.onnx',
    sha256: '4987e7bdea372559808bd5add85fda10e179dc639696fb489e59a197a25b4c64'
  },
  'crnn_mobilenet_v3_small.onnx': {
    url: 'https://github.com/felixdittrich92/OnnxTR/releases/download/v0.0.1/crnn_mobilenet_v3_small-bded4d49.onnx',
    sha256: 'bded4d49b3e91dac24591ed4f0af3de4c3baab1f9cc07e8e7dc07c9ba66b3b33'
  }
}

// Backwards-compatible URL lookup
const DOCTR_MODEL_URLS = Object.fromEntries(
  Object.entries(DOCTR_MODELS).map(([k, v]) => [k, v.url])
)

const DOCTR_MODELS_DIR = isMobile
  ? path.join(global.testDir || '/tmp', 'doctr-models')
  : path.resolve('.', 'test/models/doctr')

// Mapping from original filename to renamed filename for mobile
// Files are renamed to avoid Android resource merger conflicts (same base name, different extension)
const mobileAssetMapping = {
  'basic_test.bmp': 'basic_test_bmp.bmp',
  'basic_test.jpg': 'basic_test_jpg.jpg',
  'basic_test.png': 'basic_test_png.png'
}

/**
 * Get path to a test asset (image or config file) - works on both desktop and mobile
 * @param {string} relativePath - Relative path from root (e.g., '/test/images/basic_test.bmp')
 * @returns {string} Full path to the file
 */
function getImagePath (relativePath) {
  if (isMobile && global.assetPaths) {
    const originalFilename = path.basename(relativePath)
    // Use renamed filename if mapping exists, otherwise use original
    const filename = mobileAssetMapping[originalFilename] || originalFilename
    const projectPath = `../../testAssets/${filename}`

    if (global.assetPaths[projectPath]) {
      return global.assetPaths[projectPath].replace('file://', '')
    }
    throw new Error(`Asset not found in testAssets: ${filename} (original: ${originalFilename})`)
  }

  return path.resolve('.') + relativePath
}

/**
 * Downloads a file from a URL using bare-fetch
 * @param {string} url - URL to download from
 * @param {string} destPath - Destination file path
 */
async function downloadFile (url, destPath) {
  const fetch = require('bare-fetch')
  console.log(`   Downloading: ${url.substring(0, 60)}...`)

  const response = await fetch(url)

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`)
  }

  const buffer = await response.arrayBuffer()
  fs.writeFileSync(destPath, Buffer.from(buffer))
  console.log(`   Downloaded: ${path.basename(destPath)}`)
}

/**
 * Computes SHA-256 hash of a buffer
 * @param {Buffer} buffer
 * @returns {string} hex digest
 */
function sha256 (buffer) {
  const crypto = require('bare-crypto')
  const hash = crypto.createHash('sha256')
  hash.update(buffer)
  return hash.digest('hex')
}

/**
 * Resolves the download URL for a DocTR model.
 * On mobile, checks ocr-model-urls.json first (supports S3 presigned URLs),
 * then falls back to the hardcoded GitHub release URL.
 */
function _resolveDoctrUrl (filename) {
  const model = DOCTR_MODELS[filename]
  if (!model) return null

  if (!isMobile) return model.url

  const jsonKey = 'doctr_' + filename.replace('.onnx', '') + '_url'
  let urlConfig = null
  if (global.assetPaths) {
    const configPath = global.assetPaths['../../testAssets/ocr-model-urls.json']
    if (configPath) {
      try {
        urlConfig = JSON.parse(fs.readFileSync(configPath.replace('file://', ''), 'utf8'))
      } catch (_) {}
    }
  }
  if (!urlConfig) {
    for (const p of ['../../testAssets/ocr-model-urls.json', '../testAssets/ocr-model-urls.json']) {
      if (fs.existsSync(p)) {
        try { urlConfig = JSON.parse(fs.readFileSync(p, 'utf8')); break } catch (_) {}
      }
    }
  }
  if (urlConfig && urlConfig[jsonKey]) return urlConfig[jsonKey]
  return model.url
}

/**
 * Downloads a single DocTR model if not already cached.
 * Downloads from OnnxTR GitHub releases with retry on transient errors.
 * On mobile, checks ocr-model-urls.json first for presigned/alternative URLs.
 * Verifies SHA-256 checksum after download.
 * @param {string} filename - Model filename (e.g., 'db_resnet50.onnx')
 */
async function downloadDoctrModel (filename) {
  const destPath = path.join(DOCTR_MODELS_DIR, filename)
  if (fs.existsSync(destPath)) return

  const model = DOCTR_MODELS[filename]
  if (!model) throw new Error(`No download URL for DocTR model: ${filename}`)

  const downloadUrl = _resolveDoctrUrl(filename)
  console.log(`Downloading ${filename}...`)
  console.log(`   URL: ${downloadUrl.substring(0, 80)}...`)

  const fetch = require('bare-fetch')
  const maxAttempts = isMobile ? 5 : 3
  let lastError
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetch(downloadUrl)
      if (!response.ok) throw new Error(`HTTP ${response.status} downloading ${filename}`)
      const buffer = Buffer.from(await response.arrayBuffer())
      if (model.sha256) {
        const actual = sha256(buffer)
        if (actual !== model.sha256) {
          throw new Error(`Checksum mismatch for ${filename}: expected ${model.sha256}, got ${actual}`)
        }
        console.log(`   Checksum verified: ${filename}`)
      }
      fs.writeFileSync(destPath, buffer)
      console.log(`Downloaded ${filename} (${Math.round(buffer.byteLength / 1024 / 1024)}MB)`)
      return
    } catch (e) {
      lastError = e
      if (attempt < maxAttempts) {
        const delayMs = isMobile ? attempt * 10000 : attempt * 5000
        console.log(`   Attempt ${attempt}/${maxAttempts} failed: ${e.message}. Retrying in ${delayMs / 1000}s...`)
        await new Promise(resolve => setTimeout(resolve, delayMs))
      }
    }
  }
  throw lastError
}

/**
 * Ensures all requested DocTR models are available.
 * Downloads from OnnxTR GitHub releases if not already present.
 * On mobile, returns null instead of crashing if downloads fail
 * (Device Farm has intermittent connectivity to GitHub releases).
 * @param {string[]} [models] - Model filenames to ensure. Defaults to all 4 models.
 * @returns {Promise<Object|null>} Map of model name (without extension) to full path, or null on mobile failure
 */
async function ensureDoctrModels (models) {
  if (!models) models = Object.keys(DOCTR_MODEL_URLS)
  fs.mkdirSync(DOCTR_MODELS_DIR, { recursive: true })

  for (const filename of models) {
    try {
      await downloadDoctrModel(filename)
    } catch (e) {
      if (isMobile) {
        console.log(`[ensureDoctrModels] Failed to download ${filename}: ${e.message}`)
        console.log('[ensureDoctrModels] Returning null — DocTR tests will be skipped on this device')
        return null
      }
      throw e
    }
  }
  const paths = {}
  for (const filename of models) {
    const key = filename.replace('.onnx', '')
    paths[key] = path.join(DOCTR_MODELS_DIR, filename)
  }
  return paths
}

/**
 * Ensures OCR model is available and returns its path
 * On mobile: downloads from presigned URLs bundled in testAssets
 * On desktop: returns the relative path (models should be pre-downloaded by CI)
 *
 * @param {string} modelName - Model name (e.g., 'detector_craft' or 'recognizer_latin')
 * @returns {Promise<string>} Path to the model file
 */
async function ensureModelPath (modelName) {
  const modelFilename = `${modelName}.onnx`
  // Models are now in rec_dyn subdirectory (dynamic width models)
  const relativePath = `models/ocr/rec_dyn/${modelFilename}`

  if (!isMobile) {
    const fullPath = path.resolve('.', relativePath)
    if (!fs.existsSync(fullPath)) {
      console.log(`Warning: Model not found at ${fullPath}`)
    }
    return relativePath
  }

  const writableRoot = global.testDir || '/tmp'
  const modelsDir = path.join(writableRoot, 'ocr-models')
  const destPath = path.join(modelsDir, modelFilename)

  if (fs.existsSync(destPath)) {
    console.log(`   Model cached: ${modelFilename}`)
    return destPath
  }

  let urlConfig = null

  if (global.assetPaths) {
    const configPath = global.assetPaths['../../testAssets/ocr-model-urls.json']
    if (configPath) {
      try {
        const configData = fs.readFileSync(configPath.replace('file://', ''), 'utf8')
        urlConfig = JSON.parse(configData)
      } catch (e) {
        console.log(`   Failed to load config from assetPaths: ${e.message}`)
      }
    }
  }

  if (!urlConfig) {
    const fallbackPaths = [
      '../../testAssets/ocr-model-urls.json',
      '../testAssets/ocr-model-urls.json',
      'testAssets/ocr-model-urls.json'
    ]
    for (const fallbackPath of fallbackPaths) {
      if (fs.existsSync(fallbackPath)) {
        try {
          urlConfig = JSON.parse(fs.readFileSync(fallbackPath, 'utf8'))
          break
        } catch (e) {
          console.log(`   Failed to parse ${fallbackPath}: ${e.message}`)
        }
      }
    }
  }

  if (!urlConfig) {
    throw new Error('OCR model URLs config not found - cannot download models on mobile')
  }

  let downloadUrl = null
  if (modelName.includes('detector')) {
    downloadUrl = urlConfig.detectorUrl
  } else {
    const match = modelName.match(/recognizer_(\w+)/)
    if (match) {
      const recognizerType = match[1]
      downloadUrl = urlConfig[`recognizer_${recognizerType}_url`]
    }
  }

  if (!downloadUrl) {
    throw new Error(`No presigned URL found for model: ${modelName}`)
  }

  fs.mkdirSync(modelsDir, { recursive: true })
  await downloadFile(downloadUrl, destPath)

  return destPath
}

/**
 * Formats OCR performance metrics for test output
 * Outputs in a structured format for easy parsing by log analyzers
 *
 * @param {string} label - Test label prefix (e.g., '[OCR] [GPU]')
 * @param {Object} stats - Stats object from response.stats
 * @param {Array} outputTexts - Array of detected texts
 * @returns {string} Formatted performance metrics string
 */
/**
 * Formats OCR performance metrics for test output.
 *
 * @param {string} label - Test label prefix (e.g., '[OCR] [GPU]')
 * @param {Object} stats - Stats object from response.stats
 * @param {Array} outputTexts - Array of detected texts
 * @param {Object} [opts] - Optional settings
 * @param {string} [opts.imagePath] - Path to the source image (triggers quality evaluation)
 * @param {Object} [opts.groundTruth] - Explicit ground truth (overrides auto-discovery)
 * @returns {string} Formatted performance metrics string
 */
function formatOCRPerformanceMetrics (label, stats, outputTexts = [], opts) {
  const totalTimeMs = stats.totalTime ? stats.totalTime * 1000 : 0
  const detectionTimeMs = stats.detectionTime ? stats.detectionTime * 1000 : 0
  const recognitionTimeMs = stats.recognitionTime ? stats.recognitionTime * 1000 : 0
  const textRegionsCount = stats.textRegionsCount || 0
  const totalSeconds = (totalTimeMs / 1000).toFixed(2)

  const ep = /\[gpu\]/i.test(label) ? 'gpu' : /\[cpu\]/i.test(label) ? 'cpu' : null

  let quality = null
  const gt = (opts && opts.groundTruth) || (opts && opts.imagePath ? findGroundTruth(opts.imagePath) : null)
  if (gt && outputTexts.length > 0) {
    try {
      quality = evaluateQuality(outputTexts, gt)
    } catch (err) {
      console.log(`[quality] evaluation failed: ${err.message}`)
    }
  }

  if (!(opts && opts.skipReport)) {
    _perfReporter.record(label, {
      total_time_ms: Math.round(totalTimeMs),
      detection_time_ms: Math.round(detectionTimeMs),
      recognition_time_ms: Math.round(recognitionTimeMs),
      text_regions: textRegionsCount
    }, {
      execution_provider: ep,
      output: JSON.stringify(outputTexts),
      quality,
      image_path: (opts && opts.imagePath) || null
    })
    _scheduleReportWrite()

    if (isMobile) {
      _perfReporter.writeReport()
      const isCheckpoint = _perfReporter.length % 6 === 0
      _perfReporter.writeToConsole({ lightweight: !isCheckpoint })
    }
  }

  let out = `${label} Performance Metrics:
    - Total time: ${totalTimeMs.toFixed(0)}ms (${totalSeconds}s)
    - Detection time: ${detectionTimeMs.toFixed(0)}ms
    - Recognition time: ${recognitionTimeMs.toFixed(0)}ms
    - Text regions detected: ${textRegionsCount}
    - Detected texts: ${JSON.stringify(outputTexts)}`

  if (quality) {
    out += '\n    --- Quality ---'
    if (quality.cer !== undefined) out += `\n    - CER: ${(quality.cer * 100).toFixed(1)}%`
    if (quality.wer !== undefined) out += `\n    - WER: ${(quality.wer * 100).toFixed(1)}%`
    if (quality.word_recognition_rate !== undefined) {
      out += `\n    - Word Recognition: ${quality.words_recognized}/${quality.words_total} (${(quality.word_recognition_rate * 100).toFixed(1)}%)`
    }
    if (quality.keyword_detection_rate !== undefined) {
      out += `\n    - Keywords: ${quality.keywords_found}/${quality.keywords_total} (${(quality.keyword_detection_rate * 100).toFixed(1)}%)`
    }
    if (quality.key_value_accuracy !== undefined) {
      out += `\n    - KV Accuracy: ${quality.key_values_matched}/${quality.key_values_total} (${(quality.key_value_accuracy * 100).toFixed(1)}%)`
    }
    if (quality.keywords_missing && quality.keywords_missing.length > 0) {
      out += `\n    - Missing keywords: ${JSON.stringify(quality.keywords_missing)}`
    }
    if (quality.key_values_unmatched && quality.key_values_unmatched.length > 0) {
      const unmatchedKeys = quality.key_values_unmatched.map(u => u.key)
      out += `\n    - Unmatched KV keys: ${JSON.stringify(unmatchedKeys)}`
    }
  }

  return out
}

/**
 * Safely unloads an OCR instance with a timeout to prevent hangs.
 * ONNX Runtime cleanup can sometimes hang on certain platforms,
 * so we race unload() against a timeout and move on if it stalls.
 *
 * @param {Object} onnxOcr - The ONNXOcr instance to unload
 * @param {number} [timeoutMs=10000] - Max time to wait for unload
 * @returns {Promise<void>}
 */
async function safeUnload (onnxOcr, timeoutMs = 10000) {
  try {
    let timeoutId
    const unloadPromise = onnxOcr.unload()
    const timeoutPromise = new Promise((resolve) => {
      timeoutId = setTimeout(() => {
        console.log('Warning: unload() did not complete within ' + timeoutMs + 'ms, continuing...')
        resolve()
      }, timeoutMs)
    })
    await Promise.race([unloadPromise, timeoutPromise])
    clearTimeout(timeoutId)
  } catch (e) {
    console.log('unload() error: ' + e.message)
  }
}

/**
 * Helper to run a single DocTR OCR pass and return results
 * @param {Object} t - brittle test handle
 * @param {Object} params - OCR params (pathDetector, pathRecognizer, etc.)
 * @param {string} imagePath - Path to the image file
 * @returns {Promise<{results: Array, stats: Object}>}
 */
async function runDoctrOCR (t, params, imagePath) {
  const { ONNXOcr } = require('../..')

  const onnxOcr = new ONNXOcr({
    params: {
      langList: ['en'],
      useGPU: false,
      ...windowsOrtParams,
      pipelineMode: 'doctr',
      ...params
    },
    opts: { stats: true }
  })

  await onnxOcr.load()
  console.log('[runDoctrOCR] loaded, starting run...')

  try {
    const response = await onnxOcr.run({
      path: imagePath,
      options: { paragraph: false }
    })
    console.log('[runDoctrOCR] run() returned, awaiting results...')

    let results = []

    await response
      .onUpdate(output => {
        t.ok(Array.isArray(output), 'output should be an array')
        console.log('[runDoctrOCR] onUpdate: got ' + output.length + ' items')
        results = output.map(o => ({ text: o[1], confidence: o[2], bbox: o[0] }))
        console.log('[runDoctrOCR] onUpdate: mapped ' + results.length + ' results')
      })
      .onError(error => {
        t.fail('unexpected error: ' + JSON.stringify(error))
      })
      .await()

    console.log('[runDoctrOCR] await() completed, returning results')
    return { results, stats: response.stats || {} }
  } finally {
    await safeUnload(onnxOcr)
    // Allow ONNX Runtime to fully clean up async operations before next test
    await new Promise(resolve => setTimeout(resolve, 2000))
  }
}

module.exports = {
  isMobile,
  isWindows,
  windowsOrtParams,
  platform,
  getImagePath,
  ensureModelPath,
  ensureDoctrModels,
  DOCTR_MODELS_DIR,
  formatOCRPerformanceMetrics,
  safeUnload,
  runDoctrOCR,
  flushPerfReport: _flushPerfReport
}
