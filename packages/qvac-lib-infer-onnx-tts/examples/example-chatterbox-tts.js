'use strict'

const path = require('bare-path')
const ONNXTTS = require('../')
const { createWav, readWavAsFloat32, resampleLinear } = require('./wav-helper')
const { setLogger, releaseLogger } = require('../addonLogging')

const CHATTERBOX_SAMPLE_RATE = 24000

const modeArg = global.Bare ? global.Bare.argv[2] : process.argv[2]
if (!modeArg || !['english', 'multilingual'].includes(modeArg)) {
  console.error('Usage: example-chatterbox-tts.js <english|multilingual>')
  if (global.Bare) global.Bare.exit(1)
  else process.exit(1)
}

const isMultilingual = modeArg === 'multilingual'
const pkgRoot = path.join(__dirname, '..')
const modelsDir = isMultilingual ? 'models/chatterbox-multilingual' : 'models/chatterbox'
const modelDir = path.join(pkgRoot, modelsDir)

const tokenizerPath = path.join(modelDir, 'tokenizer.json')
const speechEncoderPath = path.join(modelDir, 'speech_encoder.onnx')
const embedTokensPath = path.join(modelDir, 'embed_tokens.onnx')
const conditionalDecoderPath = path.join(modelDir, 'conditional_decoder.onnx')
const languageModelPath = path.join(modelDir, 'language_model.onnx')

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

  const language = isMultilingual ? 'it' : 'en'
  const textToSynthesize = isMultilingual
    ? 'Ciao mondo! Questo è un test del sistema Chatterbox TTS. Come stai?'
    : 'Hello world! This is a test of the Chatterbox TTS system. How are you doing?'
  const outputFile = isMultilingual ? 'chatterbox-multilingual-output.wav' : 'chatterbox-output.wav'

  console.log(`Mode: ${modeArg}, language: ${language}, models: ${modelsDir}`)

  const model = new ONNXTTS({
    files: {
      modelDir,
      tokenizer: tokenizerPath,
      speechEncoder: speechEncoderPath,
      embedTokens: embedTokensPath,
      conditionalDecoder: conditionalDecoderPath,
      languageModel: languageModelPath
    },
    engine: 'chatterbox',
    referenceAudio,
    config: {
      language
    },
    logger: console,
    opts: { stats: true }
  })

  try {
    console.log('Loading Chatterbox TTS model...')
    await model.load()
    console.log('Model loaded.')

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
    createWav(buffer, CHATTERBOX_SAMPLE_RATE, outputFile)
    console.log(`Finished writing to ${outputFile}`)
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
