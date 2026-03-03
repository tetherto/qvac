'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const process = require('bare-process')

// ============================================================================
// Platform Detection
// ============================================================================

/** Current platform (darwin, linux, win32, ios, android) */
const platform = process.platform

/** Whether running on mobile device (iOS or Android) */
const isMobile = platform === 'ios' || platform === 'android'

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
async function downloadFile (url, destPath, maxRedirects = 5) {
  const fetch = require('bare-fetch')
  console.log(`Downloading: ${url.substring(0, 60)}...`)

  // Fetch with redirect following enabled
  const response = await fetch(url, {
    redirect: 'follow',
    follow: maxRedirects
  })

  // Check for redirect status codes that weren't followed
  if ([301, 302, 307, 308].includes(response.status)) {
    const location = response.headers.get('location')
    if (location && maxRedirects > 0) {
      console.log(`   Following redirect to: ${location.substring(0, 60)}...`)
      return downloadFile(location, destPath, maxRedirects - 1)
    }
    throw new Error(`HTTP ${response.status}: Redirect not followed (no location header or max redirects exceeded)`)
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`)
  }

  const buffer = await response.arrayBuffer()
  fs.writeFileSync(destPath, Buffer.from(buffer))
  console.log(`Downloaded: ${path.basename(destPath)} (${(buffer.byteLength / 1024 / 1024).toFixed(1)}MB)`)
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
 * Uses INDICTRANS_MODEL_PATH env var or downloads from S3 on mobile
 *
 * Desktop: Expects model at ../../model/indictrans/ggml-indictrans2-en-indic-dist-200M-q4_0.bin
 * Mobile: Downloads from presigned S3 URL configured in indictrans-model-urls.json
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

  // Mobile: Download from presigned S3 URL
  const configFilename = 'indictrans-model-urls.json'
  const urlConfig = loadConfigFromAssets(configFilename)

  if (!urlConfig || !urlConfig.modelUrl) {
    throw new Error('IndicTrans model URLs config not found - cannot download model on mobile')
  }

  const writableRoot = global.testDir || '/tmp'
  const modelsDir = path.join(writableRoot, 'translation-models', 'indictrans')
  fs.mkdirSync(modelsDir, { recursive: true })

  const destPath = path.join(modelsDir, modelFilename)
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
 *   2. Download from Hyperdrive (if key available for the pair)
 *   3. Fallback: download directly from Firefox Remote Settings CDN
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

  // Not found locally — download via Hyperdrive (primary) or Firefox CDN (fallback)
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
      // Use native addon stats directly (times are in seconds, convert to milliseconds)
      const totalTimeMs = addonStats.totalTime ? addonStats.totalTime * 1000 : 0
      const decodeTimeMs = addonStats.decodeTime ? addonStats.decodeTime * 1000 : 0

      // Use native stats directly
      const generatedTokens = addonStats.totalTokens || 0
      const tps = addonStats.TPS || 0

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
 * @returns {string} Formatted performance metrics string
 */
function formatPerformanceMetrics (label, metrics) {
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

  return `${label} Performance Metrics:
    - Total time: ${totalTimeMs.toFixed(0)}ms (${totalSeconds}s)
    - Decode time: ${decodeTimeMs.toFixed(2)}ms
    - Generated tokens: ${generatedTokens} tokens
    - Prompt: "${prompt}"
    - Tokens per second (TPS): ${tpsValue} t/s
    - Full output: "${fullOutput}"`
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
