'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const ONNXTTS = require('../')
const { createWav } = require('./wav-helper')
const { setLogger, releaseLogger } = require('../addonLogging')

const SUPERTONIC_SAMPLE_RATE = 44100

const modeArg = global.Bare ? global.Bare.argv[2] : process.argv[2]
if (!modeArg || !['english', 'multilingual'].includes(modeArg)) {
  console.error('Usage: supertonic-tts.js <english|multilingual>')
  if (global.Bare) global.Bare.exit(1)
  else process.exit(1)
}

const isMultilingual = modeArg === 'multilingual'
const pkgRoot = path.join(__dirname, '..')
const modelsDir = isMultilingual ? 'models/supertonic-multilingual' : 'models/supertonic'
const modelDir = path.join(pkgRoot, modelsDir)

if (!fs.existsSync(modelDir)) {
  const ensureCmd = isMultilingual
    ? 'TTS_LANGUAGE=multilingual npm run models:ensure:supertonic'
    : 'npm run models:ensure:supertonic'
  console.error(`Missing model directory: ${modelDir}`)
  console.error(`Run "${ensureCmd}" to download the required models.`)
  if (global.Bare) global.Bare.exit(1)
  else process.exit(1)
}

async function main () {
  setLogger((priority, message) => {
    if (priority > 1) return
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

  const language = isMultilingual ? 'es' : 'en'
  const textToSynthesize = isMultilingual
    ? 'Hola mundo. Esta es una demostración de la síntesis de texto a voz usando Supertonic.'
    : 'Hello world. This is a demonstration of the text to speech synthesis using Supertonic.'
  const outputFile = path.join(__dirname, isMultilingual ? 'supertonic-multilingual-output.wav' : 'supertonic-output.wav')

  console.log(`Mode: ${modeArg}, language: ${language}, models: ${modelsDir}\n`)

  const model = new ONNXTTS({
    files: {
      modelDir
    },
    engine: 'supertonic',
    voiceName: 'F1',
    speed: 1.05,
    numInferenceSteps: 5,
    supertonicMultilingual: isMultilingual,
    config: {
      language
    },
    logger: console,
    opts: { stats: true }
  })

  try {
    console.log('Loading Supertonic TTS model...')
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
      const s = response.stats
      console.log(`Inference stats: totalTime=${s.totalTime.toFixed(2)}s, tokensPerSecond=${s.tokensPerSecond.toFixed(2)}, realTimeFactor=${s.realTimeFactor.toFixed(2)}, audioDuration=${s.audioDurationMs}ms, totalSamples=${s.totalSamples}`)
    }

    console.log('\nWriting to .wav file...')
    createWav(buffer, SUPERTONIC_SAMPLE_RATE, outputFile)
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
