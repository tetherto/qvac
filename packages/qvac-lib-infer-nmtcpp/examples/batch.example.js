'use strict'

/**
 * Batch Translation Example
 *
 * This example demonstrates how to use the runBatch() method to translate
 * multiple texts in a single batch operation, which is more efficient than
 * translating texts one at a time.
 *
 * Note: Source language is fixed to English (en). Target language depends on model (e.g., it, de, fr).
 *
 * Usage:
 *   bare examples/batch.example.js
 *   BERGAMOT_MODEL_PATH=/path/to/bergamot/enit bare examples/batch.example.js
 *
 * Environment Variables:
 *   BERGAMOT_MODEL_PATH - Path to Bergamot model directory (default: ./model/bergamot/enit)
 *
 * Enable verbose C++ logging:
 *   VERBOSE=1 bare examples/batch.example.js
 */

const TranslationNmtcpp = require('..')
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

// Sample texts to translate (English to target language based on model)
// Note: Source language is fixed to English (en). Target depends on model (e.g., it, de, fr).
const textsToTranslate = [
  'Hello world!',
  'How are you today?',
  'Machine translation has revolutionized communication.',
  'The weather is beautiful.',
  'Thank you for your help.'
]

async function testBatchTranslation () {
  console.log('\n=== Batch Translation Example ===\n')

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
    const HyperdriveDL = require('@qvac/dl-hyperdrive')
    loader = new HyperdriveDL({ key: `hd://${hdKey}` })
    console.log('Using HyperdriveDL loader')
  } else {
    loader = {
      ready: async () => {},
      close: async () => {},
      download: async (filename) => fs.readFileSync(path.join(modelDir, filename)),
      getFileSize: async (filename) => fs.statSync(path.join(modelDir, filename)).size
    }
    console.log('Using local file loader (Firefox CDN download)')
  }

  // Create model args
  const args = {
    loader,
    params: { mode: 'full', dstLang, srcLang },
    diskPath: modelDir,
    modelName: fileNames.modelName,
    logger
  }

  // Config for Bergamot model
  const config = {
    srcVocabName: fileNames.srcVocabName,
    dstVocabName: fileNames.dstVocabName,
    modelType: TranslationNmtcpp.ModelTypes.Bergamot
  }

  // Create and load model
  const model = new TranslationNmtcpp(args, config)

  console.log('Loading model...')
  await model.load()
  console.log('Model loaded!\n')

  try {
    console.log('Input texts:')
    textsToTranslate.forEach((text, i) => {
      console.log(`  ${i + 1}. ${text}`)
    })

    console.log('\nTranslating batch...')
    const startTime = Date.now()

    // Use batch translation
    const translations = await model.runBatch(textsToTranslate)

    const elapsed = Date.now() - startTime
    console.log(`\nBatch translation completed in ${elapsed}ms\n`)

    console.log('Translations:')
    translations.forEach((text, i) => {
      console.log(`  ${i + 1}. ${text}`)
    })

    // Compare with sequential translation
    console.log('\n--- Comparison: Sequential vs Batch ---')

    const seqStartTime = Date.now()
    for (const text of textsToTranslate) {
      const response = await model.run(text)
      await response.await()
    }
    const seqElapsed = Date.now() - seqStartTime

    console.log(`Sequential (${textsToTranslate.length} calls): ${seqElapsed}ms`)
    console.log(`Batch (1 call): ${elapsed}ms`)
    console.log(`Speedup: ${(seqElapsed / elapsed).toFixed(2)}x`)
  } finally {
    console.log('\nUnloading model...')
    await model.unload()
    await loader.close()
    console.log('Done!')
  }
}

testBatchTranslation().catch(console.error)
