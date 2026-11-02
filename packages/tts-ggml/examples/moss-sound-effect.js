'use strict'

/**
 * MOSS-SoundEffect text-to-sound-effects generation for @qvac/tts-ggml.
 *
 * MOSS-SoundEffect-v2 is a flow-matching diffusion model: a Qwen3 text
 * encoder reads the prompt, a DiT denoises a latent over a fixed number of
 * steps, and a DAC decoder turns it into 48 kHz mono audio of up to 30
 * seconds.  It is not a speech model: the prompt describes a sound.
 *
 * Usage:
 *   bare examples/moss-sound-effect.js "description of the sound" [seconds]
 *
 * Examples:
 *   bare examples/moss-sound-effect.js "Heavy rain on a tin roof with distant thunder." 10
 *   QVAC_TTS_MOSS_SFX_GPU=1 bare examples/moss-sound-effect.js "A dog barking twice." 5
 *   QVAC_TTS_MOSS_SFX_STEPS=50 bare examples/moss-sound-effect.js "Fast typing on a keyboard." 5
 *
 * Expects the MOSS-SoundEffect GGUF (moss-sfx-v2-f16.gguf or
 * moss-sfx-v2-q8_0.gguf) under:
 *   models/
 * Produce it with engines/tts/scripts/convert-moss-sfx-to-gguf.py in
 * qvac-fabric-speech.cpp until it is published to the model registry.  Every
 * clip costs the same whatever its length (the model always denoises a
 * 30-second latent); use a GPU for the default 100 steps.
 */

const path = require('bare-path')
const proc = require('bare-process')
const TTSGgml = require('../')
const { createWav } = require('./wav-helper')
const { setLogger, releaseLogger } = require('../addonLogging')

const SFX_SAMPLE_RATE = 48000
const DEFAULT_SECONDS = 10

const argv = global.Bare ? global.Bare.argv : process.argv
const promptArg = argv[2]
const seconds = Number(argv[3] || DEFAULT_SECONDS)
const steps = Number(proc.env.QVAC_TTS_MOSS_SFX_STEPS || 0)

function fail(message) {
  console.error(message)
  if (global.Bare) global.Bare.exit(1)
  else process.exit(1)
}

if (!promptArg || typeof promptArg !== 'string' || promptArg.trim().length === 0) {
  fail('Usage: moss-sound-effect.js "<description of the sound>" [seconds]')
}

const pkgRoot = path.join(__dirname, '..')
const modelDir = path.join(pkgRoot, 'models')

function buildModel() {
  return new TTSGgml({
    engine: TTSGgml.ENGINE_MOSS_SFX,
    files: { modelDir },
    config: { useGPU: proc.env.QVAC_TTS_MOSS_SFX_GPU === '1' },
    logger: console,
    opts: { stats: true }
  })
}

function reportStats(stats) {
  if (!stats) return
  console.log(
    `Generation stats: totalTime=${stats.totalTime.toFixed(2)}s, ` +
      `realTimeFactor=${stats.realTimeFactor.toFixed(3)}, ` +
      `audioDuration=${stats.audioDurationMs}ms, totalSamples=${stats.totalSamples}, ` +
      `backendDevice=${stats.backendDevice}, backendId=${stats.backendId}`
  )
}

async function collectPcm(response) {
  let buffer = []
  await response
    .onUpdate((data) => {
      if (data && data.outputArray) buffer = buffer.concat(Array.from(data.outputArray))
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

  const outputFile = path.join(__dirname, 'moss-sound-effect.wav')
  const model = buildModel()

  try {
    console.log('Loading MOSS-SoundEffect model...')
    await model.load()
    console.log('Model loaded.')

    console.log(`Generating ${seconds}s of: "${promptArg}"`)
    const response = await model.run({
      input: promptArg,
      type: 'text',
      seconds,
      ...(steps > 0 ? { steps } : {})
    })
    const buffer = await collectPcm(response)

    console.log('Generation finished!')
    reportStats(response.stats)

    createWav(buffer, SFX_SAMPLE_RATE, outputFile)
    console.log(`Finished writing to ${outputFile}`)
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
