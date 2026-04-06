'use strict'

/**
 * IndicTrans Example
 *
 * This example demonstrates translation using the IndicTrans2 model
 * for English to Hindi translation (eng_Latn → hin_Deva).
 *
 * The model is downloaded via HyperdriveDL from the distributed network.
 *
 * Usage:
 *   bare examples/indictrans.js
 *
 * Enable verbose C++ logging:
 *   VERBOSE=1 bare examples/indictrans.js
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

const text = 'How are you'

const DISK_PATH = './models'
const MODEL_NAME = 'ggml-indictrans2-en-indic-dist-200M.bin'

async function downloadFile (loader, fileName, diskPath) {
  const dl = await loader.download(fileName, { diskPath })
  if (dl) await dl.await()
  return path.join(diskPath, fileName)
}

async function main () {
  const hdDL = new HyperdriveDL({
    key: 'hd://268c2e9b2a3420632e4b6649e32822f42d5dfbda4c7e96daec5b629ed20f99f7'
  })

  await hdDL.ready()

  // Download model to disk first
  console.log('Downloading model...')
  const modelPath = await downloadFile(hdDL, MODEL_NAME, DISK_PATH)

  const model = new TranslationNmtcpp({
    files: { model: modelPath },
    params: { mode: 'full', srcLang: 'eng_Latn', dstLang: 'hin_Deva' },
    config: { modelType: TranslationNmtcpp.ModelTypes.IndicTrans },
    logger
  })

  await model.load()

  try {
    const response = await model.run(text)

    await response
      .onUpdate(data => {
        console.log(data)
      })
      .await()

    console.log('translation finished!')
  } finally {
    await model.unload()
    await hdDL.close()
  }
}

main().catch(console.error)
