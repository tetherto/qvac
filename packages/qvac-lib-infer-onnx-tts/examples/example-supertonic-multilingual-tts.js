'use strict'

const path = require('bare-path')
const ONNXTTS = require('..')
const { createWav } = require('./wav-helper')
const { setLogger, releaseLogger } = require('../addonLogging')

const SUPERTONIC_SAMPLE_RATE = 44100

// Supertone multilingual weights (HF supertonic-2); run `node scripts/ensure-models.js` or ensureSupertonicModelsMultilingual
const modelDir = path.resolve(path.join(__dirname, '..', 'models', 'supertonic-multilingual'))

async function main () {
  setLogger((priority, message) => {
    const priorityNames = {
      0: 'ERROR',
      1: 'WARNING',
      2: 'INFO',
      3: 'DEBUG',
      4: 'OFF'
    }
    const priorityName = priorityNames[priority] || 'UNKNOWN'
    const timestamp = new Date().toISOString()
    console.log(`[${timestamp}] [C++ log] [${priorityName}]: ${message}`)
  })

  const model = new ONNXTTS({
    files: {
      modelDir
    },
    engine: 'supertonic',
    voiceName: 'F1',
    speed: 1.05,
    numInferenceSteps: 5,
    supertonicMultilingual: true,
    config: {
      language: 'es'
    },
    logger: console,
    opts: { stats: true }
  })

  try {
    console.log('Loading Supertonic multilingual (Spanish) TTS model...')
    await model.load()
    console.log('Model loaded.')

    const textToSynthesize =
      'Hola mundo. Esta es una demostración de síntesis de voz con Supertonic en español.'
    console.log(`Running TTS on: "${textToSynthesize}"`)

    const response = await model.run({
      input: textToSynthesize,
      type: 'text'
    })

    let buffer = []

    await response
      .onUpdate(data => {
        if (data && data.outputArray) {
          buffer = buffer.concat(Array.from(data.outputArray))
        }
      })
      .await()

    console.log('TTS finished!')
    if (response.stats) {
      console.log(`Inference stats: ${JSON.stringify(response.stats)}`)
    }

    createWav(buffer, SUPERTONIC_SAMPLE_RATE, 'supertonic-output-es.wav')
    console.log('Finished writing to supertonic-output-es.wav')
  } catch (err) {
    console.error('Error during TTS processing:', err)
  } finally {
    await model.unload()
    releaseLogger()
  }
}

main().catch(console.error)
