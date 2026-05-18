'use strict'

// Shared helpers for the @qvac/ocr-ggml integration suite.
//
// This file is intentionally not named `*.test.js` so the brittle glob
// (`test/integration/*.test.js`) does not pick it up as a test file.

const fs = require('bare-fs')
const path = require('bare-path')
const os = require('bare-os')
const process = require('bare-process')

const platform = os.platform()
const isMobile = platform === 'ios' || platform === 'android'

// ---------------------------------------------------------------------------
// Performance reporter
// ---------------------------------------------------------------------------
//
// On desktop, load the shared performance-reporter module from scripts/.
// On mobile (bare-pack bundle), the require fails because scripts/ is outside
// the package — fall back to an inline implementation that writes the same
// [PERF_REPORT_START]...[PERF_REPORT_END] markers to console so the Device
// Farm log extractor can pick them up.

let createPerformanceReporter
const _scriptBase = path.join('..', '..', '..', '..', 'scripts', 'test-utils')
try {
  const perfMod = require(path.join(_scriptBase, 'performance-reporter'))
  perfMod.configure({ fs, path, process, os })
  createPerformanceReporter = perfMod.createPerformanceReporter
} catch (_) {
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
        _results.push({
          test: testName,
          execution_provider: (extra && extra.execution_provider) || null,
          metrics: Object.assign({
            total_time_ms: null,
            detection_time_ms: null,
            recognition_time_ms: null,
            text_regions: null
          }, metrics),
          input: (extra && extra.input) || null,
          output: (extra && extra.output) || null
        })
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
            return
          } catch (e) {
            console.log('[perf-reporter] write to ' + dirs[di] + ' failed: ' + e.message)
          }
        }
        console.log('[perf-reporter] all write locations failed')
      },
      writeStepSummary () {},
      writeToConsole (opts) {
        try {
          const data = this.toJSON()
          const json = JSON.stringify(data)
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

const _perfReporter = createPerformanceReporter({ addon: 'ocr-ggml', addonType: 'ocr' })
const _reportPath = path.resolve('.', 'test/results/performance-report.json')
let _reportScheduled = false

function _scheduleReportWrite () {
  if (_reportScheduled) return
  _reportScheduled = true
  process.on('exit', () => {
    if (_perfReporter.length > 0) {
      _perfReporter.writeReport(_reportPath)
      _perfReporter.writeToConsole()
    }
  })
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
 * @param {string} envVar       - Env var used on desktop, e.g. 'OCR_GGML_DETECTOR'
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
 * @param {string} envVar       - Env var used on desktop, e.g. 'OCR_GGML_DETECTOR'
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
 * Records OCR timing metrics to the singleton perf reporter and returns a
 * formatted string suitable for t.comment(). On mobile, also flushes the
 * report to disk and console after every recording.
 *
 * @param {string} label  - Test label, e.g. '[EasyOCR]' or '[DocTR]'
 * @param {Object} stats  - response.stats from the OCR run (totalTime etc. in seconds)
 * @param {Array}  rows   - Output rows from onUpdate (for text_regions count)
 */
function formatOCRPerformanceMetrics (label, stats, rows) {
  const totalTimeMs = stats && stats.totalTime ? Math.round(stats.totalTime * 1000) : 0
  const detectionTimeMs = stats && stats.detectionTime ? Math.round(stats.detectionTime * 1000) : 0
  const recognitionTimeMs = stats && stats.recognitionTime ? Math.round(stats.recognitionTime * 1000) : 0
  const textRegions = Array.isArray(rows) ? rows.length : null

  _perfReporter.record(label, {
    total_time_ms: totalTimeMs,
    detection_time_ms: detectionTimeMs,
    recognition_time_ms: recognitionTimeMs,
    text_regions: textRegions
  }, {
    output: JSON.stringify(rows || [])
  })
  _scheduleReportWrite()

  if (isMobile) {
    _perfReporter.writeReport()
    _perfReporter.writeToConsole()
  }

  return (
    `${label} Performance:\n` +
    `    total=${totalTimeMs}ms  detection=${detectionTimeMs}ms  recognition=${recognitionTimeMs}ms` +
    (textRegions !== null ? `  regions=${textRegions}` : '')
  )
}

module.exports = {
  platform,
  isMobile,
  modelsPresent,
  resolveModelPath,
  ensureModelPath,
  assertRowShape,
  assertStatsShape,
  defaultSampleImage,
  formatOCRPerformanceMetrics
}
