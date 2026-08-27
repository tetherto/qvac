'use strict'

/**
 * Audio8 batch synthesis for @qvac/tts-ggml.
 *
 * Audio8 is a DualAR model: a 24-layer autoregressive transformer picks a
 * semantic token per 46 ms frame, a 4-layer head fills the seven acoustic
 * codebooks under it, and a DAC-style codec turns the eight codes back into
 * 44.1 kHz audio.  It ships as three GGUFs -- the language model, the codec's
 * synthesis half, and the codec's analysis half -- because they have different
 * lifetimes: text-only synthesis never touches the analysis half.
 *
 * Voice cloning is fully in-process.  Pass a reference recording plus the
 * transcript of what is said in it; the analysis half encodes the recording to
 * codes and the model continues that speaker.  The transcript is not optional
 * in practice: the model conditions on it as the turn the reference answers,
 * and a wrong one degrades the clone.
 *
 * Usage:
 *   bare examples/audio8-tts.js "text to synthesize" [reference.wav] [reference text]
 *
 * Examples:
 *   bare examples/audio8-tts.js "Hello from a fully on-device pipeline."
 *   bare examples/audio8-tts.js "Cloned speech." voice.wav "What the recording says."
 *   QVAC_TTS_AUDIO8_GPU=1 bare examples/audio8-tts.js "Vulkan synthesis."
 *
 * Expects the Audio8 GGUFs (audio8-lm-q8_0.gguf,
 * audio8-codec-decoder-q8_0.gguf, and, to clone,
 * audio8-codec-encoder-q8_0.gguf) under:
 *   models/
 * Produce them with the converters in qvac-fabric-speech.cpp
 * (engines/tts/scripts/convert-audio8-{lm,codec}-to-gguf.py) until they are
 * published to the model registry.
 *
 * GPU offload uses Vulkan on Linux and Windows. CPU remains the default.
 */

const path = require('bare-path')
const proc = require('bare-process')
const TTSGgml = require('../')
const { createWav } = require('./wav-helper')
const { setLogger, releaseLogger } = require('../addonLogging')

const AUDIO8_SAMPLE_RATE = 44100
const DEFAULT_LANGUAGE = 'en'

const argv = global.Bare ? global.Bare.argv : process.argv
const textArg = argv[2]
const referenceAudioArg = argv[3]
const referenceTextArg = argv[4]

function fail(message) {
  console.error(message)
  if (global.Bare) global.Bare.exit(1)
  else process.exit(1)
}

if (!textArg || typeof textArg !== 'string' || textArg.trim().length === 0) {
  fail('Usage: audio8-tts.js "<text to synthesize>" [reference.wav] [reference text]')
}

if (referenceAudioArg && !referenceTextArg) {
  fail('A reference recording needs the transcript of what it says as the next argument.')
}

const pkgRoot = path.join(__dirname, '..')
const modelDir = path.join(pkgRoot, 'models')

function buildModel() {
  const voice = referenceAudioArg
    ? { referenceAudio: path.resolve(referenceAudioArg), referenceText: referenceTextArg }
    : {}
  return new TTSGgml({
    engine: TTSGgml.ENGINE_AUDIO8,
    files: { modelDir },
    ...voice,
    config: {
      language: DEFAULT_LANGUAGE,
      useGPU: proc.env.QVAC_TTS_AUDIO8_GPU === '1'
    },
    logger: console,
    opts: { stats: true }
  })
}

function reportStats(stats) {
  if (!stats) return
  console.log(
    `Inference stats: totalTime=${stats.totalTime.toFixed(2)}s, ` +
      `framesPerSecond=${stats.tokensPerSecond.toFixed(2)}, ` +
      `realTimeFactor=${stats.realTimeFactor.toFixed(3)}, ` +
      `audioDuration=${stats.audioDurationMs}ms, totalSamples=${stats.totalSamples}, ` +
      `backendDevice=${stats.backendDevice}, backendId=${stats.backendId}`
  )
}

async function collectPcm(response) {
  let buffer = []
  await response
    .onUpdate((data) => {
      if (data && data.outputArray) {
        buffer = buffer.concat(Array.from(data.outputArray))
      }
    })
    .await()
  return buffer
}

async function main() {
  setLogger((priority, message) => {
    if (priority > 1) return
    const names = { 0: 'ERROR', 1: 'WARNING', 2: 'INFO', 3: 'DEBUG', 4: 'OFF' }
    const name = names[priority] || 'UNKNOWN'
    console.log(`[${new Date().toISOString()}] [C++ log] [${name}]: ${message}`)
  })

  const outputFile = path.join(__dirname, 'audio8-output.wav')
  const model = buildModel()

  try {
    console.log('Loading Audio8 TTS model...')
    await model.load()
    console.log('Model loaded.')

    const how = referenceAudioArg ? `cloning ${referenceAudioArg}` : 'default speaker'
    console.log(`Running TTS on: "${textArg}" (${how})`)

    const response = await model.run({ input: textArg, type: 'text' })
    const buffer = await collectPcm(response)

    console.log('TTS finished!')
    reportStats(response.stats)

    console.log('\nWriting to .wav file...')
    createWav(buffer, AUDIO8_SAMPLE_RATE, outputFile)
    console.log(`Finished writing to ${outputFile}`)
  } catch (err) {
    console.error('Error during TTS processing:', err)
    throw err
  } finally {
    console.log('Unloading model...')
    await model.unload()
    console.log('Model unloaded.')
    releaseLogger()
  }
}

main().catch((err) => {
  console.error(err)
  if (global.Bare) global.Bare.exit(1)
  else process.exit(1)
})
