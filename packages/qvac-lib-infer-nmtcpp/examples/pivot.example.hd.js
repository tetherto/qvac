'use strict'

/**
 * Pivot Translation Example with Bergamot Models
 *
 * This example demonstrates pivot translation through English using two Bergamot models:
 * - First model: Spanish → English (es-en)
 * - Second model: English → Italian (en-it)
 * - Result: Spanish → Italian translation via English pivot
 *
 * The models are downloaded via HyperdriveDL from the distributed network.
 *
 * Usage:
 *   bare examples/pivot.example.hd.js
 *
 * Enable verbose C++ logging:
 *   VERBOSE=1 bare examples/pivot.example.hd.js
 */

const HyperdriveDL = require('@qvac/dl-hyperdrive')
const TranslationNmtcpp = require('../index')
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

// Spanish text to translate to Italian via English pivot
const spanishText = `
  Era una mañana soleada cuando María decidió visitar el mercado local.
  Compró frutas frescas, verduras y flores para su casa.
  El vendedor le recomendó las mejores manzanas de la temporada.
  María también encontró un hermoso libro antiguo en una tienda cercana.
  Fue un día perfecto para explorar la ciudad.
`

async function main () {
  console.log('Setting up pivot translation: Spanish → English → Italian')
  console.log('-----------------------------------------------------------')
  console.log('Original Spanish text:')
  console.log(spanishText)
  console.log('-----------------------------------------------------------\n')

  // Primary model loader: Spanish → English
  const primaryLoader = new HyperdriveDL({
    key: 'hd://c3e983c8db3f64faeef8eaf1da9ea4aeb8d5c020529f83957d63c19ed7710651' // es-en model
  })

  // Pivot model loader: English → Italian
  const pivotLoader = new HyperdriveDL({
    key: 'hd://a8811fb494e4aee45ca06a011703a25df5275e5dfa59d6217f2d430c677f9fa6' // en-it model
  })

  const args = {
    loader: primaryLoader,
    params: {
      srcLang: 'es',
      dstLang: 'it' // Final target language
    },
    diskPath: './models/es-en',
    modelName: 'model.esen.intgemm.alphas.bin',
    logger // Pass logger to enable/disable C++ logs
  }

  const config = {
    modelType: TranslationNmtcpp.ModelTypes.Bergamot,

    // Primary model vocabulary files (Spanish → English)
    srcVocabName: 'vocab.esen.spm',
    dstVocabName: 'vocab.esen.spm', // Bergamot models often use shared vocab

    // Pivot model configuration (English → Italian)
    bergamotPivotModel: {
      loader: pivotLoader,
      modelName: 'model.enit.intgemm.alphas.bin',
      diskPath: './models/en-it',
      config: {
        srcVocabName: 'vocab.enit.spm',
        dstVocabName: 'vocab.enit.spm', // Shared vocab for en-it
        // Any pivot model specific configuration
        beamsize: 4,
        topk: 100
      }
    },

    // Primary model configuration
    beamsize: 4,
    topk: 100
  }

  const model = new TranslationNmtcpp(args, config)

  console.log('Loading models...')
  await model.load()

  try {
    console.log('Starting pivot translation...')
    const response = await model.run(spanishText)

    await response
      .onUpdate(data => {
        process.stdout.write(data)
      })
      .await()
  } finally {
    console.log('Unloading models...')
    await model.unload()
  }
}

// Run the main example
main()
  .catch(console.error)
