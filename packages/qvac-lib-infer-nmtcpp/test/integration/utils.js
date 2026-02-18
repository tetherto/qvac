'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const process = require('bare-process')
const HyperdriveDL = require('@qvac/dl-hyperdrive')
const TranslationNmtcpp = require('../../index')

// ============================================================================
// Hyperdrive Keys for Mobile Model Downloads
// ============================================================================

/** Bergamot en-it Hyperdrive key */
const BERGAMOT_ENIT_KEY = 'a8811fb494e4aee45ca06a011703a25df5275e5dfa59d6217f2d430c677f9fa6'

/** IndicTrans en-indic 200M q4_0 Hyperdrive key */
const INDICTRANS_KEY = '8336d23073b2fd99723bf17d65ddc7b54b8ee886d6627659ba95c7a8fb932dc8'

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
// Model Availability Helpers
// ============================================================================

/**
 * Ensures IndicTrans model is available
 * Uses INDICTRANS_MODEL_PATH env var or downloads via Hyperdrive on mobile
 *
 * Desktop: Expects model at ../../model/indictrans/ggml-indictrans2-en-indic-dist-200M-q4_0.bin
 * Mobile: Downloads via HyperdriveDL using peer-to-peer network
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

  // Mobile: Download via Hyperdrive
  console.log('Downloading IndicTrans model via Hyperdrive...')
  const writableRoot = global.testDir || '/tmp'
  const modelsDir = path.join(writableRoot, 'translation-models', 'indictrans')
  fs.mkdirSync(modelsDir, { recursive: true })

  const destPath = path.join(modelsDir, modelFilename)

  const hdDL = new HyperdriveDL({ key: `hd://${INDICTRANS_KEY}` })
  try {
    const args = {
      loader: hdDL,
      params: { mode: 'full', srcLang: 'eng_Latn', dstLang: 'hin_Deva' },
      diskPath: modelsDir,
      modelName: modelFilename
    }
    const model = new TranslationNmtcpp(args, {})
    await model.load()
    await model.unload()
  } finally {
    await hdDL.close()
  }

  // Validate downloaded model size
  const stats = fs.statSync(destPath)
  const sizeMB = stats.size / (1024 * 1024)
  if (sizeMB < 100) {
    throw new Error(`Downloaded IndicTrans model seems corrupted (expected ~127MB, got ${sizeMB.toFixed(2)}MB)`)
  }

  console.log(`IndicTrans model downloaded: ${destPath} (${sizeMB.toFixed(1)}MB)`)
  return destPath
}

/**
 * Ensures Bergamot model is available
 * Uses BERGAMOT_MODEL_PATH env var or downloads via Hyperdrive on mobile
 *
 * Desktop: Expects model at ../../model/bergamot/enit/
 *          with .intgemm model file and .spm vocab file
 * Mobile: Downloads via HyperdriveDL using peer-to-peer network
 *
 * @returns {Promise<string>} Path to Bergamot model directory
 * @throws {Error} If model files not found/available
 */
async function ensureBergamotModel () {
  const relativeDir = '../../model/bergamot/enit'
  const modelDir = path.resolve(__dirname, relativeDir)

  // Desktop: Check if model directory exists with required files
  if (fs.existsSync(modelDir)) {
    const files = fs.readdirSync(modelDir)
    const hasIntgemm = files.some(f => f.includes('.intgemm'))
    const hasVocab = files.some(f => f.includes('.spm'))

    if (hasIntgemm && hasVocab) {
      return modelDir
    }
  }

  // Desktop without model: Error (should be pre-downloaded)
  if (!isMobile) {
    throw new Error(`Bergamot model not found at ${modelDir}. Please download it first.`)
  }

  // Mobile: Download via Hyperdrive
  console.log('Downloading Bergamot en-it model via Hyperdrive...')
  const writableRoot = global.testDir || '/tmp'
  const modelsDir = path.join(writableRoot, 'translation-models', 'bergamot', 'enit')
  fs.mkdirSync(modelsDir, { recursive: true })

  const hdDL = new HyperdriveDL({ key: `hd://${BERGAMOT_ENIT_KEY}` })
  try {
    await hdDL.ready()

    // Download model file
    const modelFilename = 'model.enit.intgemm.alphas.bin'
    console.log(`   Downloading ${modelFilename}...`)
    const modelData = await hdDL.download(modelFilename)
    fs.writeFileSync(path.join(modelsDir, modelFilename), modelData)
    console.log(`   ✅ ${modelFilename} (${(modelData.length / 1024 / 1024).toFixed(1)}MB)`)

    // Download vocab file
    const vocabFilename = 'vocab.enit.spm'
    console.log(`   Downloading ${vocabFilename}...`)
    const vocabData = await hdDL.download(vocabFilename)
    fs.writeFileSync(path.join(modelsDir, vocabFilename), vocabData)
    console.log(`   ✅ ${vocabFilename} (${(vocabData.length / 1024).toFixed(0)}KB)`)
  } finally {
    await hdDL.close()
  }

  console.log(`Bergamot model downloaded to: ${modelsDir}`)
  return modelsDir
}

// ============================================================================
// Logger and Status Helpers
// ============================================================================

/**
 * Creates a logger for capturing C++ addon output
 * Routes all log levels to console with prefix for easy identification
 *
 * @returns {Object} Logger object with error, warn, info, debug methods
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

/**
 * Waits for addon to reach a target status
 * Handles race conditions where status may progress past target
 *
 * Status progression: LOADING → PROCESSING → IDLE
 * If current status is past target (e.g., IDLE when waiting for PROCESSING),
 * resolves immediately to avoid deadlock
 *
 * @param {Object} addon - The addon instance with status() method
 * @param {string} targetStatus - Target status to wait for ('LOADING', 'PROCESSING', or 'IDLE')
 * @param {number} [timeout=300000] - Timeout in milliseconds (default: 5 minutes)
 * @returns {Promise<string>} The reached status
 * @throws {Error} If timeout exceeded or status check fails
 */
async function waitForStatus (addon, targetStatus, timeout = 300000) {
  const statusOrder = ['LOADING', 'PROCESSING', 'IDLE']

  return new Promise((resolve, reject) => {
    const startTime = Date.now()

    const checkStatus = async () => {
      try {
        const currentStatus = await addon.status()

        if (currentStatus === targetStatus) {
          resolve(currentStatus)
          return
        }

        // Handle race condition: status progressed past target
        const targetIdx = statusOrder.indexOf(targetStatus)
        const currentIdx = statusOrder.indexOf(currentStatus)
        if (targetIdx >= 0 && currentIdx >= 0 && currentIdx > targetIdx) {
          console.log(`Note: Status '${currentStatus}' is past target '${targetStatus}' - continuing`)
          resolve(currentStatus)
          return
        }

        if (Date.now() - startTime > timeout) {
          reject(new Error(`Timeout waiting for status '${targetStatus}'. Current status: '${currentStatus}'`))
          return
        }

        setTimeout(checkStatus, 1000)
      } catch (error) {
        reject(error)
      }
    }

    checkStatus()
  })
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
  waitForStatus,
  TEST_TIMEOUT,

  // Performance metrics
  createPerformanceCollector,
  formatPerformanceMetrics
}
