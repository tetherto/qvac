'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const os = require('bare-os')

const platform = os.platform()
const isMobile = platform === 'ios' || platform === 'android'

// DocTR model download URLs from OnnxTR GitHub releases
const DOCTR_MODEL_URLS = {
  'db_resnet50.onnx': 'https://github.com/felixdittrich92/OnnxTR/releases/download/v0.0.1/db_resnet50-69ba0015.onnx',
  'parseq.onnx': 'https://github.com/felixdittrich92/OnnxTR/releases/download/v0.0.1/parseq-00b40714.onnx',
  'db_mobilenet_v3_large.onnx': 'https://github.com/felixdittrich92/OnnxTR/releases/download/v0.2.0/db_mobilenet_v3_large-4987e7bd.onnx',
  'crnn_mobilenet_v3_small.onnx': 'https://github.com/felixdittrich92/OnnxTR/releases/download/v0.0.1/crnn_mobilenet_v3_small-bded4d49.onnx'
}

const DOCTR_MODELS_DIR = path.resolve('.', 'test/models/doctr')

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
 * Downloads a single DocTR model if not already cached
 * @param {string} filename - Model filename (e.g., 'db_resnet50.onnx')
 */
async function downloadDoctrModel (filename) {
  const destPath = path.join(DOCTR_MODELS_DIR, filename)
  if (fs.existsSync(destPath)) return
  const url = DOCTR_MODEL_URLS[filename]
  if (!url) throw new Error(`No download URL for DocTR model: ${filename}`)
  console.log(`Downloading ${filename}...`)
  const fetch = require('bare-fetch')
  const response = await fetch(url)
  if (!response.ok) throw new Error(`HTTP ${response.status} downloading ${filename}`)
  const buffer = await response.arrayBuffer()
  fs.writeFileSync(destPath, Buffer.from(buffer))
  console.log(`Downloaded ${filename} (${Math.round(buffer.byteLength / 1024 / 1024)}MB)`)
}

/**
 * Ensures all requested DocTR models are available, downloading from OnnxTR GitHub releases if needed
 * @param {string[]} [models] - Model filenames to ensure. Defaults to all 4 models.
 * @returns {Promise<Object>} Map of model name (without extension) to full path
 */
async function ensureDoctrModels (models) {
  if (!models) models = Object.keys(DOCTR_MODEL_URLS)
  fs.mkdirSync(DOCTR_MODELS_DIR, { recursive: true })
  for (const filename of models) {
    await downloadDoctrModel(filename)
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
      pipelineMode: 'doctr',
      ...params
    },
    opts: { stats: true }
  })

  await onnxOcr.load()

  try {
    const response = await onnxOcr.run({
      path: imagePath,
      options: { paragraph: false }
    })

    let results = []

    await response
      .onUpdate(output => {
        t.ok(Array.isArray(output), 'output should be an array')
        results = output.map(o => ({ text: o[1], confidence: o[2], bbox: o[0] }))
      })
      .onError(error => {
        t.fail('unexpected error: ' + JSON.stringify(error))
      })
      .await()

    return { results, stats: response.stats || {} }
  } finally {
    try {
      await onnxOcr.unload()
    } catch (e) {
      t.comment('unload() error: ' + e.message)
    }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
}

module.exports = {
  isMobile,
  platform,
  getImagePath,
  ensureModelPath,
  ensureDoctrModels,
  DOCTR_MODELS_DIR,
  formatOCRPerformanceMetrics,
  runDoctrOCR
}
