'use strict'

const path = require('bare-path')
const ONNXTTS = require('../')
const { createWav, readWavAsFloat32 } = require('./wav-generator-helper')
const { setLogger, releaseLogger } = require('../addonLogging')

// Chatterbox model paths
const tokenizerPath = 'models/chatterbox/tokenizer.json'
const speechEncoderPath = 'models/chatterbox/speech_encoder.onnx'
const embedTokensPath = 'models/chatterbox/embed_tokens.onnx'
const conditionalDecoderPath = 'models/chatterbox/conditional_decoder.onnx'
const languageModelPath = 'models/chatterbox/language_model.onnx'

// Reference audio path for voice cloning
const refWavPath = path.join(__dirname, 'ref.wav')

async function main () {
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

  // Reference audio for Chatterbox voice cloning.
  // Load from ref.wav; falls back to synthetic tone if missing.
  let referenceAudio
  try {
    const { samples, sampleRate } = readWavAsFloat32(refWavPath)
    referenceAudio = samples
    console.log(`Loaded reference audio: ${refWavPath} (${samples.length} samples, ${sampleRate} Hz)`)
    if (sampleRate !== 24000) {
      console.log('Note: Chatterbox expects 24 kHz; resample ref.wav if output sounds wrong.')
    }
  } catch (err) {
    console.log('Could not load ref.wav: ', err.message)
    throw err
  }

  // Chatterbox configuration
  const chatterboxArgs = {
    tokenizerPath,
    speechEncoderPath,
    embedTokensPath,
    conditionalDecoderPath,
    languageModelPath,
    referenceAudio,
    opts: { stats: true },
    logger: console
  }

  const config = {
    language: 'en'
  }

  const model = new ONNXTTS(chatterboxArgs, config)

  try {
    console.log('Loading Chatterbox TTS model...')
    await model.load()
    console.log('Model loaded.')

    const textToSynthesize = 'Hello world! This is a test of the Chatterbox TTS system. how are you doing'
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
      .await()

    console.log('TTS finished!')
    if (response.stats) {
      console.log(`Inference stats: ${JSON.stringify(response.stats)}`)
    }

    console.log('Writing to .wav file...')
    // Chatterbox uses 24kHz sample rate
    createWav(buffer, 24000, 'chatterbox-output.wav')
    console.log('Finished writing to chatterbox-output.wav')
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
