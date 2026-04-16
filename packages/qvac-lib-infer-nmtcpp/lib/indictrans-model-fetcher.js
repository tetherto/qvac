'use strict'

/**
 * IndicTrans Model Fetcher
 *
 * Downloads IndicTrans2 GGML model files from the QVAC model registry.
 *
 * This module does NOT touch Bergamot or OPUS models.
 */

const fs = require('bare-fs')
const path = require('bare-path')

// ============================================================================
// Model registry paths (from SDK models.ts)
// ============================================================================

const INDICTRANS_MODELS = {
  'en-indic-200M-q4_0': {
    registryPath: 'qvac_models_compiled/ggml/indictrans2/q4_0/ggml-indictrans2-en-indic-dist-200M/2026-01-01/ggml-indictrans2-en-indic-dist-200M-q4_0.bin',
    registrySource: 's3',
    filename: 'ggml-indictrans2-en-indic-dist-200M-q4_0.bin',
    expectedMinSizeMB: 100
  }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Checks whether a file exists and meets minimum size requirements.
 */
function hasValidModelFile (filePath, minSizeMB) {
  try {
    const stats = fs.statSync(filePath)
    return stats.size >= minSizeMB * 1024 * 1024
  } catch {
    return false
  }
}

// ============================================================================
// Download via QVAC Registry
// ============================================================================

/**
 * Downloads an IndicTrans model file from the QVAC model registry.
 */
async function downloadIndicTransFromRegistry (modelKey, destPath) {
  const { QVACRegistryClient } = require('@qvac/registry-client')

  const modelInfo = INDICTRANS_MODELS[modelKey]
  if (!modelInfo) {
    throw new Error(`Unknown IndicTrans model key: ${modelKey}. Available: ${Object.keys(INDICTRANS_MODELS).join(', ')}`)
  }

  console.log(`[indictrans-fetcher] Downloading ${modelInfo.filename} from QVAC registry...`)

  const client = new QVACRegistryClient()
  await client.ready()

  try {
    const destDir = path.dirname(destPath)
    fs.mkdirSync(destDir, { recursive: true })

    const result = await client.downloadModel(
      modelInfo.registryPath,
      modelInfo.registrySource,
      { outputFile: destPath }
    )

    console.log(`[indictrans-fetcher] Download complete → ${result.artifact.path}`)

    if (!hasValidModelFile(destPath, modelInfo.expectedMinSizeMB)) {
      throw new Error(`Downloaded file seems corrupted (expected >${modelInfo.expectedMinSizeMB}MB)`)
    }

    return destPath
  } finally {
    await client.close()
  }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Ensures an IndicTrans model file is present at destPath.
 *
 *   1. If a valid model file already exists → returns immediately
 *   2. Downloads from QVAC model registry
 *
 * @param {string} destPath  Full path where the model file should be stored
 * @param {string} [modelKey='en-indic-200M-q4_0']  Model variant key
 * @returns {Promise<string>} Resolved path to the model file
 */
async function ensureIndicTransModelFile (destPath, modelKey = 'en-indic-200M-q4_0') {
  const modelInfo = INDICTRANS_MODELS[modelKey]
  if (!modelInfo) {
    throw new Error(`Unknown IndicTrans model key: ${modelKey}. Available: ${Object.keys(INDICTRANS_MODELS).join(', ')}`)
  }

  if (hasValidModelFile(destPath, modelInfo.expectedMinSizeMB)) {
    console.log(`[indictrans-fetcher] Model already available at ${destPath}`)
    return destPath
  }

  return downloadIndicTransFromRegistry(modelKey, destPath)
}

/**
 * Returns the default filename for an IndicTrans model variant.
 *
 * @param {string} [modelKey='en-indic-200M-q4_0']  Model variant key
 * @returns {string} Filename
 */
function getIndicTransFileName (modelKey = 'en-indic-200M-q4_0') {
  const modelInfo = INDICTRANS_MODELS[modelKey]
  if (!modelInfo) {
    throw new Error(`Unknown IndicTrans model key: ${modelKey}. Available: ${Object.keys(INDICTRANS_MODELS).join(', ')}`)
  }
  return modelInfo.filename
}

// ============================================================================
// Exports
// ============================================================================

module.exports = {
  ensureIndicTransModelFile,
  getIndicTransFileName,
  downloadIndicTransFromRegistry,
  INDICTRANS_MODELS
}
