'use strict'

/**
 * IndicTrans Example
 *
 * This example demonstrates translation using the IndicTrans2 model
 * for English to Hindi translation (eng_Latn -> hin_Deva).
 *
 * Requires a local IndicTrans model file.
 *
 * Usage:
 *   bare examples/indictrans.js
 *   INDICTRANS_MODEL_PATH=/path/to/model.bin bare examples/indictrans.js
 *
 * Enable verbose C++ logging:
 *   VERBOSE=1 bare examples/indictrans.js
 */

const TranslationNmtcpp = require('../index')
const fs = require('bare-fs')
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

async function main () {
  const modelPath = process.env.INDICTRANS_MODEL_PATH || './models/ggml-indictrans2-en-indic-dist-200M.bin'

  if (!fs.existsSync(modelPath)) {
    console.log('IndicTrans model not found at:', modelPath)
    console.log('Set INDICTRANS_MODEL_PATH env var or place model at ./models/ggml-indictrans2-en-indic-dist-200M.bin')
    return
  }

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
  }
}

main().catch(console.error)
