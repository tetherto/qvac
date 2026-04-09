'use strict'

/**
 * Pivot Translation Example with Bergamot Models
 *
 * This example demonstrates pivot translation through English using two Bergamot models:
 * - First model: Spanish -> English (es-en)
 * - Second model: English -> Italian (en-it)
 * - Result: Spanish -> Italian translation via English pivot
 *
 * Requires local Bergamot model files for both language pairs.
 *
 * Usage:
 *   bare examples/pivot.example.js
 *   BERGAMOT_ESEN_PATH=./models/es-en BERGAMOT_ENIT_PATH=./models/en-it bare examples/pivot.example.js
 *
 * Enable verbose C++ logging:
 *   VERBOSE=1 bare examples/pivot.example.js
 */

const TranslationNmtcpp = require('../index')
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

// Spanish text to translate to Italian via English pivot
const spanishText = `
  Era una manana soleada cuando Maria decidio visitar el mercado local.
  Compro frutas frescas, verduras y flores para su casa.
  El vendedor le recomendo las mejores manzanas de la temporada.
  Maria tambien encontro un hermoso libro antiguo en una tienda cercana.
  Fue un dia perfecto para explorar la ciudad.
`

async function main () {
  console.log('Setting up pivot translation: Spanish -> English -> Italian')
  console.log('-----------------------------------------------------------')
  console.log('Original Spanish text:')
  console.log(spanishText)
  console.log('-----------------------------------------------------------\n')

  const esenPath = process.env.BERGAMOT_ESEN_PATH || './models/es-en'
  const enitPath = process.env.BERGAMOT_ENIT_PATH || './models/en-it'

  const primaryModel = path.join(esenPath, 'model.esen.intgemm.alphas.bin')
  const primaryVocab = path.join(esenPath, 'vocab.esen.spm')
  const pivotModel = path.join(enitPath, 'model.enit.intgemm.alphas.bin')
  const pivotVocab = path.join(enitPath, 'vocab.enit.spm')

  for (const f of [primaryModel, primaryVocab, pivotModel, pivotVocab]) {
    if (!fs.existsSync(f)) {
      console.log('Missing model file:', f)
      console.log('\nSet BERGAMOT_ESEN_PATH and BERGAMOT_ENIT_PATH env vars or place models in ./models/es-en and ./models/en-it')
      return
    }
  }

  const model = new TranslationNmtcpp({
    files: {
      model: primaryModel,
      srcVocab: primaryVocab,
      dstVocab: primaryVocab,
      pivotModel,
      pivotSrcVocab: pivotVocab,
      pivotDstVocab: pivotVocab
    },
    params: {
      srcLang: 'es',
      dstLang: 'it'
    },
    config: {
      modelType: TranslationNmtcpp.ModelTypes.Bergamot,
      beamsize: 4,
      topk: 100,
      pivotConfig: {
        beamsize: 4,
        topk: 100
      }
    },
    logger
  })

  console.log('Loading models...')
  await model.load()

  try {
    console.log('Starting pivot translation...')
    const response = await model.run(spanishText)

    await response
      .onUpdate(data => {
        process.stdout.write(data)
      }).onFinish(() => {
        console.log('\n\nFinished pivot translation...')
      })
      .await()
  } finally {
    console.log('\n\nUnloading models...')
    await model.unload()
  }
}

main()
  .catch(console.error)
