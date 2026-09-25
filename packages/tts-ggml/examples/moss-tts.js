'use strict'

/**
 * MOSS batch and streaming synthesis for @qvac/tts-ggml.
 *
 * MOSS Delay is an autoregressive model that predicts 32 RVQ codebooks per
 * 80 ms frame on a delay pattern, and a transformer codec turns those codes
 * back into 24 kHz audio.  It ships as three GGUFs -- the backbone, the
 * codec's synthesis half, and the codec's analysis half -- and text-only
 * synthesis never touches the analysis half.
 *
 * Voice cloning is fully in-process: pass a reference recording and the
 * analysis half encodes it into the prompt.  Set QVAC_TTS_MOSS_STREAM_FRAMES
 * to stream fixed-size chunks (codec frames, 12.5 per second) instead of
 * waiting for the whole utterance.
 *
 * Usage:
 *   bare examples/moss-tts.js "text to synthesize" [reference.wav]
 *
 * Examples:
 *   bare examples/moss-tts.js "Hello from a fully on-device pipeline."
 *   bare examples/moss-tts.js "Cloned speech." voice.wav
 *   QVAC_TTS_MOSS_STREAM_FRAMES=25 bare examples/moss-tts.js "Streamed speech."
 *   QVAC_TTS_MOSS_GPU=1 bare examples/moss-tts.js "GPU synthesis."
 *   QVAC_TTS_MOSS_DURATION=38 bare examples/moss-tts.js "About three seconds [pause 0.5s] long."
 *
 * Expects the MOSS GGUFs (moss-tts-delay-f16.gguf,
 * moss-codec-decoder-f16.gguf, and, to clone, moss-codec-encoder-f16.gguf)
 * under:
 *   models/
 * Produce them with the converters in qvac-fabric-speech.cpp
 * (engines/tts/scripts/convert-moss-delay-to-gguf.py and
 * convert-moss-codec-to-gguf.py) until they are published to the model
 * registry.  A reference recording must be sampled at 24 kHz.
 */

const path = require('bare-path')
const proc = require('bare-process')
const TTSGgml = require('../')
const { createWav } = require('./wav-helper')
const { setLogger, releaseLogger } = require('../addonLogging')

const MOSS_SAMPLE_RATE = 24000
const DEFAULT_LANGUAGE = 'en'

const argv = global.Bare ? global.Bare.argv : process.argv
const textArg = argv[2]
const referenceAudioArg = argv[3]
const streamFrames = Number(proc.env.QVAC_TTS_MOSS_STREAM_FRAMES || 0)
const durationTokens = Number(proc.env.QVAC_TTS_MOSS_DURATION || 0)

function fail(message) {
  console.error(message)
  if (global.Bare) global.Bare.exit(1)
  else process.exit(1)
}

if (!textArg || typeof textArg !== 'string' || textArg.trim().length === 0) {
  fail('Usage: moss-tts.js "<text to synthesize>" [reference.wav]')
}

const pkgRoot = path.join(__dirname, '..')
const modelDir = path.join(pkgRoot, 'models')

function buildModel() {
  const voice = referenceAudioArg ? { referenceAudio: path.resolve(referenceAudioArg) } : {}
  const streaming = streamFrames > 0 ? { streamChunkTokens: streamFrames } : {}
  const duration = durationTokens > 0 ? { durationTokens } : {}
  return new TTSGgml({
    engine: TTSGgml.ENGINE_MOSS,
    files: { modelDir },
    ...voice,
    ...streaming,
    ...duration,
    config: {
      language: DEFAULT_LANGUAGE,
      useGPU: proc.env.QVAC_TTS_MOSS_GPU === '1'
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

function appendChunk(buffer, data) {
  if (!data || !data.outputArray) return buffer
  if (streamFrames > 0) console.log(`chunk: ${data.outputArray.length} samples`)
  return buffer.concat(Array.from(data.outputArray))
}

async function collectPcm(response) {
  let buffer = []
  await response
    .onUpdate((data) => {
      buffer = appendChunk(buffer, data)
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

  const outputFile = path.join(__dirname, 'moss-output.wav')
  const model = buildModel()

  try {
    console.log('Loading MOSS TTS model...')
    await model.load()
    console.log('Model loaded.')

    const how = referenceAudioArg ? `cloning ${referenceAudioArg}` : 'default speaker'
    console.log(`Running TTS on: "${textArg}" (${how})`)

    const response = await model.run({ input: textArg, type: 'text' })
    const buffer = await collectPcm(response)

    console.log('TTS finished!')
    reportStats(response.stats)

    console.log('\nWriting to .wav file...')
    createWav(buffer, MOSS_SAMPLE_RATE, outputFile)
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
