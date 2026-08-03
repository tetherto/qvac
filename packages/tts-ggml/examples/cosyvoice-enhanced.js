'use strict'

/**
 * CosyVoice3 TTS + LavaSR neural enhancement for @qvac/tts-ggml.
 *
 * Synthesizes a single utterance with CosyVoice3, then opts into the LavaSR
 * enhancer: a lightweight Vocos bandwidth-extension network (ConvNeXt backbone
 * + ISTFT spec head) that upsamples CosyVoice3's native 24 kHz output to 48 kHz
 * with a synthesised high band. Output is 48 kHz when enhancement is on.
 *
 * Pass a third argument to also run the LavaSR denoiser (UL-UNAS) before the
 * enhancer; it is rate-preserving and batch-only.
 *
 * Usage:
 *   bare examples/cosyvoice-enhanced.js "text to synthesize" [modelDir] [--denoise]
 *
 * Expects:
 *   models/cosyvoice3/                   (or set COSYVOICE_MODEL_DIR)
 *   models/lavasr/lavasr-enhancer.gguf   (or set LAVASR_ENHANCER_GGUF)
 *   models/lavasr/lavasr-denoiser.gguf   (--denoise only; or LAVASR_DENOISER_GGUF)
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
const env = proc.env || {}
const textArg = argv[2]
const modelDirArg = argv[3] && argv[3] !== '--denoise' ? argv[3] : undefined
const denoise = argv.includes('--denoise')

if (!textArg || typeof textArg !== 'string' || textArg.trim().length === 0) {
  console.error('Usage: cosyvoice-enhanced.js "<text to synthesize>" [modelDir] [--denoise]')
  if (global.Bare) global.Bare.exit(1)
  else process.exit(1)
}

const pkgRoot = path.join(__dirname, '..')
const modelDir = path.join(pkgRoot, 'models')
const cosyvoiceModelDir =
  modelDirArg || env.COSYVOICE_MODEL_DIR || path.join(modelDir, 'cosyvoice3')
const enhancerGguf =
  env.LAVASR_ENHANCER_GGUF || path.join(modelDir, 'lavasr', 'lavasr-enhancer.gguf')
const denoiserGguf =
  env.LAVASR_DENOISER_GGUF || path.join(modelDir, 'lavasr', 'lavasr-denoiser.gguf')

const required = [
  ['cosyvoice3 model dir', cosyvoiceModelDir],
  ['lavasr enhancer', enhancerGguf]
]
if (denoise) required.push(['lavasr denoiser', denoiserGguf])

for (const [label, file] of required) {
  if (!fs.existsSync(file)) {
    console.error(`Missing ${label}: ${file}`)
    console.error('Assemble the model dir with tts-cpp/scripts/assemble-cosyvoice3-model.py,')
    console.error('and convert the LavaSR GGUFs with the scripts referenced in README.md')
    console.error('(or set COSYVOICE_MODEL_DIR / LAVASR_ENHANCER_GGUF / LAVASR_DENOISER_GGUF).')
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

  const outputFile = path.join(__dirname, 'cosyvoice-enhanced-output.wav')

  // Supplying the LavaSR GGUFs (files.lavasrEnhancer / files.lavasrDenoiser) is
  // what turns each stage on — there is no separate on/off flag.
  const files = { cosyvoiceModelDir, lavasrEnhancer: enhancerGguf }
  if (denoise) files.lavasrDenoiser = denoiserGguf

  const model = new TTSGgml({
    engine: TTSGgml.ENGINE_COSYVOICE3,
    files,
    config: { language: 'en', useGPU: false },
    logger: console,
    opts: { stats: true }
  })

  try {
    console.log(`Loading CosyVoice3 + LavaSR enhancer${denoise ? ' + denoiser' : ''}...`)
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
    if (response.stats) {
      const s = response.stats
      console.log(`Enhancer ran on backendDevice=${s.enhancerBackendDevice} (-1 none / 0 CPU / 1 GPU)`)
    }
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
