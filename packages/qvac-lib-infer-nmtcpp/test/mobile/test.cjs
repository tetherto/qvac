'use strict'

/**
 * Mobile Test Suite for @qvac/translation-nmtcpp
 *
 * WARNING: This is a test file intended for internal mobile testing only.
 * It is NOT part of the public API and should NOT be used in production code.
 *
 * This file is included in the package to support the mobile testing framework.
 * The test functions and their interfaces may change without notice.
 *
 * Dependencies required to run this test (all in devDependencies):
 * - @qvac/dl-filesystem
 * - @qvac/dl-hyperdrive
 * - bare-fs
 */

const TranslationNmtcpp = require('@qvac/translation-nmtcpp')
const FilesystemDL = require('@qvac/dl-filesystem')
const HyperDriveDL = require('@qvac/dl-hyperdrive')
const WeightsProvider = require('@qvac/infer-base/WeightsProvider/WeightsProvider')
const path = require('bare-path')
const fs = require('bare-fs')
const fetch = require('bare-fetch')
const process = require('bare-process')

// Module-level variables (shared across test functions)
let translation = null
let loader = null

// Bergamot-specific variables
let bergamotTranslation = null

/**
 * Downloads or verifies Bergamot model availability
 * @param {string} dirPath - Directory path for model storage
 * @param {Function} getAssetPath - Helper function to resolve asset paths
 * @returns {Promise<Object|null>} Object with model and vocab paths or null if not available
 */
async function _ensureBergamotModel (dirPath, getAssetPath) {
  const modelFileName = 'model.intgemm.bin'
  const vocabFileName = 'vocab.enit.spm'

  // First, check for bundled URL config (packaged in APK via getAssetPath)
  console.log('🔍 Checking for bundled URL config in APK...')
  try {
    let urlConfigPath
    try {
      urlConfigPath = getAssetPath('bergamot-urls.json')
      console.log(`   Config path from getAssetPath: ${urlConfigPath}`)
    } catch (getAssetError) {
      console.log(`   getAssetPath failed: ${getAssetError.message}`)

      // Try common fallback paths if getAssetPath fails
      const fallbackPaths = [
        '../../testAssets/bergamot-urls.json',
        '../testAssets/bergamot-urls.json',
        'testAssets/bergamot-urls.json'
      ]
      console.log('   Trying fallback paths...')
      for (const fallbackPath of fallbackPaths) {
        if (fs.existsSync(fallbackPath)) {
          urlConfigPath = fallbackPath
          console.log(`   Found config at fallback path: ${fallbackPath}`)
          break
        }
      }
    }

    if (urlConfigPath && fs.existsSync(urlConfigPath)) {
      const configData = fs.readFileSync(urlConfigPath, 'utf8')
      const urlConfig = JSON.parse(configData)

      if (urlConfig.modelUrl && urlConfig.vocabUrl) {
        console.log('📥 Found bundled Bergamot URLs, downloading at runtime...')
        console.log(`   Model URL: ${urlConfig.modelUrl.substring(0, 50)}...`)
        console.log(`   Vocab URL: ${urlConfig.vocabUrl.substring(0, 50)}...`)

        // Download models using bundled URLs
        const modelPath = path.join(dirPath, modelFileName)
        const vocabPath = path.join(dirPath, vocabFileName)

        fs.mkdirSync(dirPath, { recursive: true })

        // Download model file
        if (!fs.existsSync(modelPath)) {
          console.log('⬇️  Downloading model from bundled URL...')
          const response = await fetch(urlConfig.modelUrl)
          if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`)
          const buffer = await response.arrayBuffer()
          fs.writeFileSync(modelPath, Buffer.from(buffer))
          console.log('✅ Model downloaded successfully')
        }

        // Download vocab file
        if (!fs.existsSync(vocabPath)) {
          console.log('⬇️  Downloading vocab from bundled URL...')
          const response = await fetch(urlConfig.vocabUrl)
          if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`)
          const buffer = await response.arrayBuffer()
          fs.writeFileSync(vocabPath, Buffer.from(buffer))
          console.log('✅ Vocab downloaded successfully')
        }

        if (fs.existsSync(modelPath) && fs.existsSync(vocabPath)) {
          return {
            modelPath,
            vocabPath
          }
        }
      } else {
        console.log('⚠️  Config found but missing URLs')
      }
    } else {
      console.log('⚠️  No bundled URL config found')
    }
  } catch (error) {
    console.log(`⚠️  Error with bundled config: ${error.message}`)
  }

  // Check for local Bergamot model (fallback for development)
  const localModelDir = process.env.BERGAMOT_MODEL_PATH || path.join(dirPath, 'bergamot-enit')

  if (fs.existsSync(localModelDir)) {
    const files = fs.readdirSync(localModelDir)
    const modelFile = files.find(f => f.includes('.intgemm') && f.includes('.bin'))
    const vocabFile = files.find(f => f.includes('.spm'))

    if (modelFile && vocabFile) {
      console.log('✅ Found local Bergamot model at:', localModelDir)
      return {
        modelPath: path.join(localModelDir, modelFile),
        vocabPath: path.join(localModelDir, vocabFile)
      }
    }
  }

  console.log('⚠️  Bergamot model not available - skipping Bergamot tests')
  console.log('   Ensure bergamot-urls.json is bundled in APK assets')
  console.log('   Or set BERGAMOT_MODEL_PATH to local model directory for development')
  return null
}

/**
 * Downloads NMT model from HyperDrive if not already present
 * @param {string} dirPath - Directory path for model storage
 * @returns {Promise<string>} Path to the model file
 */
async function _ensureModel (dirPath) {
  const modelName = 'model.bin'
  const modelPath = path.join(dirPath, modelName)

  // Check if model already exists
  if (fs.existsSync(modelPath)) {
    console.log('📦 Model already cached, skipping download')
    return modelPath
  }

  console.log('📥 Downloading NMT model from HyperDrive...')
  fs.mkdirSync(dirPath, { recursive: true })

  // Use HyperDriveDL to download the model
  const hd = new HyperDriveDL({ key: 'hd://9ef58f31c20d5556722e0b58a5d262fd89801daf2e6cb28e3f21ac6e9228088f' })
  const weightsProvider = new WeightsProvider(hd, console)

  await weightsProvider.downloadFiles([modelName], dirPath, {
    closeLoader: true
  })

  console.log('✅ Model downloaded successfully')
  return modelPath
}

/**
 * Test 1: Download and initialize the NMT model
 * @param {string} dirPath - Directory path for test assets
 * @param {Function} getAssetPath - Helper function to resolve asset paths
 * @returns {Promise<{summary: {total: number, passed: number, failed: number}, message: string}>} Test result with summary
 */
async function testLoadModel (dirPath, getAssetPath) {
  try {
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    console.log('🧪 Test 1: Load NMT Model')
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')
    console.log(`📁 Working directory: ${dirPath}`)

    // Ensure model is available
    console.log('🔍 Checking model availability...')
    const modelPath = await _ensureModel(dirPath)
    console.log(`✅ Model ready at: ${modelPath}`)

    // Initialize translation engine
    console.log('⚙️  Initializing translation engine...')
    loader = new FilesystemDL({ dirPath })

    const config = {
      beamsize: 4,
      lengthpenalty: 0.4,
      maxlength: 128,
      repetitionpenalty: 1.2,
      norepeatngramsize: 2,
      temperature: 0.8,
      topk: 40,
      topp: 0.9,
      use_gpu: false // CPU mode for mobile compatibility
    }

    const args = {
      loader,
      modelName: 'model.bin',
      params: {
        srcLang: 'en',
        dstLang: 'it' // English to Italian translation
      },
      logger: console,
      diskPath: dirPath,
      exclusiveRun: true
    }

    translation = new TranslationNmtcpp(args, config)
    console.log('✅ Translation engine configured')
    console.log('   Source: English → Target: Italian')

    await translation.load()
    console.log('✅ Model weights loaded successfully')

    return { summary: { total: 1, passed: 1, failed: 0 }, message: 'Model loaded successfully ✅' }
  } catch (error) {
    console.error('❌ Model loading failed:', error)
    return { summary: { total: 1, passed: 0, failed: 1 }, message: `Failed to load model: ${error.message}` }
  }
}

/**
 * Test 2: Run translation inference
 * @param {string} dirPath - Directory path for test assets
 * @param {Function} getAssetPath - Helper function to resolve asset paths
 * @returns {Promise<{summary: {total: number, passed: number, failed: number}, message: string}>} Test result with summary
 */
async function testTranslation (dirPath, getAssetPath) {
  try {
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    console.log('🧪 Test 2: Run Translation Inference')
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')

    if (!translation) {
      throw new Error('Model not loaded - run testLoadModel first')
    }

    console.log('🌐 Running translation inference...')
    const inputText = 'My name is Georg Cantor, and I developed set theory. Down, down, down. Would the fall never come to an end?'
    console.log(`   Input: "${inputText.substring(0, 60)}..."`)
    console.log(`   Length: ${inputText.length} characters`)

    const startTime = Date.now()
    const response = await translation.run(inputText)

    let translatedText = ''
    await response
      .onUpdate(data => {
        translatedText += data
      })
      .await()

    const duration = ((Date.now() - startTime) / 1000).toFixed(2)

    console.log(`\n   ✨ Translation completed in ${duration}s`)
    console.log(`   Output: "${translatedText.substring(0, 60)}..."`)
    console.log(`   Length: ${translatedText.length} characters`)

    if (!translatedText || translatedText.length === 0) {
      throw new Error('Translation returned empty result')
    }

    return { summary: { total: 1, passed: 1, failed: 0 }, message: `Translation completed in ${duration}s ✅` }
  } catch (error) {
    console.error('❌ Translation failed:', error)
    return { summary: { total: 1, passed: 0, failed: 1 }, message: `Translation failed: ${error.message}` }
  }
}

/**
 * Test 3: Cleanup and unload resources
 * @param {string} dirPath - Directory path for test assets
 * @param {Function} getAssetPath - Helper function to resolve asset paths
 * @returns {Promise<{summary: {total: number, passed: number, failed: number}, message: string}>} Test result with summary
 */
async function testUnloadModel (dirPath, getAssetPath) {
  try {
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    console.log('🧪 Test 3: Unload Model')
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')

    if (!translation && !loader) {
      console.log('⚠️  No resources to cleanup')
      return { summary: { total: 1, passed: 1, failed: 0 }, message: 'No resources to cleanup ✅' }
    }

    console.log('🧹 Cleaning up resources...')

    if (translation) {
      await translation.unload()
      translation = null
      console.log('✅ Translation engine unloaded')
    }

    if (loader) {
      await loader.close()
      loader = null
      console.log('✅ Loader closed')
    }

    console.log('✅ All resources released successfully')

    return { summary: { total: 1, passed: 1, failed: 0 }, message: 'Resources cleaned up successfully ✅' }
  } catch (error) {
    console.error('❌ Cleanup failed:', error)
    return { summary: { total: 1, passed: 0, failed: 1 }, message: `Cleanup failed: ${error.message}` }
  }
}

/**
 * Test 4: Load Bergamot Model
 * @param {string} dirPath - Directory path for test assets
 * @param {Function} getAssetPath - Helper function to resolve asset paths
 * @returns {Promise<{summary: {total: number, passed: number, failed: number}, message: string}>} Test result with summary
 */
async function testLoadBergamotModel (dirPath, getAssetPath) {
  try {
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    console.log('🧪 Test 4: Load Bergamot Model')
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')
    console.log(`📁 Working directory: ${dirPath}`)

    // Ensure Bergamot model is available
    console.log('🔍 Checking Bergamot model availability...')
    const bergamotModel = await _ensureBergamotModel(dirPath, getAssetPath)

    if (!bergamotModel) {
      console.log('⚠️  Bergamot model not available - skipping test')
      return { summary: { total: 1, passed: 1, failed: 0 }, message: 'Bergamot model not available - test skipped ⚠️' }
    }

    console.log('✅ Bergamot model ready:')
    console.log(`   Model: ${bergamotModel.modelPath}`)
    console.log(`   Vocab: ${bergamotModel.vocabPath}`)

    // Initialize translation engine with Bergamot backend (using correct API)
    console.log('⚙️  Initializing Bergamot translation engine...')
    const config = {
      path: bergamotModel.modelPath,
      srcVocabPath: bergamotModel.vocabPath,
      dstVocabPath: bergamotModel.vocabPath,
      beamsize: 1,
      normalize: 1,
      modelType: TranslationNmtcpp.ModelTypes.Bergamot
    }

    const args = {
      params: {
        mode: 'full',
        srcLang: 'en',
        dstLang: 'it'
      },
      diskPath: path.dirname(bergamotModel.modelPath)
    }

    bergamotTranslation = new TranslationNmtcpp(args, config)
    console.log('✅ Bergamot translation engine configured')
    console.log('   Backend: Bergamot')
    console.log('   Source: English → Target: Italian')

    await bergamotTranslation.load()
    console.log('✅ Bergamot model loaded successfully')

    return { summary: { total: 1, passed: 1, failed: 0 }, message: 'Bergamot model loaded successfully ✅' }
  } catch (error) {
    console.error('❌ Bergamot model loading failed:', error)
    return { summary: { total: 1, passed: 0, failed: 1 }, message: `Failed to load Bergamot model: ${error.message}` }
  }
}

/**
 * Test 5: Run Bergamot translation inference
 * @param {string} dirPath - Directory path for test assets
 * @param {Function} getAssetPath - Helper function to resolve asset paths
 * @returns {Promise<{summary: {total: number, passed: number, failed: number}, message: string}>} Test result with summary
 */
async function testBergamotTranslation (dirPath, getAssetPath) {
  try {
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    console.log('🧪 Test 5: Run Bergamot Translation')
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')

    if (!bergamotTranslation) {
      console.log('⚠️  Bergamot model not loaded - skipping test')
      return { summary: { total: 1, passed: 1, failed: 0 }, message: 'Bergamot model not loaded - test skipped ⚠️' }
    }

    console.log('🌐 Running Bergamot translation inference...')
    const inputText = 'Hello, how are you? The weather is nice today.'
    console.log(`   Input: "${inputText}"`)
    console.log(`   Length: ${inputText.length} characters`)

    const startTime = Date.now()
    const response = await bergamotTranslation.run(inputText)

    let translatedText = ''
    await response
      .onUpdate(data => {
        translatedText += data
      })
      .await()

    const duration = ((Date.now() - startTime) / 1000).toFixed(2)

    console.log(`\n   ✨ Bergamot translation completed in ${duration}s`)
    console.log(`   Output: "${translatedText}"`)
    console.log(`   Length: ${translatedText.length} characters`)

    if (!translatedText || translatedText.length === 0) {
      throw new Error('Bergamot translation returned empty result')
    }

    return { summary: { total: 1, passed: 1, failed: 0 }, message: `Bergamot translation completed in ${duration}s ✅` }
  } catch (error) {
    console.error('❌ Bergamot translation failed:', error)
    return { summary: { total: 1, passed: 0, failed: 1 }, message: `Bergamot translation failed: ${error.message}` }
  }
}

/**
 * Test 6: Unload Bergamot resources
 * @param {string} dirPath - Directory path for test assets
 * @param {Function} getAssetPath - Helper function to resolve asset paths
 * @returns {Promise<{summary: {total: number, passed: number, failed: number}, message: string}>} Test result with summary
 */
async function testUnloadBergamotModel (dirPath, getAssetPath) {
  try {
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    console.log('🧪 Test 6: Unload Bergamot Model')
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')

    if (!bergamotTranslation) {
      console.log('⚠️  No Bergamot resources to cleanup')
      return { summary: { total: 1, passed: 1, failed: 0 }, message: 'No Bergamot resources to cleanup ⚠️' }
    }

    console.log('🧹 Cleaning up Bergamot resources...')

    if (bergamotTranslation) {
      await bergamotTranslation.unload()
      bergamotTranslation = null
      console.log('✅ Bergamot translation engine unloaded')
    }

    console.log('✅ All Bergamot resources released successfully')

    return { summary: { total: 1, passed: 1, failed: 0 }, message: 'Bergamot resources cleaned up successfully ✅' }
  } catch (error) {
    console.error('❌ Bergamot cleanup failed:', error)
    return { summary: { total: 1, passed: 0, failed: 1 }, message: `Bergamot cleanup failed: ${error.message}` }
  }
}

// Export test functions (optional - build script auto-detects async functions)
module.exports = {
  testLoadModel,
  testTranslation,
  testUnloadModel,
  testLoadBergamotModel,
  testBergamotTranslation,
  testUnloadBergamotModel
}
