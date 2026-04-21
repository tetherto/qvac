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
const textsToTranslate = [
  'Hello world!',
  'How are you today?',
  'Machine translation has revolutionized communication.',
  'The weather is beautiful.',
  'Thank you for your help.',
  'Hello world Again!',
  'How are you today Again?',
  'Machine translation has revolutionized communication again.',
  'The weather is beautiful again.',
  'Thank you for your help again.'
]

async function testBatchTranslation () {
  console.log('\n=== Batch Translation Example ===\n')

  const {
    ensureBergamotModelFiles,
    getBergamotFileNames
  } = require('../lib/bergamot-model-fetcher')

  const srcLang = 'en'
  const dstLang = 'it'

  const bergamotPath = process.env.BERGAMOT_MODEL_PATH || './model/bergamot/enit'

  // Ensure model files are present (downloads if not)
  const modelDir = await ensureBergamotModelFiles(srcLang, dstLang, bergamotPath)
  console.log('Model directory:', modelDir)

  const fileNames = getBergamotFileNames(srcLang, dstLang)

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
    console.log('Done!')
  }
}

testBatchTranslation().catch(console.error)
