'use strict'

/** Batch TTS: `run({ input })`. Chunked output: `run({ input, streamOutput: true })`. Streaming text in: `runStreaming(...)` — see `chatterbox-streaming-tts.js`. */

const fs = require('bare-fs')
const path = require('bare-path')
const ONNXTTS = require('../')
const { createWav, readWavAsFloat32, resampleLinear } = require('./wav-helper')
const { setLogger, releaseLogger } = require('../addonLogging')

const CHATTERBOX_SAMPLE_RATE = 24000

const argv = global.Bare ? global.Bare.argv : process.argv
const modeArg = argv[2]
const refAudioArg = argv[3]

if (!modeArg || !['english', 'multilingual'].includes(modeArg)) {
  console.error('Usage: chatterbox-tts.js <english|multilingual> [path/to/reference.wav]')
  if (global.Bare) global.Bare.exit(1)
  else process.exit(1)
}

const os = require('bare-os')
const variant = os.getEnv('CHATTERBOX_VARIANT') || 'q4'

const isMultilingual = modeArg === 'multilingual'
const pkgRoot = path.join(__dirname, '..')
const modelsDir = isMultilingual ? 'models/chatterbox-multilingual' : 'models/chatterbox'
const modelDir = path.join(pkgRoot, modelsDir)

const suffix = variant === 'fp32' ? '' : `_${variant}`
const nonLmSuffix = isMultilingual ? '' : suffix

const tokenizerPath = path.join(modelDir, 'tokenizer.json')
const speechEncoderPath = path.join(modelDir, `speech_encoder${nonLmSuffix}.onnx`)
const embedTokensPath = path.join(modelDir, `embed_tokens${nonLmSuffix}.onnx`)
const conditionalDecoderPath = path.join(modelDir, `conditional_decoder${nonLmSuffix}.onnx`)
const languageModelPath = path.join(modelDir, `language_model${suffix}.onnx`)

const requiredFiles = [tokenizerPath, speechEncoderPath, embedTokensPath, conditionalDecoderPath, languageModelPath]
for (const f of requiredFiles) {
  if (!fs.existsSync(f)) {
    const ensureCmd = isMultilingual
      ? 'TTS_LANGUAGE=multilingual npm run models:ensure:chatterbox'
      : 'npm run models:ensure:chatterbox'
    console.error(`Missing model file: ${f}`)
    console.error(`Run "${ensureCmd}" to download the required models.`)
    if (global.Bare) global.Bare.exit(1)
    else process.exit(1)
  }
}

const defaultRefWavPath = path.join(__dirname, '..', 'test', 'reference-audio', 'jfk.wav')
const refWavPath = refAudioArg || defaultRefWavPath

if (!refAudioArg) {
  const proc = require('bare-process')
  const relPath = path.relative(proc.cwd(), defaultRefWavPath)
  console.warn(`\x1b[33mNo reference audio provided, using default: ${relPath}\x1b[0m`)
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

  const language = isMultilingual ? 'pt' : 'en'
  const textToSynthesize = isMultilingual
    ? 'Olá mundo. Esta é uma demonstração da síntese de texto em voz usando Chatterbox.'
    : 'Hello world. This is a demonstration of the text to speech synthesis using Chatterbox.'
  const outputFile = path.join(__dirname, isMultilingual ? 'chatterbox-multilingual-output.wav' : 'chatterbox-output.wav')

  console.log(`Mode: ${modeArg}, language: ${language}, models: ${modelsDir}\n`)

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
      const s = response.stats
      console.log(`Inference stats: totalTime=${s.totalTime.toFixed(2)}s, tokensPerSecond=${s.tokensPerSecond.toFixed(2)}, realTimeFactor=${s.realTimeFactor.toFixed(2)}, audioDuration=${s.audioDurationMs}ms, totalSamples=${s.totalSamples}`)
    }

    console.log('\nWriting to .wav file...')
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
