'use strict'

/**
 * Parler-TTS batch synthesis for @qvac/tts-ggml.
 *
 * Loads a Parler GGUF (mini / large / indic variant — the addon detects
 * the variant from the filename, tts-cpp reads everything else from the
 * GGUF metadata) and synthesizes a single utterance.  Parler is a
 * description-conditioned engine: the voice is controlled either by a
 * full free-text `description`, or by template fields (`voice`,
 * `emotion`, `pitch`, `pace`, ...) that the native layer renders in the
 * models' training-caption phrasing.  Everything is optional — with no
 * description configuration at all the models' recommended fallback
 * caption is used.  Native output is 44.1 kHz.
 *
 * The `emotion` flag accepts the 12 trained speaking styles: command,
 * anger, narration, conversation, disgust, fear, happy, neutral,
 * proper noun, news, sad, surprise.  Emotion can also be switched
 * per call: `model.run({ input, emotion: 'sad' })`.
 *
 * Usage:
 *   bare examples/parler-tts.js "text to synthesize" [voice] [emotion]
 *
 * Examples:
 *   bare examples/parler-tts.js "Hey, how are you doing today?"
 *   bare examples/parler-tts.js "Hey, how are you doing today?" Laura happy
 *
 * Expects a Parler GGUF (e.g. parler-mini-v1-q8_0.gguf) under:
 *   models/
 * Download with `node scripts/download-tts-ggml-models.js --group parler`.
 *
 * NOTE: Parler runs on Metal (Apple) when `useGPU: true` / `nGpuLayers` is set
 * (~2.25x vs CPU on indic q8_0); other backends fall back to CPU.
 */

const path = require('bare-path')
const TTSGgml = require('../')
const { createWav } = require('./wav-helper')
const { setLogger, releaseLogger } = require('../addonLogging')

const PARLER_SAMPLE_RATE = 44100

const argv = global.Bare ? global.Bare.argv : process.argv
const textArg = argv[2]
const voiceArg = argv[3]
const emotionArg = argv[4]

if (!textArg || typeof textArg !== 'string' || textArg.trim().length === 0) {
  console.error('Usage: parler-tts.js "<text to synthesize>" [voice] [emotion]')
  if (global.Bare) global.Bare.exit(1)
  else process.exit(1)
}

const pkgRoot = path.join(__dirname, '..')
const modelDir = path.join(pkgRoot, 'models')

async function main() {
  setLogger((priority, message) => {
    if (priority > 1) return
    const names = { 0: 'ERROR', 1: 'WARNING', 2: 'INFO', 3: 'DEBUG', 4: 'OFF' }
    const name = names[priority] || 'UNKNOWN'
    console.log(`[${new Date().toISOString()}] [C++ log] [${name}]: ${message}`)
  })

  const outputFile = path.join(__dirname, 'parler-output.wav')

  const model = new TTSGgml({
    engine: TTSGgml.ENGINE_PARLER,
    files: { modelDir },
    voice: voiceArg || 'Laura',
    ...(emotionArg ? { emotion: emotionArg } : {}),
    logger: console,
    opts: { stats: true }
  })

  try {
    console.log('Loading Parler TTS model...')
    await model.load()
    console.log('Model loaded.')

    console.log(
      `Running TTS on: "${textArg}" (voice=${voiceArg || 'Laura'}${emotionArg ? `, emotion=${emotionArg}` : ''})`
    )

    const response = await model.run({ input: textArg, type: 'text' })

    let buffer = []
    await response
      .onUpdate((data) => {
        if (data && data.outputArray) {
          buffer = buffer.concat(Array.from(data.outputArray))
        }
      })
      .await()

    console.log('TTS finished!')
    if (response.stats) {
      const s = response.stats
      console.log(
        `Inference stats: totalTime=${s.totalTime.toFixed(2)}s, tokensPerSecond=${s.tokensPerSecond.toFixed(2)}, realTimeFactor=${s.realTimeFactor.toFixed(3)}, audioDuration=${s.audioDurationMs}ms, totalSamples=${s.totalSamples}`
      )
    }

    console.log('\nWriting to .wav file...')
    createWav(buffer, PARLER_SAMPLE_RATE, outputFile)
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
