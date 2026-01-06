'use strict'

const ONNXTTS = require('../')
const HyperDriveDL = require('@qvac/dl-hyperdrive')
const WeightsProvider = require('@qvac/infer-base/WeightsProvider/WeightsProvider')
const { createWav } = require('./wav-generator-helper')
const { setLogger, releaseLogger } = require('../addonLogging')

// paths to model files locally
const mainModelUrl = './cache/model.onnx'
const configJsonPath = './cache/config.json'

// downloads the model files locally from HD
async function downloadModelsLocally () {
  const hdDL = new HyperDriveDL({ key: 'hd://69581b1431e3abceec7708187922025dec6ccccd291c9e804679fd21371ccd1b' })
  const weightProvider = new WeightsProvider(hdDL)
  await weightProvider.downloadFiles([
    'model.onnx',
    'config.json'
  ], 'cache')
}

async function main () {
  // IMPORTANT: Set up the logger FIRST, before creating any addon instances
  console.log('Setting up C++ logger...')

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

  await downloadModelsLocally()

  const args = {
    mainModelUrl,
    configJsonPath,
    // Enable stats logging
    opts: { stats: true },
    eSpeakDataPath: 'benchmarks/shared-data/espeak-ng-data',
    logger: console
  }

  const config = {
    language: 'en',
    useGPU: false
  }

  const model = new ONNXTTS(args, config)

  try {
    // First run
    console.log('Loading TTS model...')
    await model.load()
    console.log('Model loaded.')

    const textToSynthesize = 'Hello world! This is a test of the TTS system using the ONNX base pattern.'
    console.log(`Running TTS on: "${textToSynthesize}"`)

    const response = await model.run({
      input: textToSynthesize,
      type: 'text'
    })

    console.log('Waiting for TTS results...')
    let buffer = []

    await response
      .onUpdate(data => {
        console.log('--- TTS Update ---')
        if (data && data.outputArray) {
          buffer = buffer.concat(Array.from(data.outputArray))
        }
      })
      .await() // Wait for the final result

    console.log('TTS finished!')
    if (response.stats) {
      console.log(`Inference stats: ${JSON.stringify(response.stats)}`)
    }

    console.log('Writing to .wav file...')
    createWav(buffer, 22050, 'test-en-cpu.wav')
    console.log('Finished writing to .wav file...')

    console.log('Reloading model with new configuration...')

    //Second run
    console.log('Reloading model with new configuration...')
    await model.reload({
      language: 'en',
      useGPU: true
    })
    console.log('Model reloaded with new configuration.')

    const response2 = await model.run({
      input: textToSynthesize,
      type: 'text'
    })

    console.log('Waiting for TTS results...')
    let buffer2 = []

    await response2
      .onUpdate(data => {
        console.log('--- TTS Update ---')
        if (data && data.outputArray) {
          buffer2 = buffer2.concat(Array.from(data.outputArray))
        }
      })
      .await() // Wait for the final result

    console.log('TTS finished!')
    if (response2.stats) {
      console.log(`Inference stats: ${JSON.stringify(response2.stats)}`)
    }

    console.log('Writing to .wav file...')
    createWav(buffer2, 22050, 'test-en-gpu.wav')
    console.log('Finished writing to .wav file...')
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
