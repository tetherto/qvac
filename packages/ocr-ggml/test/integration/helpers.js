'use strict'

// Shared helpers for the @qvac/ocr-ggml integration suite.
//
// This file is intentionally not named `*.test.js` so the brittle glob
// (`test/integration/*.test.js`) does not pick it up as a test file.

const fs = require('bare-fs')
const path = require('bare-path')
const os = require('bare-os')
const process = require('bare-process')

// Dynamic require via path.join prevents bare-pack from statically resolving
// these paths during mobile bundling (they live outside the addon package).
let createPerformanceReporter, evaluateQuality, findGroundTruth
const _scriptBase = path.join('..', '..', '..', '..', 'scripts', 'test-utils')
try {
  const perfMod = require(path.join(_scriptBase, 'performance-reporter'))
  const qualityMod = require(path.join(_scriptBase, 'quality-metrics'))
  perfMod.configure({ fs, path, process, os })
  qualityMod.configure({ fs, path })
  createPerformanceReporter = perfMod.createPerformanceReporter
  evaluateQuality = qualityMod.evaluateQuality
  findGroundTruth = qualityMod.findGroundTruth
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
const _perfReporter = createPerformanceReporter({ addon: 'ocr-ggml', addonType: 'ocr' })
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

// ---------------------------------------------------------------------------
// Model resolution
// ---------------------------------------------------------------------------

function _stripFileUrl (s) { return s.replace(/^file:\/\//, '') }

function _loadUrlConfig () {
  const candidates = [
    '../../testAssets/ocr-ggml-model-urls.json',
    '../testAssets/ocr-ggml-model-urls.json',
    'testAssets/ocr-ggml-model-urls.json'
  ]
  if (global.assetPaths) {
    const mapped = global.assetPaths['../../testAssets/ocr-ggml-model-urls.json']
    if (mapped) {
      try { return JSON.parse(fs.readFileSync(_stripFileUrl(mapped), 'utf8')) } catch (_) {}
    }
  }
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch (_) {}
    }
  }
  return null
}

async function _downloadFile (url, destPath) {
  const fetch = require('bare-fetch')
  console.log(`   Downloading: ${url.substring(0, 80)}...`)
  const response = await fetch(url)
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`)
  const buffer = Buffer.from(await response.arrayBuffer())
  fs.writeFileSync(destPath, buffer)
  console.log(`   Downloaded: ${path.basename(destPath)} (${Math.round(buffer.byteLength / 1024 / 1024)}MB)`)
}

/**
 * Returns the expected local path for a GGUF model without downloading it.
 * Use this at module level for the skip-guard; call ensureModelPath() inside
 * the test body to actually download the model on mobile.
 *
 * Desktop: returns process.env[envVar] or null.
 * Mobile:  returns the expected cache path (may not exist yet).
 *
 * @param {string} envVar        - Env var used on desktop, e.g. 'OCR_GGML_DETECTOR'
 * @param {string} assetFilename - Asset filename as bundled, e.g. 'craft_mlt_25k.gguf.bin'
 */
function resolveModelPath (envVar, assetFilename) {
  if (!isMobile) {
    return process.env[envVar] || null
  }
  const ggufFilename = assetFilename.replace(/\.bin$/, '')
  return path.join(global.testDir || '/tmp', 'ocr-ggml-models', ggufFilename)
}

/**
 * Resolves a GGUF model path, downloading it on mobile if not already cached.
 *
 * Desktop: returns process.env[envVar] or null (models pre-downloaded by CI).
 * Mobile:  reads ocr-ggml-model-urls.json from testAssets, downloads the model
 *          to global.testDir/ocr-ggml-models/ with retries, returns the path.
 *          Returns null on failure so the caller can skip gracefully.
 *
 * @param {string} envVar        - Env var used on desktop, e.g. 'OCR_GGML_DETECTOR'
 * @param {string} assetFilename - Asset filename as bundled, e.g. 'craft_mlt_25k.gguf.bin'
 */
async function ensureModelPath (envVar, assetFilename) {
  if (!isMobile) {
    return process.env[envVar] || null
  }

  const ggufFilename = assetFilename.replace(/\.bin$/, '')
  const modelKey = ggufFilename.replace(/\.[^.]+$/, '')
  const writableRoot = global.testDir || '/tmp'
  const modelsDir = path.join(writableRoot, 'ocr-ggml-models')
  const destPath = path.join(modelsDir, ggufFilename)

  if (fs.existsSync(destPath)) {
    console.log(`   Model cached: ${ggufFilename}`)
    return destPath
  }

  const urlConfig = _loadUrlConfig()
  if (!urlConfig) {
    console.log('[ensureModelPath] ocr-ggml-model-urls.json not found — cannot download models')
    return null
  }

  const downloadUrl = urlConfig[modelKey + '_url']
  if (!downloadUrl) {
    console.log(`[ensureModelPath] No URL for model: ${modelKey}`)
    return null
  }

  fs.mkdirSync(modelsDir, { recursive: true })

  const maxAttempts = 5
  let lastError
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await _downloadFile(downloadUrl, destPath)
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
  console.log(`[ensureModelPath] Failed to download ${ggufFilename}: ${lastError.message}`)
  return null
}

// ---------------------------------------------------------------------------
// Sample image
// ---------------------------------------------------------------------------

function defaultSampleImage () {
  if (isMobile) {
    if (global.assetPaths) {
      const mapped = global.assetPaths['../../testAssets/english.png']
      if (mapped) return _stripFileUrl(mapped)
    }
    throw new Error(
      'Mobile asset not found in global.assetPaths: english.png. ' +
      "Did 'npm run mobile:copy-prebuilds' run during test setup?"
    )
  }
  return path.join(__dirname, '..', '..', 'samples', 'english.png')
}

/**
 * Resolves a test asset path for both desktop and mobile.
 * On mobile, looks up the asset in global.assetPaths.
 *
 * @param {string} relativePath - Relative path from package root (e.g. '/test/images/foo.png')
 */
function getImagePath (relativePath) {
  if (isMobile && global.assetPaths) {
    const filename = path.basename(relativePath)
    const projectPath = `../../testAssets/${filename}`
    if (global.assetPaths[projectPath]) {
      return _stripFileUrl(global.assetPaths[projectPath])
    }
    throw new Error(`Asset not found in testAssets: ${filename}`)
  }
  return path.resolve('.') + relativePath
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

function modelsPresent (paths) {
  return paths.every(p => {
    try { return fs.statSync(p).isFile() } catch { return false }
  })
}

function assertRowShape (t, rows) {
  t.ok(Array.isArray(rows), 'output is an array')
  if (rows && rows.length > 0) {
    const [box, text, conf] = rows[0]
    t.is(box.length, 4, 'each row has a 4-point bounding box')
    t.is(typeof text, 'string', 'second element is the text string')
    t.is(typeof conf, 'number', 'third element is the confidence number')
  }
}

function assertStatsShape (t, stats) {
  // QvacResponse initialises `response.stats = {}` and only fills it when
  // the addon is constructed with `opts.stats: true`. Treat an empty object
  // (or any falsy value) as "stats not requested" and skip the assertions.
  if (!stats || Object.keys(stats).length === 0) return
  t.ok(typeof stats.totalTime === 'number', 'stats.totalTime is a number')
  t.ok(typeof stats.detectionTime === 'number', 'stats.detectionTime is a number')
  t.ok(typeof stats.recognitionTime === 'number', 'stats.recognitionTime is a number')
}

// ---------------------------------------------------------------------------
// Performance metrics
// ---------------------------------------------------------------------------

/**
 * Records OCR timing + quality metrics to the singleton perf reporter and
 * returns a formatted string suitable for t.comment().
 *
 * Mirrors the signature and output format of ocr-onnx's formatOCRPerformanceMetrics
 * so Step Summary tables render identical columns for side-by-side comparison.
 *
 * @param {string}   label  - Test label, e.g. '[DocTR]' or '[EasyOCR]'
 * @param {Object}   stats  - response.stats (totalTime/detectionTime/recognitionTime in seconds)
 * @param {Array}    rows   - Output rows: [box, text, conf] triples from onUpdate
 * @param {Object}  [opts]
 * @param {string}  [opts.imagePath]   - Source image path (enables quality auto-discovery)
 * @param {Object}  [opts.groundTruth] - Explicit ground truth (overrides auto-discovery)
 * @param {boolean} [opts.skipReport]  - Skip recording to the reporter (dry run)
 */
function formatOCRPerformanceMetrics (label, stats, rows, opts) {
  const totalTimeMs = stats && stats.totalTime ? Math.round(stats.totalTime * 1000) : 0
  const detectionTimeMs = stats && stats.detectionTime ? Math.round(stats.detectionTime * 1000) : 0
  const recognitionTimeMs = stats && stats.recognitionTime ? Math.round(stats.recognitionTime * 1000) : 0
  const textRegions = Array.isArray(rows) ? rows.length : 0
  const totalSeconds = (totalTimeMs / 1000).toFixed(2)

  const outputTexts = Array.isArray(rows) ? rows.map(r => r[1]) : []

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
      total_time_ms: totalTimeMs,
      detection_time_ms: detectionTimeMs,
      recognition_time_ms: recognitionTimeMs,
      text_regions: textRegions
    }, {
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
    - Total time: ${totalTimeMs}ms (${totalSeconds}s)
    - Detection time: ${detectionTimeMs}ms
    - Recognition time: ${recognitionTimeMs}ms
    - Text regions detected: ${textRegions}
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

module.exports = {
  platform,
  isMobile,
  isWindows,
  modelsPresent,
  resolveModelPath,
  ensureModelPath,
  assertRowShape,
  assertStatsShape,
  defaultSampleImage,
  getImagePath,
  formatOCRPerformanceMetrics,
  flushPerfReport: _flushPerfReport
}
