'use strict'

// End-to-end validation of the Chatterbox `speed` knob (QVAC-21119).
// Synthesizes the same sentence at several speed values and reports the
// measured speaking rate (wpm) derived from the output sample count.
//   speed 1.0  -> baseline (~197 wpm, the reported "too fast")
//   speed 0.79 -> target ~155 wpm (natural)

const fs = require('bare-fs')
const path = require('bare-path')
const TTSGgml = require('../')
const { createWav } = require('./wav-helper')

const SAMPLE_RATE = 24000
const pkgRoot = path.join(__dirname, '..')
const t3Model = path.join(pkgRoot, 'models', 'chatterbox-t3-turbo.gguf')
const s3genModel = path.join(pkgRoot, 'models', 'chatterbox-s3gen.gguf')

const TEXT =
  'The quick brown fox jumps over the lazy dog while the morning sun rises slowly above the quiet valley and the river flows gently toward the distant sea.'
const WORDS = TEXT.trim().split(/\s+/).filter(Boolean).length

async function runOnce (speed) {
  const model = new TTSGgml({
    files: { t3Model, s3genModel },
    config: { language: 'en' },
    // Batch synthesis (no streamChunkTokens) so the time-stretch runs on the
    // whole utterance; the streaming path is covered by the C++ unit tests.
    // `speed: undefined` exercises the per-language default resolved natively.
    ...(speed === undefined ? {} : { speed }),
    logger: { info () {}, warn () {}, error () {}, debug () {} },
    opts: { stats: true }
  })
  await model.load()
  let buffer = []
  const response = await model.run({ input: TEXT, type: 'text' })
  await response.onUpdate(d => {
    if (d && d.outputArray) buffer = buffer.concat(Array.from(d.outputArray))
  }).await()
  await model.unload()

  const durationSec = buffer.length / SAMPLE_RATE
  const wpm = WORDS / (durationSec / 60)
  const label = speed === undefined ? 'default' : String(speed)
  const out = path.join(__dirname, `repro-speed-${label}.wav`)
  createWav(buffer, SAMPLE_RATE, out)
  return { label, samples: buffer.length, durationSec, wpm, out }
}

async function main () {
  for (const f of [t3Model, s3genModel]) {
    if (!fs.existsSync(f)) {
      console.error(`Missing model: ${f}. Run: npm run download-models:registry -- --group chatterbox`)
      global.Bare.exit(1)
    }
  }
  const results = []
  // `undefined` = omit speed entirely -> native per-language default (en=0.80).
  // 1.0 = explicit override -> raw model output (the "too fast" baseline).
  for (const speed of [undefined, 1.0, 0.79]) {
    console.log(`\n--- synthesizing at speed=${speed === undefined ? '(default)' : speed} ---`)
    results.push(await runOnce(speed))
  }
  console.log('\n=== SUMMARY (28 words) ===')
  for (const r of results) {
    console.log(
      `  speed=${r.label.padEnd(7)}  ${r.wpm.toFixed(1)} wpm  (${r.durationSec.toFixed(2)}s)  -> ${path.basename(r.out)}`
    )
  }
  global.Bare.exit(0)
}

main().catch(err => { console.error(err); global.Bare.exit(1) })
