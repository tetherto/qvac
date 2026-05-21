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
        const entry = {
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
        const json = JSON.stringify(this.toJSON())
        let written = false
        const dirs = []
        if (global.testDir) dirs.push(global.testDir)
        if (platform === 'android') {
          dirs.push('/sdcard/Android/data/io.tether.test.qvac/files')
          dirs.push('/storage/emulated/0/Android/data/io.tether.test.qvac/files')
          dirs.push('/data/local/tmp')
        }
        dirs.push('/tmp')
        for (let di = 0; di < dirs.length; di++) {
          try {
            try { fs.mkdirSync(dirs[di], { recursive: true }) } catch (_) {}
            const p = path.join(dirs[di], 'perf-report.json')
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
          const data = this.toJSON()
          const lightweight = opts && opts.lightweight
          data.results = data.results.map(function (r) {
            let q = r.quality
            if (lightweight && q) {
              q = { cer: q.cer, wer: q.wer, word_recognition_rate: q.word_recognition_rate, keyword_detection_rate: q.keyword_detection_rate, key_value_accuracy: q.key_value_accuracy }
            }
            return { test: r.test, execution_provider: r.execution_provider, metrics: r.metrics, quality: q, image_path: r.image_path || null }
          })
          const json = JSON.stringify(data)
          // Android logcat has per-entry size limits that vary by device.
          // Use a conservative chunk size so header + content stays well
          // under any limit, even with the ReactNativeJS wrapper overhead.
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
  // --- Inline quality metrics for mobile (pure computation, no external deps) ---

  function _normalize (text) {
    return String(text).replace(/\r\n/g, '\n').replace(/[\t\v\f]/g, ' ').replace(/ {2,}/g, ' ').trim().toLowerCase()
  }

  function _tokenize (text) {
    return _normalize(text).split(/\s+/).filter(Boolean)
  }

  function _levenshtein (a, b) {
    const m = a.length
    const n = b.length
    if (m === 0) return n
    if (n === 0) return m
    let prev = new Array(n + 1)
    let curr = new Array(n + 1)
    let j, i
    for (j = 0; j <= n; j++) prev[j] = j
    for (i = 1; i <= m; i++) {
      curr[0] = i
      for (j = 1; j <= n; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1
        curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost)
      }
      const tmp = prev; prev = curr; curr = tmp
    }
    return prev[n]
  }

  function _round4 (v) { return Math.round(v * 10000) / 10000 }

  evaluateQuality = function (ocrTexts, groundTruth) {
    if (!groundTruth) return null
    const texts = Array.isArray(ocrTexts) ? ocrTexts : [String(ocrTexts)]
    const joined = texts.join(' ')
    const gt = groundTruth
    const result = { ground_truth_id: gt.id || null, description: gt.description || null }

    if (gt.reference_text) {
      const hTokens = _tokenize(joined).sort()
      const rTokens = _tokenize(gt.reference_text).sort()
      const h = hTokens.join(' ')
      const r = rTokens.join(' ')
      result.cer = _round4(r.length === 0 ? (h.length === 0 ? 0 : 1) : _levenshtein(h, r) / r.length)
      result.wer = _round4(rTokens.length === 0 ? (hTokens.length === 0 ? 0 : 1) : _levenshtein(hTokens, rTokens) / rTokens.length)

      const ocrLower = joined.toLowerCase()
      const uniqueRef = {}
      for (let ri = 0; ri < rTokens.length; ri++) { uniqueRef[rTokens[ri]] = true }
      const refList = Object.keys(uniqueRef)
      let wrrMatched = 0
      const wrrMissed = []
      for (let wri = 0; wri < refList.length; wri++) {
        if (ocrLower.indexOf(refList[wri]) >= 0) wrrMatched++
        else wrrMissed.push(refList[wri])
      }
      result.word_recognition_rate = _round4(refList.length > 0 ? wrrMatched / refList.length : 1)
      result.words_recognized = wrrMatched
      result.words_total = refList.length
      result.words_missed = wrrMissed
    }

    if (gt.required_keywords && gt.required_keywords.length > 0) {
      const lower = joined.toLowerCase()
      const wordSet = {}
      const _words = lower.split(/\s+/)
      for (let wi = 0; wi < _words.length; wi++) { if (_words[wi]) wordSet[_words[wi]] = true }
      const found = []
      const missing = []
      for (let ki = 0; ki < gt.required_keywords.length; ki++) {
        const kwTarget = gt.required_keywords[ki].toLowerCase()
        let kwMatch = lower.includes(kwTarget)
        if (!kwMatch) {
          const kwParts = kwTarget.split(/\s+/)
          kwMatch = true
          for (let kp = 0; kp < kwParts.length; kp++) {
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
      const lowerKV = joined.toLowerCase()
      const kvWordSet = {}
      const _kvWords = lowerKV.split(/\s+/)
      for (let wj = 0; wj < _kvWords.length; wj++) { if (_kvWords[wj]) kvWordSet[_kvWords[wj]] = true }
      const matched = []
      const unmatched = []
      for (let vi = 0; vi < gt.key_values.length; vi++) {
        const pair = gt.key_values[vi]
        const kvKeyLower = pair.key.toLowerCase()
        let keyFound = lowerKV.includes(kvKeyLower)
        if (!keyFound) {
          const keyParts = kvKeyLower.split(/\s+/)
          keyFound = true
          for (let kpi = 0; kpi < keyParts.length; kpi++) {
            if (keyParts[kpi] && !kvWordSet[keyParts[kpi]]) { keyFound = false; break }
          }
        }
        const valueFound = lowerKV.includes(String(pair.value).toLowerCase())
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
    const base = path.basename(imagePath).replace(/\.[^.]+$/, '')
    const gtFilename = base + '.quality.json'

    // On mobile, look for ground truth in global.assetPaths
    if (global.assetPaths) {
      const assetKey = '../../testAssets/' + gtFilename
      const gtPath = global.assetPaths[assetKey]
      if (gtPath) {
        try {
          const raw = fs.readFileSync(gtPath.replace('file://', ''), 'utf-8')
          return JSON.parse(raw)
        } catch (e) {
          console.log('[quality] failed to load mobile ground truth: ' + e.message)
        }
      }
    }

    // Fallback: look relative to imagePath (same logic as desktop)
    const dir = path.dirname(imagePath)
    const candidates = [
      path.join(dir, gtFilename),
      path.join(dir, '..', 'quality', gtFilename),
      path.join(dir, 'quality', gtFilename)
    ]
    for (let ci = 0; ci < candidates.length; ci++) {
      try {
        let exists = false
        try { fs.statSync(candidates[ci]); exists = true } catch (_) {}
        if (exists) {
          const data = fs.readFileSync(candidates[ci], 'utf-8')
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
  addon: 'ocr-ggml',
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

// Writable directory for downloaded models on mobile
const GGML_MODELS_DIR = isMobile
  ? path.join(global.testDir || '/tmp', 'ggml-models')
  : path.resolve('.', 'models')

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
 * Loads the ocr-ggml-model-urls.json config on mobile.
 * Checks global.assetPaths first, then falls back to known filesystem paths.
 * @returns {Object|null} Parsed URL config or null if not found
 */
function _loadMobileUrlConfig () {
  let urlConfig = null
  if (global.assetPaths) {
    const configPath = global.assetPaths['../../testAssets/ocr-ggml-model-urls.json']
    if (configPath) {
      try {
        urlConfig = JSON.parse(fs.readFileSync(configPath.replace('file://', ''), 'utf8'))
      } catch (_) {}
    }
  }
  if (!urlConfig) {
    for (const p of ['../../testAssets/ocr-ggml-model-urls.json', '../testAssets/ocr-ggml-model-urls.json']) {
      if (fs.existsSync(p)) {
        try { urlConfig = JSON.parse(fs.readFileSync(p, 'utf8')); break } catch (_) {}
      }
    }
  }
  return urlConfig
}

/**
 * Ensures an EasyOCR GGUF model is available and returns its path.
 * On desktop: uses env vars (OCR_GGML_DETECTOR / OCR_GGML_RECOGNIZER) or defaults.
 * On mobile: downloads from presigned URLs in ocr-ggml-model-urls.json.
 *
 * @param {string} modelName - 'detector_craft' or 'recognizer_latin'
 * @returns {Promise<string>} Path to the model file
 */
async function ensureModelPath (modelName) {
  const desktopDefaults = {
    detector_craft: process.env.OCR_GGML_DETECTOR || 'models/craft_mlt_25k.gguf',
    recognizer_latin: process.env.OCR_GGML_RECOGNIZER || 'models/latin_g2.gguf'
  }

  if (!isMobile) {
    const modelPath = desktopDefaults[modelName] || `models/${modelName}.gguf`
    if (!fs.existsSync(modelPath)) {
      console.log(`Warning: Model not found at ${modelPath}`)
    }
    return modelPath
  }

  const mobileFilenames = {
    detector_craft: 'craft_mlt_25k.gguf',
    recognizer_latin: 'latin_g2.gguf'
  }
  const mobileUrlKeys = {
    detector_craft: 'craft_mlt_25k_url',
    recognizer_latin: 'latin_g2_url'
  }

  const filename = mobileFilenames[modelName]
  const urlKey = mobileUrlKeys[modelName]
  if (!filename) throw new Error(`Unknown model name for mobile: ${modelName}`)

  const destPath = path.join(GGML_MODELS_DIR, filename)
  if (fs.existsSync(destPath)) {
    console.log(`   Model cached: ${filename}`)
    return destPath
  }

  const urlConfig = _loadMobileUrlConfig()
  if (!urlConfig || !urlConfig[urlKey]) {
    throw new Error(`No presigned URL found for model: ${modelName} (key: ${urlKey})`)
  }

  fs.mkdirSync(GGML_MODELS_DIR, { recursive: true })
  const maxAttempts = 5
  let lastError
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await downloadFile(urlConfig[urlKey], destPath)
      return destPath
    } catch (e) {
      lastError = e
      if (attempt < maxAttempts) {
        const delayMs = attempt * 10000
        console.log(`   Attempt ${attempt}/${maxAttempts} failed: ${e.message}. Retrying in ${delayMs / 1000}s...`)
        await new Promise(resolve => setTimeout(resolve, delayMs))
      }
    }
  }
  throw lastError
}

/**
 * Ensures DocTR GGUF models are available and returns their paths.
 * On desktop: uses env vars (OCR_GGML_DOCTR_DETECTOR / OCR_GGML_DOCTR_RECOGNIZER) or defaults.
 * On mobile: downloads from presigned URLs in ocr-ggml-model-urls.json.
 * Returns null on mobile if downloads fail (Device Farm connectivity issues).
 *
 * @returns {Promise<{db_mobilenet_v3_large: string, crnn_mobilenet_v3_small: string}|null>}
 */
async function ensureDoctrModels () {
  if (!isMobile) {
    return {
      db_mobilenet_v3_large: process.env.OCR_GGML_DOCTR_DETECTOR || 'models/db_mobilenet_v3_large.gguf',
      crnn_mobilenet_v3_small: process.env.OCR_GGML_DOCTR_RECOGNIZER || 'models/crnn_mobilenet_v3_small.gguf'
    }
  }

  const mobileModels = {
    db_mobilenet_v3_large: { filename: 'db_mobilenet_v3_large.gguf', urlKey: 'db_mobilenet_v3_large_url' },
    crnn_mobilenet_v3_small: { filename: 'crnn_mobilenet_v3_small.gguf', urlKey: 'crnn_mobilenet_v3_small_url' }
  }

  const urlConfig = _loadMobileUrlConfig()
  fs.mkdirSync(GGML_MODELS_DIR, { recursive: true })

  const paths = {}
  for (const [key, { filename, urlKey }] of Object.entries(mobileModels)) {
    const destPath = path.join(GGML_MODELS_DIR, filename)
    if (fs.existsSync(destPath)) {
      paths[key] = destPath
      continue
    }
    if (!urlConfig || !urlConfig[urlKey]) {
      console.log(`[ensureDoctrModels] No URL for ${filename} — DocTR tests will be skipped`)
      return null
    }
    const maxAttempts = 5
    let downloaded = false
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await downloadFile(urlConfig[urlKey], destPath)
        downloaded = true
        break
      } catch (e) {
        if (attempt < maxAttempts) {
          const delayMs = attempt * 10000
          console.log(`   Attempt ${attempt}/${maxAttempts} failed: ${e.message}. Retrying in ${delayMs / 1000}s...`)
          await new Promise(resolve => setTimeout(resolve, delayMs))
        } else {
          console.log(`[ensureDoctrModels] Failed to download ${filename}: ${e.message}`)
          console.log('[ensureDoctrModels] Returning null — DocTR tests will be skipped on this device')
          return null
        }
      }
    }
    if (downloaded) paths[key] = destPath
  }
  return paths
}

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
 *
 * @param {Object} ocrInstance - The OcrGgml instance to unload
 * @param {number} [timeoutMs=10000] - Max time to wait for unload
 * @returns {Promise<void>}
 */
async function safeUnload (ocrInstance, timeoutMs = 10000) {
  try {
    let timeoutId
    const unloadPromise = ocrInstance.unload()
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
 * Helper to run a single DocTR OCR pass using the GGML backend and return results.
 * @param {Object} t - brittle test handle
 * @param {Object} params - OCR params (pathDetector, pathRecognizer, etc.)
 * @param {string} imagePath - Path to the image file
 * @returns {Promise<{results: Array, stats: Object}>}
 */
async function runDoctrOCR (t, params, imagePath) {
  const { OcrGgml } = require('../..')

  const ocrGgml = new OcrGgml({
    params: {
      langList: ['en'],
      pipelineType: 'doctr',
      ...params
    },
    opts: { stats: true }
  })

  await ocrGgml.load()
  console.log('[runDoctrOCR] loaded, starting run...')

  try {
    const response = await ocrGgml.run({
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
    await safeUnload(ocrGgml)
    await new Promise(resolve => setTimeout(resolve, 2000))
  }
}

module.exports = {
  isMobile,
  isWindows,
  platform,
  getImagePath,
  ensureModelPath,
  ensureDoctrModels,
  GGML_MODELS_DIR,
  formatOCRPerformanceMetrics,
  safeUnload,
  runDoctrOCR,
  flushPerfReport: _flushPerfReport
}
