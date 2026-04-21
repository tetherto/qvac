'use strict'

/**
 * End-to-end Chatterbox TTS smoke test for @qvac/tts-ggml.
 *
 * Usage:
 *   bare examples/chatterbox-tts.js "text to synthesize" [path/to/reference.wav]
 *
 * Examples:
 *   bare examples/chatterbox-tts.js "Hello from qvac-tts ggml"
 *   bare examples/chatterbox-tts.js "Quick brown fox" ~/voices/me.wav
 *
 * Expects the two Chatterbox GGUF files at:
 *   models/chatterbox-t3-turbo.gguf
 *   models/chatterbox-s3gen.gguf
 *
 * Streaming is not exposed by the v0 addon yet — each `run()` call reloads
 * the model via `qvac_tts_cli_main` (~700 ms + inference).  A streaming
 * example will land when the persistent-engine milestone does.
 */

const fs = require('bare-fs')
const path = require('bare-path')
const TTSGgml = require('../')
const { createWav } = require('./wav-helper')
const { setLogger, releaseLogger } = require('../addonLogging')

const CHATTERBOX_SAMPLE_RATE = 24000

const argv = global.Bare ? global.Bare.argv : process.argv
const textArg = argv[2]
const refAudioArg = argv[3]

if (!textArg || typeof textArg !== 'string' || textArg.trim().length === 0) {
  console.error('Usage: chatterbox-tts.js "<text to synthesize>" [path/to/reference.wav]')
  if (global.Bare) global.Bare.exit(1)
  else process.exit(1)
}

const pkgRoot = path.join(__dirname, '..')
const modelDir = path.join(pkgRoot, 'models')
const t3Model = path.join(modelDir, 'chatterbox-t3-turbo.gguf')
const s3genModel = path.join(modelDir, 'chatterbox-s3gen.gguf')

for (const f of [t3Model, s3genModel]) {
  if (!fs.existsSync(f)) {
    console.error(`Missing model file: ${f}`)
    console.error('Run "npm run models:ensure:chatterbox" to download the required GGUFs.')
    if (global.Bare) global.Bare.exit(1)
    else process.exit(1)
  }
}

const defaultRefWav = path.join(pkgRoot, 'test', 'reference-audio', 'jfk.wav')
const refAudio = refAudioArg || defaultRefWav

if (!fs.existsSync(refAudio)) {
  console.error(`Reference audio not found: ${refAudio}`)
  if (global.Bare) global.Bare.exit(1)
  else process.exit(1)
}

if (!refAudioArg) {
  console.warn(`\x1b[33mNo reference audio provided, using default: ${path.relative(pkgRoot, defaultRefWav)}\x1b[0m`)
}

async function main () {
  setLogger((priority, message) => {
    if (priority > 1) return
    const names = { 0: 'ERROR', 1: 'WARNING', 2: 'INFO', 3: 'DEBUG', 4: 'OFF' }
    const name = names[priority] || 'UNKNOWN'
    console.log(`[${new Date().toISOString()}] [C++ log] [${name}]: ${message}`)
  })

  const outputFile = path.join(__dirname, 'chatterbox-output.wav')

  const model = new TTSGgml({
    files: { modelDir },
    referenceAudio: refAudio,
    config: { language: 'en' },
    logger: console,
    opts: { stats: true }
  })

  try {
    console.log('Loading Chatterbox TTS model...')
    await model.load()
    console.log('Model loaded.')

    console.log(`Running TTS on: "${textArg}"`)

    const response = await model.run({ input: textArg, type: 'text' })

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
    throw err
  } finally {
    console.log('Unloading model...')
    await model.unload()
    console.log('Model unloaded.')
    releaseLogger()
  }
}

main().catch(err => {
  console.error(err)
  if (global.Bare) global.Bare.exit(1)
  else process.exit(1)
})
