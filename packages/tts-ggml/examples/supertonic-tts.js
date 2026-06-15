'use strict'

/**
 * Supertonic TTS batch synthesis for @qvac/tts-ggml.
 *
 * Loads the English-only Supertone/supertonic GGUF and synthesizes a
 * single utterance.  Supertonic is a very fast, batch-only engine that
 * emits native 44.1 kHz audio (no reference-audio voice cloning; voices
 * are baked into the model under names like 'F1', 'F2', 'M1' ... — see
 * the GGUF metadata for the full list).
 *
 * For multilingual synthesis (en/ko/es/pt/fr) load the Supertonic-2
 * GGUF instead, via supertonic-mtl-tts.js (auto language detect) or
 * supertonic-mtl-sweep-tts.js (back-to-back sweep).
 *
 * Usage:
 *   bare examples/supertonic-tts.js "text to synthesize" [voice]
 *
 * Examples:
 *   bare examples/supertonic-tts.js "Hello from supertonic"
 *   bare examples/supertonic-tts.js "Hello there" M1
 *
 * Expects the English Supertonic GGUF at:
 *   models/supertonic.gguf
 *
 * Convert with `npm run setup-models` (or
 * `bash scripts/convert-models.sh -t supertonic-en`); the Python
 * pipeline pulls Supertone/supertonic from Hugging Face and packs the
 * ONNX bundle into a single .gguf via
 * scripts/convert-supertonic2-to-gguf.py --arch supertonic.
 *
 * NOTE: Supertonic supports GPU on capable hosts (Metal on Apple,
 * Vulkan/CUDA on desktop) via tts-cpp@2026-06-05; opt in with
 * config: { useGPU: true }.  On Android it is forced to CPU at the engine
 * boundary (Adreno Vulkan/OpenCL is not yet stable).  This example keeps
 * useGPU=false so it runs identically everywhere.
 */

const fs = require('bare-fs')
const path = require('bare-path')
const TTSGgml = require('../')
const { createWav } = require('./wav-helper')
const { setLogger, releaseLogger } = require('../addonLogging')

const SUPERTONIC_SAMPLE_RATE = 44100

const argv = global.Bare ? global.Bare.argv : process.argv
const textArg = argv[2]
const voiceArg = argv[3]

if (!textArg || typeof textArg !== 'string' || textArg.trim().length === 0) {
  console.error('Usage: supertonic-tts.js "<text to synthesize>" [voice]')
  if (global.Bare) global.Bare.exit(1)
  else process.exit(1)
}

const pkgRoot = path.join(__dirname, '..')
const modelDir = path.join(pkgRoot, 'models')
const supertonicModel = path.join(modelDir, 'supertonic.gguf')

if (!fs.existsSync(supertonicModel)) {
  console.error(`Missing model file: ${supertonicModel}`)
  console.error('Run "npm run setup-models" to set up the venv and convert the Supertone Supertonic-2 ONNX bundle to GGUF.')
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

  const outputFile = path.join(__dirname, 'supertonic-output.wav')

  const model = new TTSGgml({
    engine: TTSGgml.ENGINE_SUPERTONIC,
    files: { supertonicModel },
    voice: voiceArg || 'F1',
    config: { language: 'en', useGPU: false },
    logger: console,
    opts: { stats: true }
  })

  try {
    console.log('Loading Supertonic TTS model...')
    await model.load()
    console.log('Model loaded.')

    console.log(`Running TTS on: "${textArg}" (voice=${voiceArg || 'F1'})`)

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
      console.log(`Inference stats: totalTime=${s.totalTime.toFixed(2)}s, tokensPerSecond=${s.tokensPerSecond.toFixed(2)}, realTimeFactor=${s.realTimeFactor.toFixed(3)}, audioDuration=${s.audioDurationMs}ms, totalSamples=${s.totalSamples}`)
    }

    console.log('\nWriting to .wav file...')
    createWav(buffer, SUPERTONIC_SAMPLE_RATE, outputFile)
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
