'use strict'

/**
 * Supertonic MULTILINGUAL TTS sweep demo for @qvac/tts-ggml.
 *
 * Loads the multilingual Supertonic-2 GGUF (models/supertonic2.gguf) and
 * synthesizes one canonical sentence per Supertonic-supported language
 * back-to-back on the same engine instance, calling
 * `model.reload({ language })` between sentences to flip the
 * tokenizer / language-wrap mode.  Useful to spot regressions across
 * the (small) tier-1 set.
 *
 * Supertonic supports en/ko/es/pt/fr today (gated by tts-cpp's
 * supertonic_preprocess.cpp::is_supported_language).
 *
 * For the recommended single-sentence entry point with automatic
 * language detection, see supertonic-mtl-tts.js
 * (npm run example:supertonic-mtl).
 *
 * Usage:
 *   bare examples/supertonic-mtl-sweep-tts.js [voice]
 *
 * Examples:
 *   bare examples/supertonic-mtl-sweep-tts.js
 *   bare examples/supertonic-mtl-sweep-tts.js M1
 *
 * Expects the multilingual Supertonic GGUF at:
 *   models/supertonic2.gguf
 *
 * Convert with `npm run setup-models` (or
 * `bash scripts/convert-models.sh -t supertonic-mtl`).  The
 * English-pinned single-sentence entry point lives in supertonic-tts.js.
 *
 * NOTE: Supertonic supports GPU on capable hosts (CPU-only on Android).
 * This example keeps useGPU=false; opt in with config: { useGPU: true }.
 */

const fs = require('bare-fs')
const path = require('bare-path')
const TTSGgml = require('../')
const { createWav } = require('./wav-helper')
const { setLogger, releaseLogger } = require('../addonLogging')

const SUPERTONIC_SAMPLE_RATE = 44100

const argv = global.Bare ? global.Bare.argv : process.argv
const voiceArg = argv[2]

const pkgRoot = path.join(__dirname, '..')
const modelDir = path.join(pkgRoot, 'models')
const supertonicModel = path.join(modelDir, 'supertonic2.gguf')

if (!fs.existsSync(supertonicModel)) {
  console.error(`Missing model file: ${supertonicModel}`)
  console.error('Run "npm run setup-models" (or "bash scripts/convert-models.sh -t supertonic-mtl") to convert the Supertone Supertonic-2 ONNX bundle to GGUF.')
  if (global.Bare) global.Bare.exit(1)
  else process.exit(1)
}

const SENTENCES = [
  { lang: 'en', text: 'Hello from the multilingual Supertonic engine.' },
  { lang: 'es', text: 'El zorro marrón salta sobre el perro perezoso.' },
  { lang: 'fr', text: 'Le renard brun saute par-dessus le chien paresseux.' },
  { lang: 'pt', text: 'A raposa marrom pula sobre o cachorro preguiçoso.' },
  { lang: 'ko', text: '안녕하세요, 다국어 슈퍼토닉 엔진입니다.' }
]

async function main () {
  setLogger((priority, message) => {
    if (priority > 1) return
    const names = { 0: 'ERROR', 1: 'WARNING', 2: 'INFO', 3: 'DEBUG', 4: 'OFF' }
    const name = names[priority] || 'UNKNOWN'
    console.log(`[${new Date().toISOString()}] [C++ log] [${name}]: ${message}`)
  })

  const voice = voiceArg || 'F1'

  const model = new TTSGgml({
    engine: TTSGgml.ENGINE_SUPERTONIC,
    files: { supertonicModel },
    voice,
    config: { language: SENTENCES[0].lang, useGPU: false },
    logger: console,
    opts: { stats: true }
  })

  try {
    console.log('Loading Supertonic MTL TTS model...')
    await model.load()
    console.log(`Model loaded. Voice=${voice}.\n`)

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

      const out = path.join(__dirname, `supertonic-mtl-sweep-${lang}.wav`)
      createWav(buffer, SUPERTONIC_SAMPLE_RATE, out)
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
