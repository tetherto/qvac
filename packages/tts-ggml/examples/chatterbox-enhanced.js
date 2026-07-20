'use strict'

/**
 * Chatterbox TTS + LavaSR neural enhancement for @qvac/tts-ggml.
 *
 * Batch synthesis with Chatterbox, then the LavaSR enhancer bandwidth-extends
 * the 24 kHz output to 48 kHz on the CPU/GGML path. Enhancement also works with
 * native chunk streaming (streamChunkTokens) — the addon enhances each chunk
 * seam-free with a small look-ahead; this example uses the batch path.
 *
 * Usage:
 *   bare examples/chatterbox-enhanced.js "text to synthesize" [path/to/reference.wav]
 *
 * Expects:
 *   models/chatterbox-t3-turbo.gguf
 *   models/chatterbox-s3gen.gguf
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
const refAudioArg = argv[3]

if (!textArg || typeof textArg !== 'string' || textArg.trim().length === 0) {
  console.error('Usage: chatterbox-enhanced.js "<text to synthesize>" [path/to/reference.wav]')
  if (global.Bare) global.Bare.exit(1)
  else process.exit(1)
}

const pkgRoot = path.join(__dirname, '..')
const modelDir = path.join(pkgRoot, 'models')
const t3Model = path.join(modelDir, 'chatterbox-t3-turbo.gguf')
const s3genModel = path.join(modelDir, 'chatterbox-s3gen.gguf')
const enhancerGguf =
  (proc.env && proc.env.LAVASR_ENHANCER_GGUF) ||
  path.join(modelDir, 'lavasr', 'lavasr-enhancer.gguf')

for (const [label, f] of [['t3', t3Model], ['s3gen', s3genModel], ['lavasr enhancer', enhancerGguf]]) {
  if (!fs.existsSync(f)) {
    console.error(`Missing ${label} model: ${f}`)
    console.error('Run "npm run setup-models" for the Chatterbox GGUFs, and convert the')
    console.error('enhancer with scripts/convert-lavasr-enhancer-to-gguf.py (or set LAVASR_ENHANCER_GGUF).')
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

  const outputFile = path.join(__dirname, 'chatterbox-enhanced-output.wav')

  const model = new TTSGgml({
    // Supplying the enhancer GGUF (files.lavasrEnhancer) is what turns
    // enhancement on — there is no separate on/off flag.
    files: { modelDir, lavasrEnhancer: enhancerGguf },
    ...(refAudioArg ? { referenceAudio: refAudioArg } : {}),
    config: { language: 'en' },
    logger: console,
    opts: { stats: true }
  })

  try {
    console.log('Loading Chatterbox + LavaSR enhancer...')
    await model.load()
    console.log(`Running enhanced TTS on: "${textArg}"`)

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
