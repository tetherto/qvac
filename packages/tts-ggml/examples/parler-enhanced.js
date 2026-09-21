'use strict'

/**
 * Parler-TTS + LavaSR neural enhancement for @qvac/tts-ggml.
 *
 * Synthesizes a single utterance with Parler, then opts into the LavaSR
 * enhancer: a lightweight Vocos bandwidth-extension network (ConvNeXt backbone
 * + ISTFT spec head) that runs on the CPU/GGML path and resamples the output to
 * 48 kHz with a synthesised high band. Parler is natively 44.1 kHz, so the
 * enhancer buys spectral detail rather than raw bandwidth. Output is 48 kHz
 * when enhancement is on.
 *
 * The optional LavaSR denoiser (files.lavasrDenoiser) runs before the enhancer
 * and preserves the sample rate; it is batch-only.
 *
 * Usage:
 *   bare examples/parler-enhanced.js "text to synthesize" [voice] [emotion]
 *
 * Expects:
 *   models/parler-mini-v1-q8_0.gguf      (npm run setup-models)
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
const DEFAULT_VOICE = 'Laura'

const argv = global.Bare ? global.Bare.argv : process.argv
const textArg = argv[2]
const voiceArg = argv[3]
const emotionArg = argv[4]

if (!textArg || typeof textArg !== 'string' || textArg.trim().length === 0) {
  console.error('Usage: parler-enhanced.js "<text to synthesize>" [voice] [emotion]')
  if (global.Bare) global.Bare.exit(1)
  else process.exit(1)
}

const pkgRoot = path.join(__dirname, '..')
const modelDir = path.join(pkgRoot, 'models')
const enhancerGguf =
  (proc.env && proc.env.LAVASR_ENHANCER_GGUF) ||
  path.join(modelDir, 'lavasr', 'lavasr-enhancer.gguf')

if (!fs.existsSync(enhancerGguf)) {
  console.error(`Missing lavasr enhancer model: ${enhancerGguf}`)
  console.error('Convert it with scripts/convert-lavasr-enhancer-to-gguf.py (or set')
  console.error('LAVASR_ENHANCER_GGUF to its path).')
  if (global.Bare) global.Bare.exit(1)
  else process.exit(1)
}

async function main() {
  setLogger((priority, message) => {
    if (priority > 1) return
    const names = { 0: 'ERROR', 1: 'WARNING', 2: 'INFO', 3: 'DEBUG', 4: 'OFF' }
    console.log(`[C++ log] [${names[priority] || 'UNKNOWN'}]: ${message}`)
  })

  const outputFile = path.join(__dirname, 'parler-enhanced-output.wav')
  const voice = voiceArg || DEFAULT_VOICE

  const model = new TTSGgml({
    engine: TTSGgml.ENGINE_PARLER,
    // Supplying the enhancer GGUF (files.lavasrEnhancer) is what turns
    // enhancement on — there is no separate on/off flag.
    files: { modelDir, lavasrEnhancer: enhancerGguf },
    voice,
    ...(emotionArg ? { emotion: emotionArg } : {}),
    config: { useGPU: false },
    logger: console,
    opts: { stats: true }
  })

  try {
    console.log('Loading Parler + LavaSR enhancer...')
    await model.load()
    console.log(
      `Running enhanced TTS on: "${textArg}" (voice=${voice}${emotionArg ? `, emotion=${emotionArg}` : ''})`
    )

    const response = await model.run({ input: textArg, type: 'text' })

    let buffer = []
    let sampleRate = ENHANCED_SAMPLE_RATE
    await response
      .onUpdate((data) => {
        if (data && data.outputArray) buffer = buffer.concat(Array.from(data.outputArray))
        if (data && data.sampleRate) sampleRate = data.sampleRate
      })
      .await()

    console.log(`TTS finished! Reported sample rate: ${sampleRate} Hz (expect 48000 with enhancement).`)
    if (response.stats) {
      const s = response.stats
      console.log(
        `Inference stats: totalTime=${s.totalTime.toFixed(2)}s, realTimeFactor=${s.realTimeFactor.toFixed(3)}, audioDuration=${s.audioDurationMs}ms, totalSamples=${s.totalSamples}`
      )
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

main().catch((err) => {
  console.error(err)
  if (global.Bare) global.Bare.exit(1)
  else process.exit(1)
})
