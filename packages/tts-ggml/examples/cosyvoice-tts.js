'use strict'

/**
 * CosyVoice3 TTS batch synthesis for @qvac/tts-ggml.
 *
 * Loads the Fun-CosyVoice3-0.5B model directory (Qwen2 speech LM + DiT flow +
 * CausalHiFT vocoder, plus the Qwen2 BPE tokenizer and a baked default voice)
 * and synthesizes a single utterance.  CPU-only (iteration 1); native 24 kHz.
 *
 * Usage:
 *   bare examples/cosyvoice-tts.js "text to synthesize" [modelDir]
 *
 * Examples:
 *   bare examples/cosyvoice-tts.js "Hello from a fully on-device C++ pipeline."
 *   bare examples/cosyvoice-tts.js "Peer to peer, local first." /path/to/cosyvoice3
 *
 * The model directory is produced by
 * qvac-ext-lib-whisper.cpp/tts-cpp/scripts/assemble-cosyvoice3-model.py and
 * must contain:
 *   cosyvoice3-llm-*.gguf  cosyvoice3-flow-*.gguf  cosyvoice3-hift-*.gguf
 *   voice.gguf  vocab.json  merges.txt
 * Default location: models/cosyvoice3/ (override with the 2nd arg or
 * COSYVOICE_MODEL_DIR).
 */

const fs = require('bare-fs')
const path = require('bare-path')
const proc = require('bare-process')
const TTSGgml = require('../')
const { createWav } = require('./wav-helper')
const { setLogger, releaseLogger } = require('../addonLogging')

const COSYVOICE_SAMPLE_RATE = 24000

const argv = global.Bare ? global.Bare.argv : process.argv
const env = proc.env || {}
const textArg = argv[2]
const modelDirArg = argv[3]

if (!textArg || typeof textArg !== 'string' || textArg.trim().length === 0) {
  console.error('Usage: cosyvoice-tts.js "<text to synthesize>" [modelDir]')
  if (global.Bare) global.Bare.exit(1)
  else process.exit(1)
}

const pkgRoot = path.join(__dirname, '..')
const cosyvoiceModelDir =
  modelDirArg || env.COSYVOICE_MODEL_DIR || path.join(pkgRoot, 'models', 'cosyvoice3')

if (!fs.existsSync(cosyvoiceModelDir)) {
  console.error(`Missing CosyVoice3 model directory: ${cosyvoiceModelDir}`)
  console.error(
    'Assemble one with tts-cpp/scripts/assemble-cosyvoice3-model.py, then pass it ' +
      'as the 2nd arg or set COSYVOICE_MODEL_DIR.'
  )
  if (global.Bare) global.Bare.exit(1)
  else process.exit(1)
}

async function main () {
  setLogger((priority, message) => {
    if (priority > 1) return
    const names = { 0: 'ERROR', 1: 'WARNING', 2: 'INFO', 3: 'DEBUG', 4: 'OFF' }
    const name = names[priority] || 'UNKNOWN'
    console.log(`[${new Date().toISOString()}] [C++ log] [${name}]: ${message}`)
  })

  const outputFile = path.join(__dirname, 'cosyvoice-output.wav')

  const model = new TTSGgml({
    engine: TTSGgml.ENGINE_COSYVOICE3,
    files: { cosyvoiceModelDir },
    config: { language: 'en' },
    logger: console,
    opts: { stats: true }
  })

  try {
    console.log('Loading CosyVoice3 TTS model...')
    await model.load()
    console.log('Model loaded.')

    console.log(`Running TTS on: "${textArg}"`)

    const response = await model.run({ input: textArg, type: 'text' })

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
      console.log(`Inference stats: totalTime=${s.totalTime.toFixed(2)}s, realTimeFactor=${s.realTimeFactor.toFixed(3)}, audioDuration=${s.audioDurationMs}ms, totalSamples=${s.totalSamples}`)
    }

    console.log('\nWriting to .wav file...')
    createWav(buffer, COSYVOICE_SAMPLE_RATE, outputFile)
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
