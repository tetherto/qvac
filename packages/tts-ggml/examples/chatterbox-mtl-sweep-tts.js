'use strict'

/**
 * Chatterbox MULTILINGUAL TTS sweep demo for @qvac/tts-ggml.
 *
 * Loads the multilingual GGUFs (chatterbox-t3-mtl + chatterbox-s3gen-mtl)
 * and synthesizes a short sweep of sentences across several languages
 * back-to-back on the same engine instance, calling `model.reload({ language })`
 * between sentences to flip the tokenizer language tag.  Useful to spot
 * regressions across the tier-1 set.
 *
 * For the recommended single-sentence entry point with automatic
 * language detection, see chatterbox-mtl-tts.js (npm run example:chatterbox-mtl).
 *
 * Usage:
 *   bare examples/chatterbox-mtl-sweep-tts.js [path/to/reference.wav]
 *
 * Examples:
 *   bare examples/chatterbox-mtl-sweep-tts.js
 *   bare examples/chatterbox-mtl-sweep-tts.js ~/voices/me.wav
 *
 * Expects the multilingual GGUF files at:
 *   models/chatterbox-t3-mtl.gguf
 *   models/chatterbox-s3gen-mtl.gguf
 *
 * Convert models with `npm run setup-models`.  The English turbo
 * variant (chatterbox-t3-turbo + chatterbox-s3gen) lives in
 * chatterbox-tts.js.
 */

const fs = require('bare-fs')
const path = require('bare-path')
const TTSGgml = require('../')
const { createWav } = require('./wav-helper')
const { setLogger, releaseLogger } = require('../addonLogging')

const CHATTERBOX_SAMPLE_RATE = 24000

const argv = global.Bare ? global.Bare.argv : process.argv
const refAudioArg = argv[2]

const pkgRoot = path.join(__dirname, '..')
const modelDir = path.join(pkgRoot, 'models')
const t3Model = path.join(modelDir, 'chatterbox-t3-mtl.gguf')
const s3genModel = path.join(modelDir, 'chatterbox-s3gen-mtl.gguf')

for (const f of [t3Model, s3genModel]) {
  if (!fs.existsSync(f)) {
    console.error(`Missing model file: ${f}`)
    console.error('Run "npm run setup-models" to set up the venv and convert the multilingual Chatterbox checkpoint to GGUF.')
    if (global.Bare) global.Bare.exit(1)
    else process.exit(1)
  }
}

if (refAudioArg && !fs.existsSync(refAudioArg)) {
  console.error(`Reference audio not found: ${refAudioArg}`)
  if (global.Bare) global.Bare.exit(1)
  else process.exit(1)
}

if (!refAudioArg) {
  console.log('No reference audio provided, using the voice baked into the S3Gen GGUF.')
}

const SENTENCES = [
  { lang: 'en', text: 'Hello from the multilingual Chatterbox engine.' },
  { lang: 'es', text: 'El zorro marrón salta sobre el perro perezoso.' },
  { lang: 'fr', text: 'Le renard brun saute par-dessus le chien paresseux.' },
  { lang: 'de', text: 'Der braune Fuchs springt über den faulen Hund.' },
  { lang: 'pt', text: 'A raposa marrom pula sobre o cachorro preguiçoso.' }
]

async function main () {
  setLogger((priority, message) => {
    if (priority > 1) return
    const names = { 0: 'ERROR', 1: 'WARNING', 2: 'INFO', 3: 'DEBUG', 4: 'OFF' }
    const name = names[priority] || 'UNKNOWN'
    console.log(`[${new Date().toISOString()}] [C++ log] [${name}]: ${message}`)
  })

  const model = new TTSGgml({
    files: { t3Model, s3genModel },
    ...(refAudioArg ? { referenceAudio: refAudioArg } : {}),
    config: { language: SENTENCES[0].lang },
    logger: console,
    opts: { stats: true }
  })

  try {
    console.log('Loading Chatterbox MTL TTS model...')
    await model.load()
    console.log('Model loaded.\n')

    for (let i = 0; i < SENTENCES.length; i++) {
      const { lang, text } = SENTENCES[i]
      const preview = text.length > 80 ? `${text.slice(0, 80)}…` : text
      console.log(`--- ${i + 1}/${SENTENCES.length} [${lang}] "${preview}"`)

      if (i > 0) {
        await model.reload({ language: lang })
      }

      const response = await model.run({ input: text, type: 'text' })
      const buffer = []
      await response
        .onUpdate(data => {
          if (data && data.outputArray) {
            for (const s of data.outputArray) buffer.push(s)
          }
        })
        .await()

      if (response.stats) {
        const s = response.stats
        console.log(
          `    samples=${buffer.length} duration=${s.audioDurationMs}ms rtf=${s.realTimeFactor?.toFixed(3)} synth=${s.totalTime?.toFixed(2)}s`
        )
      }

      const out = path.join(__dirname, `chatterbox-mtl-sweep-${lang}.wav`)
      createWav(buffer, CHATTERBOX_SAMPLE_RATE, out)
      console.log(`    wrote ${path.relative(pkgRoot, out)}\n`)
    }
  } catch (err) {
    console.error('Error during MTL TTS processing:', err)
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
