'use strict'

/**
 * Batch Translation Example
 *
 * This example demonstrates how to use the runBatch() method to translate
 * multiple texts in a single batch operation, which is more efficient than
 * translating texts one at a time.
 *
 * Usage:
 *   bare examples/batch.example.js
 *
 * Environment Variables:
 *   BERGAMOT_MODEL_PATH - Path to Bergamot model directory (default: ./model/bergamot/enit)
 */

const TranslationNmtcpp = require('..')
const fs = require('bare-fs')
const path = require('bare-path')
const process = require('bare-process')

// Sample texts to translate (English to Italian)
const textsToTranslate = [
  'Hello world!',
  'How are you today?',
  'Machine translation has revolutionized communication.',
  'The weather is beautiful.',
  'Thank you for your help.'
]

async function testBatchTranslation () {
  console.log('\n=== Batch Translation Example ===\n')

  // Create logger
  const logger = {
    info: (msg) => console.log('[INFO]', msg),
    warn: (msg) => console.warn('[WARN]', msg),
    error: (msg) => console.error('[ERROR]', msg),
    debug: (msg) => {} // Suppress debug logs
  }

  // Use local model path for Bergamot
  const bergamotPath = process.env.BERGAMOT_MODEL_PATH || './model/bergamot/enit'

  console.log('Model path:', bergamotPath)

  // Check if model directory exists
  if (!fs.existsSync(bergamotPath)) {
    console.log('Bergamot model directory not found!')
    console.log('Set BERGAMOT_MODEL_PATH env var or place model in ./model/bergamot/enit')
    console.log('\nExpected files:')
    console.log('  - model.enit.intgemm.alphas.bin')
    console.log('  - vocab.enit.spm')
    return
  }

  // Create a local file loader
  const localLoader = {
    ready: async () => {},
    close: async () => {},
    download: async (filename) => {
      const filePath = path.join(bergamotPath, filename)
      return fs.readFileSync(filePath)
    },
    getFileSize: async (filename) => {
      const filePath = path.join(bergamotPath, filename)
      const stats = fs.statSync(filePath)
      return stats.size
    }
  }

  // Create model args
  const args = {
    loader: localLoader,
    params: { mode: 'full', dstLang: 'it', srcLang: 'en' },
    diskPath: bergamotPath,
    modelName: 'model.enit.intgemm.alphas.bin',
    logger
  }

  // Config for Bergamot model
  const config = {
    srcVocabName: 'vocab.enit.spm',
    dstVocabName: 'vocab.enit.spm',
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
    await localLoader.close()
    console.log('Done!')
  }
}

testBatchTranslation().catch(console.error)
