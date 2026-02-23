'use strict'

const path = require('bare-path')
const ONNXTTS = require('../')
const { createWav } = require('./wav-helper')
const { setLogger, releaseLogger } = require('../addonLogging')

const SUPERTONIC_SAMPLE_RATE = 44100

// Model dir relative to package root (run from package root or set SUPERTONIC_MODEL_DIR)
const modelDir = path.join(__dirname, '..', 'models', 'supertonic')

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

  // Supertonic configuration: modelDir + voiceName (paths are derived inside the package)
  const supertonicArgs = {
    modelDir,
    voiceName: 'F1',
    speed: 1,
    numInferenceSteps: 5,
    opts: { stats: true },
    logger: console
  }

  const config = {
    language: 'es'
  }

  const model = new ONNXTTS(supertonicArgs, config)

  try {
    console.log('Loading Supertonic TTS model...')
    await model.load()
    console.log('Model loaded.')

    const textToSynthesize = 'Hola mundo! Esto es una prueba de la sistema de TTS Supertonic.'
    console.log(`Running TTS on: "${textToSynthesize}"`)

    const response = await model.run({
      input: textToSynthesize,
      type: 'text'
    })

    console.log('Waiting for TTS results...')
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

    console.log('Writing to .wav file...')
    createWav(buffer, SUPERTONIC_SAMPLE_RATE, 'supertonic-output.wav')
    console.log('Finished writing to supertonic-output.wav')
  } catch (err) {
    console.error('Error during TTS processing:', err)
  } finally {
    console.log('Unloading model...')
    await model.unload()
    console.log('Model unloaded.')
    releaseLogger()
  }
}

main().catch(console.error)
