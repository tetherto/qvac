'use strict'

const ONNXTTS = require('../')
const HyperDriveDL = require('@qvac/dl-hyperdrive')
const WeightsProvider = require('@qvac/infer-base/WeightsProvider/WeightsProvider')
const { createWav } = require('./wav-generator-helper')

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
  await downloadModelsLocally()

  const args = {
    mainModelUrl,
    configJsonPath,
    // Enable stats logging
    opts: { stats: true },
    eSpeakDataPath: '/path/to/espeak-ng-data' // enter path to espeak-ng-data on your local machine
  }

  const config = {
    language: 'en',
    useGPU: true
  }

  const model = new ONNXTTS(args, config)

  try {
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
        if (data && data.outputArray) {
          buffer = buffer.concat(Array.from(data.outputArray))
        }
        console.log('------------------')
      })
      .await() // Wait for the final result

    console.log('TTS finished!')
    if (response.stats) {
      console.log(`Inference stats: ${JSON.stringify(response.stats)}`)
    }

    console.log('Writing to .wav file...')
    createWav(buffer, 16000)
    console.log('Finished writing to .wav file...')
  } catch (err) {
    console.error('Error during TTS processing:', err)
  } finally {
    console.log('Unloading model...')
    await model.unload()
    console.log('Model unloaded.')
  }
}

main().catch(console.error)
