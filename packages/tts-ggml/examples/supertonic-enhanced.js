'use strict'

/**
 * Supertonic TTS + LavaSR neural enhancement for @qvac/tts-ggml.
 *
 * Synthesizes a single utterance with Supertonic, then opts into the LavaSR
 * enhancer: a lightweight Vocos bandwidth-extension network (ConvNeXt backbone
 * + ISTFT spec head) that runs on the CPU/GGML path and upsamples the output to
 * 48 kHz with a synthesised high band. Output is 48 kHz when enhancement is on.
 *
 * Usage:
 *   bare examples/supertonic-enhanced.js "text to synthesize" [voice]
 *
 * Expects:
 *   models/supertonic.gguf          (npm run setup-models)
 *   models/lavasr/lavasr-enhancer.gguf   (or set LAVASR_ENHANCER_GGUF)
 *
 * Convert the enhancer GGUF from the public LavaSRcpp ONNX release with:
 *   python scripts/convert-lavasr-enhancer-to-gguf.py \
 *     --backbone enhancer_backbone.onnx --spec-head enhancer_spec_head.onnx \
 *     --out models/lavasr/lavasr-enhancer.gguf --ftype f16
 */

const fs = require('bare-fs')
const path = require('bare-path')
const proc = require('bare-process')
const TTSGgml = require('../')
const { createWav } = require('./wav-helper')
const { setLogger, releaseLogger } = require('../addonLogging')

const ENHANCED_SAMPLE_RATE = 48000

const argv = global.Bare ? global.Bare.argv : process.argv
const textArg = argv[2]
const voiceArg = argv[3]

if (!textArg || typeof textArg !== 'string' || textArg.trim().length === 0) {
  console.error('Usage: supertonic-enhanced.js "<text to synthesize>" [voice]')
  if (global.Bare) global.Bare.exit(1)
  else process.exit(1)
}

const pkgRoot = path.join(__dirname, '..')
const modelDir = path.join(pkgRoot, 'models')
const supertonicModel = path.join(modelDir, 'supertonic.gguf')
const enhancerGguf =
  (proc.env && proc.env.LAVASR_ENHANCER_GGUF) ||
  path.join(modelDir, 'lavasr', 'lavasr-enhancer.gguf')

for (const [label, file] of [['supertonic', supertonicModel], ['lavasr enhancer', enhancerGguf]]) {
  if (!fs.existsSync(file)) {
    console.error(`Missing ${label} model: ${file}`)
    console.error('Run "npm run setup-models" for supertonic.gguf, and convert the')
    console.error('enhancer with scripts/convert-lavasr-enhancer-to-gguf.py (or set')
    console.error('LAVASR_ENHANCER_GGUF to its path).')
    if (global.Bare) global.Bare.exit(1)
    else process.exit(1)
  }
}

async function main () {
  setLogger((priority, message) => {
    if (priority > 1) return
    const names = { 0: 'ERROR', 1: 'WARNING', 2: 'INFO', 3: 'DEBUG', 4: 'OFF' }
    console.log(`[C++ log] [${names[priority] || 'UNKNOWN'}]: ${message}`)
  })

  const outputFile = path.join(__dirname, 'supertonic-enhanced-output.wav')

  const model = new TTSGgml({
    engine: TTSGgml.ENGINE_SUPERTONIC,
    // Supplying the enhancer GGUF (files.lavasrEnhancer) is what turns
    // enhancement on — there is no separate on/off flag.
    files: { supertonicModel, lavasrEnhancer: enhancerGguf },
    voice: voiceArg || 'F1',
    config: { language: 'en', useGPU: false },
    logger: console,
    opts: { stats: true }
  })

  try {
    console.log('Loading Supertonic + LavaSR enhancer...')
    await model.load()
    console.log(`Running enhanced TTS on: "${textArg}" (voice=${voiceArg || 'F1'})`)

    const response = await model.run({ input: textArg, type: 'text' })

    let buffer = []
    let sampleRate = ENHANCED_SAMPLE_RATE
    await response
      .onUpdate(data => {
        if (data && data.outputArray) buffer = buffer.concat(Array.from(data.outputArray))
        if (data && data.sampleRate) sampleRate = data.sampleRate
      })
      .await()

    console.log(`TTS finished! Reported sample rate: ${sampleRate} Hz (expect 48000 with enhancement).`)
    createWav(buffer, sampleRate, outputFile)
    console.log(`Wrote ${outputFile}`)
  } catch (err) {
    console.error('Error during enhanced TTS:', err)
    throw err
  } finally {
    await model.unload()
    releaseLogger()
  }
}

main().catch(err => {
  console.error(err)
  if (global.Bare) global.Bare.exit(1)
  else process.exit(1)
})
