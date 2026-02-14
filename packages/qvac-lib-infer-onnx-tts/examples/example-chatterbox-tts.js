'use strict'

const path = require('bare-path')
const ONNXTTS = require('../')
const { createWav, readWavAsFloat32, resampleLinear } = require('./wav-helper')
const { setLogger, releaseLogger } = require('../addonLogging')

const CHATTERBOX_SAMPLE_RATE = 24000

const tokenizerPath = 'models/chatterbox/tokenizer.json'
const speechEncoderPath = 'models/chatterbox/speech_encoder.onnx'
const embedTokensPath = 'models/chatterbox/embed_tokens.onnx'
const conditionalDecoderPath = 'models/chatterbox/conditional_decoder.onnx'
const languageModelPath = 'models/chatterbox/language_model.onnx'

const refWavPath = path.join(__dirname, '..', 'test', 'reference-audio', 'jfk.wav')

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

  let referenceAudio
  try {
    const { samples, sampleRate } = readWavAsFloat32(refWavPath)
    if (sampleRate !== CHATTERBOX_SAMPLE_RATE) {
      console.log(`Resampling reference audio from ${sampleRate}Hz to ${CHATTERBOX_SAMPLE_RATE}Hz`)
      referenceAudio = resampleLinear(samples, sampleRate, CHATTERBOX_SAMPLE_RATE)
    } else {
      referenceAudio = samples
    }
    console.log(`Loaded reference audio: ${refWavPath} (${referenceAudio.length} samples @ ${CHATTERBOX_SAMPLE_RATE}Hz)`)
  } catch (err) {
    console.error('Could not load reference audio:', err.message)
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
    createWav(buffer, CHATTERBOX_SAMPLE_RATE, 'chatterbox-output.wav')
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
