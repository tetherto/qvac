'use strict'

/**
 * Pivot Translation Example with Bergamot Models
 *
 * This example demonstrates pivot translation through English using two Bergamot models:
 * - First model: Spanish -> English (es-en)
 * - Second model: English -> Italian (en-it)
 * - Result: Spanish -> Italian translation via English pivot
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

const PRIMARY_DISK_PATH = './models/es-en'
const PIVOT_DISK_PATH = './models/en-it'

async function downloadFile (loader, fileName, diskPath) {
  const dl = await loader.download(fileName, { diskPath })
  if (dl) await dl.await()
  return path.join(diskPath, fileName)
}

async function main () {
  console.log('Setting up pivot translation: Spanish -> English -> Italian')
  console.log('-----------------------------------------------------------')
  console.log('Original Spanish text:')
  console.log(spanishText)
  console.log('-----------------------------------------------------------\n')

  // Primary model loader: Spanish -> English
  const primaryLoader = new HyperdriveDL({
    key: 'hd://c3e983c8db3f64faeef8eaf1da9ea4aeb8d5c020529f83957d63c19ed7710651'
  })

  // Pivot model loader: English -> Italian
  const pivotLoader = new HyperdriveDL({
    key: 'hd://a8811fb494e4aee45ca06a011703a25df5275e5dfa59d6217f2d430c677f9fa6'
  })

  await primaryLoader.ready()
  await pivotLoader.ready()

  // Download all model files to disk first
  console.log('Downloading primary model (es-en)...')
  const modelPath = await downloadFile(primaryLoader, 'model.esen.intgemm.alphas.bin', PRIMARY_DISK_PATH)
  const srcVocabPath = await downloadFile(primaryLoader, 'vocab.esen.spm', PRIMARY_DISK_PATH)
  const dstVocabPath = srcVocabPath // Bergamot models often use shared vocab

  console.log('Downloading pivot model (en-it)...')
  const pivotModelPath = await downloadFile(pivotLoader, 'model.enit.intgemm.alphas.bin', PIVOT_DISK_PATH)
  const pivotSrcVocabPath = await downloadFile(pivotLoader, 'vocab.enit.spm', PIVOT_DISK_PATH)
  const pivotDstVocabPath = pivotSrcVocabPath // Shared vocab for en-it

  const model = new TranslationNmtcpp({
    files: {
      model: modelPath,
      srcVocab: srcVocabPath,
      dstVocab: dstVocabPath,
      pivotModel: pivotModelPath,
      pivotSrcVocab: pivotSrcVocabPath,
      pivotDstVocab: pivotDstVocabPath
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
    await primaryLoader.close()
    await pivotLoader.close()
  }
}

// Run the main example
main()
  .catch(console.error)
