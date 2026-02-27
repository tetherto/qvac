'use strict'

/**
 * Quickstart Example
 *
 * This example demonstrates both translation backends:
 * 1. GGML backend - Downloads model via HyperdriveDL (English to Italian)
 * 2. Bergamot backend - Uses local model files (requires BERGAMOT_MODEL_PATH)
 *
 * Usage:
 *   bare examples/quickstart.js
 *   BERGAMOT_MODEL_PATH=/path/to/bergamot/model bare examples/quickstart.js
 *
 * Enable verbose C++ logging:
 *   VERBOSE=1 bare examples/quickstart.js
 */

const TranslationNmtcpp = require('..')
const HyperdriveDL = require('@qvac/dl-hyperdrive')
const fs = require('bare-fs')
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

async function testGGML () {
  console.log('\n=== Testing GGML Backend ===\n')

  // Create `DataLoader`
  const hdDL = new HyperdriveDL({
    // The hyperdrive key for en-it translation model weights and config
    key: 'hd://9ef58f31c20d5556722e0b58a5d262fd89801daf2e6cb28e3f21ac6e9228088f'
  })

  // Create the `args` object
  const args = {
    loader: hdDL,
    params: { mode: 'full', dstLang: 'it', srcLang: 'en' },
    diskPath: './models',
    modelName: 'model.bin',
    logger // Pass the logger
  }

  // Create Model Instance
  const model = new TranslationNmtcpp(args, { })

  // Load model
  await model.load()

  try {
    // Run the Model
    const response = await model.run(text)

    await response
      .onUpdate(data => {
        console.log(data)
      })
      .await()

    console.log('GGML translation finished!')
  } finally {
    // Unload the model
    await model.unload()

    // Close the DataLoader
    await hdDL.close()
  }
}

async function testBergamot () {
  console.log('\n=== Testing Bergamot Backend ===\n')

  const {
    ensureBergamotModelFiles,
    getBergamotFileNames,
    getBergamotHyperdriveKey
  } = require('../lib/bergamot-model-fetcher')

  const srcLang = 'en'
  const dstLang = 'it'

  // Use local model path if provided, otherwise auto-download
  const bergamotPath = process.env.BERGAMOT_MODEL_PATH || './model/bergamot/enit'

  // Ensure model files are present (Hyperdrive first, Firefox CDN fallback)
  const modelDir = await ensureBergamotModelFiles(srcLang, dstLang, bergamotPath)
  console.log('Model directory:', modelDir)

  const fileNames = getBergamotFileNames(srcLang, dstLang)

  // Decide loader: Hyperdrive key available → use HyperdriveDL, else local files
  const hdKey = getBergamotHyperdriveKey(srcLang, dstLang)
  let loader

  if (hdKey) {
    // Primary: use HyperdriveDL for streaming model data
    const HyperdriveDL = require('@qvac/dl-hyperdrive')
    loader = new HyperdriveDL({ key: `hd://${hdKey}` })
    console.log('Using HyperdriveDL loader')
  } else {
    // Fallback: local file loader (files already downloaded from Firefox CDN)
    loader = {
      ready: async () => {},
      close: async () => {},
      download: async (filename) => fs.readFileSync(path.join(modelDir, filename)),
      getFileSize: async (filename) => fs.statSync(path.join(modelDir, filename)).size
    }
    console.log('Using local file loader (Firefox CDN download)')
  }

  console.log('Loading model...')

  // Create the `args` object for Bergamot
  const args = {
    loader,
    params: { mode: 'full', dstLang, srcLang },
    diskPath: modelDir,
    modelName: fileNames.modelName,
    logger
  }

  // Config with vocab paths
  const config = {
    srcVocabName: fileNames.srcVocabName,
    dstVocabName: fileNames.dstVocabName,
    modelType: TranslationNmtcpp.ModelTypes.Bergamot
  }

  // Create Model Instance
  const model = new TranslationNmtcpp(args, config)

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

    // Close the loader
    await loader.close()
    console.log('Done!')
  }
}

async function main () {
  try {
    // Test GGML backend
    await testGGML()

    // Test Bergamot backend
    await testBergamot()

    console.log('\n=== All Tests Completed Successfully! ===\n')
  } catch (error) {
    console.error('Test failed:', error)
    throw error
  }
}

main()
