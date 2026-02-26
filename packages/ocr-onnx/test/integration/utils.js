'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const os = require('bare-os')

const platform = os.platform()
const isMobile = platform === 'ios' || platform === 'android'

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
function formatOCRPerformanceMetrics (label, stats, outputTexts = []) {
  const totalTimeMs = stats.totalTime ? stats.totalTime * 1000 : 0
  const detectionTimeMs = stats.detectionTime ? stats.detectionTime * 1000 : 0
  const recognitionTimeMs = stats.recognitionTime ? stats.recognitionTime * 1000 : 0
  const textRegionsCount = stats.textRegionsCount || 0
  const totalSeconds = (totalTimeMs / 1000).toFixed(2)

  return `${label} Performance Metrics:
    - Total time: ${totalTimeMs.toFixed(0)}ms (${totalSeconds}s)
    - Detection time: ${detectionTimeMs.toFixed(0)}ms
    - Recognition time: ${recognitionTimeMs.toFixed(0)}ms
    - Text regions detected: ${textRegionsCount}
    - Detected texts: ${JSON.stringify(outputTexts)}`
}

module.exports = {
  isMobile,
  platform,
  getImagePath,
  ensureModelPath,
  formatOCRPerformanceMetrics
}
