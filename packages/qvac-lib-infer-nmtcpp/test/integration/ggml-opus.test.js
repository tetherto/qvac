'use strict'

/**
 * GGML/Opus Backend Integration Test
 *
 * Tests the GGML neural machine translation backend with English to Italian translation.
 * Uses HyperDrive to download model if not cached locally.
 *
 * Platform Behavior:
 *   - Mobile (iOS/Android): Uses writable directory from test framework (global.dirPath or global.testDir)
 *   - Desktop: Uses local ../../model/nmt directory
 *
 * Usage:
 *   bare test/integration/ggml-opus.test.js
 */

const test = require('brittle')
const TranslationNmtcpp = require('@qvac/translation-nmtcpp')
const FilesystemDL = require('@qvac/dl-filesystem')
const HyperDriveDL = require('@qvac/dl-hyperdrive')
const WeightsProvider = require('@qvac/infer-base/WeightsProvider/WeightsProvider')
const path = require('bare-path')
const fs = require('bare-fs')
const { isMobile, platform, TEST_TIMEOUT } = require('./utils')

/** HyperDrive key for downloading NMT model */
const HYPERDRIVE_KEY = 'hd://9ef58f31c20d5556722e0b58a5d262fd89801daf2e6cb28e3f21ac6e9228088f'

/** Model filename in HyperDrive */
const MODEL_NAME = 'model.bin'

/**
 * Gets the working directory for model storage
 * On mobile: uses global.dirPath or global.testDir (writable path provided by test framework) or /tmp
 * On desktop: uses local model directory
 *
 * @returns {string} Directory path for model storage
 */
function getModelDir () {
  if (isMobile) {
    // Mobile: must use writable directory provided by test framework
    // Check multiple possible globals that the framework might set
    const writableDir = global.dirPath || global.testDir || '/tmp'
    console.log('[GGML] Mobile detected, using writable dir:', writableDir)
    console.log('[GGML] global.dirPath:', global.dirPath)
    console.log('[GGML] global.testDir:', global.testDir)
    return writableDir
  }
  // Desktop: use project model directory
  return path.resolve(__dirname, '../../model/nmt')
}

/**
 * Downloads NMT model from HyperDrive if not already present
 * Uses WeightsProvider for reliable download with progress tracking
 *
 * @param {string} dirPath - Directory path for model storage
 * @returns {Promise<string>} Path to the model file
 */
async function ensureModel (dirPath) {
  const modelPath = path.join(dirPath, MODEL_NAME)

  // Check if model already exists
  if (fs.existsSync(modelPath)) {
    console.log('[GGML] 📦 Model already cached, skipping download')
    return modelPath
  }

  console.log('[GGML] 📥 Downloading NMT model from HyperDrive...')
  console.log('[GGML] Target directory:', dirPath)

  // Create directory if needed
  fs.mkdirSync(dirPath, { recursive: true })

  // Use HyperDriveDL to download the model
  const hd = new HyperDriveDL({ key: HYPERDRIVE_KEY })
  const weightsProvider = new WeightsProvider(hd, console)

  await weightsProvider.downloadFiles([MODEL_NAME], dirPath, {
    closeLoader: true
  })

  console.log('[GGML] ✅ Model downloaded successfully')
  return modelPath
}

test('GGML/Opus backend - English to Italian translation', { timeout: TEST_TIMEOUT }, async t => {
  const dirPath = getModelDir()
  // Variables for cleanup
  let translation = null
  let loader = null

  t.comment('Platform: ' + platform + ', isMobile: ' + isMobile)
  t.comment('Working directory: ' + dirPath)

  try {
    const modelPath = await ensureModel(dirPath)
    t.ok(modelPath, 'model path should be available')
    t.comment('Model path: ' + modelPath)

    // Create FilesystemDL loader for the downloaded model
    loader = new FilesystemDL({ dirPath })
    t.ok(loader, 'loader created')

    /** GGML translation configuration */
    const config = {
      beamsize: 4,
      lengthpenalty: 0.4,
      maxlength: 128,
      repetitionpenalty: 1.2,
      norepeatngramsize: 2,
      temperature: 0.8,
      topk: 40,
      topp: 0.9,
      use_gpu: false
    }

    /** TranslationNmtcpp constructor arguments */
    const args = {
      loader,
      modelName: MODEL_NAME,
      params: {
        srcLang: 'en',
        dstLang: 'it' // English to Italian translation
      },
      logger: console,
      diskPath: dirPath,
      exclusiveRun: true
    }

    translation = new TranslationNmtcpp(args, config)
    t.ok(translation, 'translation engine created')

    await translation.load()
    t.pass('model loaded successfully')

    // Run translation
    const inputText = 'Hello, how are you today?'
    t.comment('Translating: "' + inputText + '"')

    const startTime = Date.now()
    const response = await translation.run(inputText)

    let translatedText = ''
    await response
      .onUpdate(data => {
        translatedText += data
      })
      .await()

    const duration = ((Date.now() - startTime) / 1000).toFixed(2)

    t.ok(translatedText.length > 0, 'translation should not be empty')
    t.comment('Translation: ' + translatedText)
    t.comment('Duration: ' + duration + 's')
    t.pass('GGML/Opus translation completed successfully')
  } catch (err) {
    t.fail('GGML/Opus test failed: ' + err.message)
    console.error('[GGML] Error:', err)
    throw err
  } finally {
    // Cleanup: unload translation engine
    if (translation) {
      try {
        await translation.unload()
        t.comment('Translation engine unloaded')
      } catch (e) {
        t.comment('unload error: ' + e.message)
      }
      translation = null
    }
    // Cleanup: close loader
    if (loader) {
      try {
        await loader.close()
        t.comment('Loader closed')
      } catch (e) {
        t.comment('loader.close error: ' + e.message)
      }
      loader = null
    }
  }
})
