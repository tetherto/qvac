'use strict'

const path = require('bare-path')
const ONNXTTS = require('../')
const { createWav, readWavAsFloat32, resampleLinear } = require('./wav-helper')
const { setLogger, releaseLogger } = require('../addonLogging')

const CHATTERBOX_SAMPLE_RATE = 24000

const modelsDir = 'models/chatterbox'
const lavasrDir = 'models/lavasr'
const ENHANCER_BACKBONE_PATH = `${lavasrDir}/enhancer_backbone.onnx`
const ENHANCER_SPEC_HEAD_PATH = `${lavasrDir}/enhancer_spec_head.onnx`
const DENOISER_PATH = `${lavasrDir}/denoiser_core_legacy_fixed63.onnx`
const refWavPath = path.join(__dirname, '..', 'test', 'reference-audio', 'jfk.wav')

const TEXT = 'Hello world! This is a comparison of raw versus enhanced audio quality using LavaSR neural speech enhancement.'

async function synthesize (label, extraArgs, outputFile, sampleRate) {
  console.log(`\n${'='.repeat(60)}`)
  console.log(`  ${label}`)
  console.log('='.repeat(60))

  const { samples, sampleRate: refRate } = readWavAsFloat32(refWavPath)
  const referenceAudio = refRate !== CHATTERBOX_SAMPLE_RATE
    ? resampleLinear(samples, refRate, CHATTERBOX_SAMPLE_RATE)
    : samples

  const args = {
    files: {
      tokenizerPath: `${modelsDir}/tokenizer.json`,
      speechEncoderPath: `${modelsDir}/speech_encoder.onnx`,
      embedTokensPath: `${modelsDir}/embed_tokens.onnx`,
      conditionalDecoderPath: `${modelsDir}/conditional_decoder.onnx`,
      languageModelPath: `${modelsDir}/language_model.onnx`
    },
    referenceAudio,
    config: { language: 'en' },
    opts: { stats: true },
    ...extraArgs
  }

  const model = new ONNXTTS(args)
  await model.load()

  console.log(`Synthesizing: "${TEXT}"`)
  const start = Date.now()

  const response = await model.run({ input: TEXT, type: 'text' })
  let buffer = []

  await response
    .onUpdate(data => {
      if (data && data.outputArray) {
        buffer = buffer.concat(Array.from(data.outputArray))
        if (data.sampleRate) {
          sampleRate = data.sampleRate
        }
      }
    })
    .await()

  const elapsed = Date.now() - start
  const durationSec = buffer.length / sampleRate

  console.log(`Done in ${(elapsed / 1000).toFixed(1)}s`)
  console.log(`Output: ${buffer.length} samples @ ${sampleRate}Hz = ${durationSec.toFixed(1)}s audio`)

  createWav(buffer, sampleRate, outputFile)
  console.log(`Saved: ${outputFile}`)

  await model.unload()
  return { elapsed, samples: buffer.length, sampleRate }
}

async function main () {
  setLogger((priority, message) => {
    if (priority <= 2) {
      const names = { 0: 'ERROR', 1: 'WARN', 2: 'INFO' }
      console.log(`  [${names[priority] || '?'}] ${message}`)
    }
  })

  console.log('LavaSR Audio Enhancement Comparison')
  console.log('====================================\n')
  console.log(`Models: ${modelsDir}`)
  console.log(`LavaSR: ${lavasrDir}`)

  // 1. Raw Chatterbox output (24kHz)
  const raw = await synthesize(
    '1. Raw Chatterbox (24kHz)',
    {},
    'output-1-raw-24k.wav',
    CHATTERBOX_SAMPLE_RATE
  )

  // 2. Enhanced only (48kHz)
  const enhanced = await synthesize(
    '2. Enhanced with LavaSR (48kHz)',
    {
      enhancer: {
        type: 'lavasr',
        enhance: true,
        backbonePath: ENHANCER_BACKBONE_PATH,
        specHeadPath: ENHANCER_SPEC_HEAD_PATH
      }
    },
    'output-2-enhanced-48k.wav',
    48000
  )

  // 3. Denoised + Enhanced (48kHz)
  const denoiseEnhanced = await synthesize(
    '3. Denoised + Enhanced (48kHz)',
    {
      enhancer: {
        type: 'lavasr',
        enhance: true,
        denoise: true,
        backbonePath: ENHANCER_BACKBONE_PATH,
        specHeadPath: ENHANCER_SPEC_HEAD_PATH,
        denoiserPath: DENOISER_PATH
      }
    },
    'output-3-denoised-enhanced-48k.wav',
    48000
  )

  // Summary
  console.log(`\n${'='.repeat(60)}`)
  console.log('  Summary')
  console.log('='.repeat(60))
  console.log(`  1. Raw 24kHz:             ${(raw.elapsed / 1000).toFixed(1)}s  ->  output-1-raw-24k.wav`)
  console.log(`  2. Enhanced 48kHz:        ${(enhanced.elapsed / 1000).toFixed(1)}s  ->  output-2-enhanced-48k.wav`)
  console.log(`  3. Denoise+Enhance 48kHz: ${(denoiseEnhanced.elapsed / 1000).toFixed(1)}s  ->  output-3-denoised-enhanced-48k.wav`)
  console.log('\nOpen the .wav files to hear the difference!')

  releaseLogger()
}

main().catch(err => {
  console.error('Error:', err)
  releaseLogger()
})
