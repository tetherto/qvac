'use strict'

/**
 * Chatterbox speaking-rate (`speed`) demo for @qvac/tts-ggml (QVAC-21119).
 *
 * Chatterbox has no native rate control, so the addon exposes a `speed`
 * multiplier applied as a pitch-preserving post-synthesis time-stretch
 * (duration multiplier, mirroring Supertonic; functionally ~ ffmpeg atempo):
 *   - speed < 1   slows speech down (longer audio)
 *   - speed > 1   speeds speech up  (shorter audio)
 *   - omitted / 1.0  leaves the raw model output unchanged (opt-in knob)
 * Pitch is preserved regardless.
 *
 * Usage:
 *   bare examples/chatterbox-adjust-speed.js ["text to synthesize"] [speed]
 *
 * Examples:
 *   bare examples/chatterbox-adjust-speed.js                    # sweep 1.0, 0.85, 0.7
 *   bare examples/chatterbox-adjust-speed.js "Hello there" 0.8  # single run at 0.8
 *
 * Each run derives the speaking rate (wpm) from the output sample count
 * (wpm = words / (samples / 24000 / 60)) and writes one WAV per speed.
 *
 * Expects the Chatterbox turbo GGUF files at:
 *   models/chatterbox-t3-turbo.gguf
 *   models/chatterbox-s3gen.gguf
 * Convert with `npm run setup-models` (or fetch with
 * `npm run download-models:registry -- --group chatterbox`).
 */

const fs = require('bare-fs')
const path = require('bare-path')
const TTSGgml = require('../')
const { createWav } = require('./wav-helper')
const { setLogger, releaseLogger } = require('../addonLogging')

const CHATTERBOX_SAMPLE_RATE = 24000

const DEFAULT_TEXT =
  'The quick brown fox jumps over the lazy dog while the morning sun rises ' +
  'slowly above the quiet valley and the river flows gently toward the sea.'

const argv = global.Bare ? global.Bare.argv : process.argv
const textArg = (typeof argv[2] === 'string' && argv[2].trim()) ? argv[2] : DEFAULT_TEXT
const speedArg = argv[3] != null ? Number(argv[3]) : null

if (speedArg != null && !(speedArg > 0)) {
  console.error(`Invalid speed "${argv[3]}": must be a positive number (e.g. 0.8).`)
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
    console.error('Run "npm run setup-models" (or "npm run download-models:registry -- --group chatterbox").')
    if (global.Bare) global.Bare.exit(1)
    else process.exit(1)
  }
}

const WORDS = textArg.trim().split(/\s+/).filter(Boolean).length

async function runOnce (speed) {
  const model = new TTSGgml({
    files: { modelDir },
    config: { language: 'en' },
    speed,
    logger: console,
    opts: { stats: true }
  })

  await model.load()
  let buffer = []
  const response = await model.run({ input: textArg, type: 'text' })
  await response
    .onUpdate(data => {
      if (data && data.outputArray) buffer = buffer.concat(Array.from(data.outputArray))
    })
    .await()
  await model.unload()

  const durationSec = buffer.length / CHATTERBOX_SAMPLE_RATE
  const wpm = WORDS / (durationSec / 60)
  const outFile = path.join(__dirname, `chatterbox-adjust-speed-${speed}.wav`)
  createWav(buffer, CHATTERBOX_SAMPLE_RATE, outFile)
  return { speed, durationSec, wpm, outFile }
}

async function main () {
  setLogger((priority, message) => {
    if (priority > 1) return
    const names = { 0: 'ERROR', 1: 'WARNING', 2: 'INFO', 3: 'DEBUG', 4: 'OFF' }
    const name = names[priority] || 'UNKNOWN'
    console.log(`[${new Date().toISOString()}] [C++ log] [${name}]: ${message}`)
  })

  // An explicit speed -> single run; otherwise sweep 1.0 (raw) plus two
  // slower values so the effect is visible in one invocation.
  const speeds = speedArg != null ? [speedArg] : [1.0, 0.85, 0.7]

  console.log(`Text (${WORDS} words): "${textArg}"`)
  const results = []
  try {
    for (const speed of speeds) {
      console.log(`\n--- synthesizing at speed=${speed} ---`)
      results.push(await runOnce(speed))
    }
  } catch (err) {
    console.error('Error during TTS processing:', err)
    throw err
  } finally {
    releaseLogger()
  }

  console.log('\n=== speaking rate by speed ===')
  for (const r of results) {
    console.log(`  speed=${String(r.speed).padEnd(5)} ${r.wpm.toFixed(1).padStart(6)} wpm   ${r.durationSec.toFixed(2)}s   -> ${path.basename(r.outFile)}`)
  }
}

main().catch(err => {
  console.error(err)
  if (global.Bare) global.Bare.exit(1)
  else process.exit(1)
})
