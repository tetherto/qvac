'use strict'

/**
 * Quickstart Example — Bergamot Backend
 *
 * This example demonstrates translation using the Bergamot backend
 * with local model files or auto-download via Firefox CDN.
 *
 * Usage:
 *   bare examples/quickstart.js
 *   BERGAMOT_MODEL_PATH=/path/to/bergamot/model bare examples/quickstart.js
 *
 * Enable verbose C++ logging:
 *   VERBOSE=1 bare examples/quickstart.js
 */

const TranslationNmtcpp = require('..')
const path = require('bare-path')
const process = require('bare-process')

// ============================================================
// LOGGING CONFIGURATION
// Set VERBOSE=1 environment variable to enable C++ debug logs
// ============================================================
const VERBOSE = process.env.VERBOSE === '1' || process.env.VERBOSE === 'true'

const logger = VERBOSE
  ? {
      info: (msg) => console.log('[C++ INFO]', msg),
      warn: (msg) => console.warn('[C++ WARN]', msg),
      error: (msg) => console.error('[C++ ERROR]', msg),
      debug: (msg) => console.log('[C++ DEBUG]', msg)
    }
  : null // null = suppress all C++ logs

const text = 'Machine translation has revolutionized how we communicate across language barriers in the modern digital world.'

async function testBergamot () {
  console.log('\n=== Testing Bergamot Backend ===\n')

  const {
    ensureBergamotModelFiles,
    getBergamotFileNames
  } = require('../lib/bergamot-model-fetcher')

  const srcLang = 'en'
  const dstLang = 'it'

  // Use local model path if provided, otherwise auto-download
  const bergamotPath = process.env.BERGAMOT_MODEL_PATH || './model/bergamot/enit'

  // Ensure model files are present (downloads from Firefox CDN if not)
  const modelDir = await ensureBergamotModelFiles(srcLang, dstLang, bergamotPath)
  console.log('Model directory:', modelDir)

  const fileNames = getBergamotFileNames(srcLang, dstLang)

  console.log('Loading model...')

  // Create model with resolved file paths
  const model = new TranslationNmtcpp({
    files: {
      model: path.join(modelDir, fileNames.modelName),
      srcVocab: path.join(modelDir, fileNames.srcVocabName),
      dstVocab: path.join(modelDir, fileNames.dstVocabName)
    },
    params: { mode: 'full', dstLang, srcLang },
    config: {
      modelType: TranslationNmtcpp.ModelTypes.Bergamot
    },
    logger
  })

  // Load model
  await model.load()
  console.log('Model loaded successfully!')

  try {
    console.log('Running translation...')
    console.log('Input text:', text)

    // Run the Model
    const response = await model.run(text)

    await response
      .onUpdate(data => {
        console.log('Translation output:', data)
      })
      .await()

    console.log('Bergamot translation finished!')
  } finally {
    console.log('Unloading model...')
    await model.unload()
    console.log('Done!')
  }
}

async function main () {
  try {
    await testBergamot()

    console.log('\n=== All Tests Completed Successfully! ===\n')
  } catch (error) {
    console.error('Test failed:', error)
    throw error
  }
}

main()
