'use strict'

/**
 * Supertonic MULTILINGUAL TTS for @qvac/tts-ggml (auto language detect).
 *
 * Loads the multilingual Supertonic-2 GGUF (models/supertonic2.gguf,
 * produced by `npm run setup-models` via
 * convert-supertonic2-to-gguf.py --arch supertonic2) and synthesizes a
 * single sentence whose language is auto-detected via
 * @qvac/langdetect-text.  Falls back to "en" with a warning when the
 * detected code isn't in the Supertonic tier-1 set or when detection is
 * undetermined.  Mirrors the API surface of supertonic-tts.js: pass the
 * sentence on the command line, optionally followed by a voice name.
 *
 * The English-only supertonic.gguf (Supertone/supertonic) is used by
 * the simpler supertonic-tts.js example; this MTL example uses
 * supertonic2.gguf instead.
 *
 * Supertonic supports a much smaller language set than Chatterbox MTL:
 *   en, ko, es, pt, fr
 * (gated by tts-cpp's supertonic_preprocess.cpp::is_supported_language).
 *
 * Usage:
 *   bare examples/supertonic-mtl-tts.js "<text to synthesize>" [voice]
 *
 * Examples:
 *   bare examples/supertonic-mtl-tts.js "Hello from supertonic multilingual."
 *   bare examples/supertonic-mtl-tts.js "Hola desde supertonic." F1
 *   bare examples/supertonic-mtl-tts.js "Bonjour tout le monde." M1
 *
 * Expects the multilingual Supertonic GGUF at:
 *   models/supertonic2.gguf
 *
 * Convert with `npm run setup-models` (which now produces both
 * supertonic.gguf for English and supertonic2.gguf for multilingual).
 * For a back-to-back sweep across the tier-1 set see
 * supertonic-mtl-sweep-tts.js; for the simpler English-pinned entry
 * point see supertonic-tts.js.
 *
 * NOTE: Supertonic is CPU-only in tts-cpp today.  This example sets
 * useGPU=false explicitly to match.
 */

const fs = require('bare-fs')
const path = require('bare-path')
const { detectOne, detectMultiple } = require('@qvac/langdetect-text')
const TTSGgml = require('../')
const { createWav } = require('./wav-helper')
const { setLogger, releaseLogger } = require('../addonLogging')

const SUPERTONIC_SAMPLE_RATE = 44100

const SUPPORTED_SUPERTONIC_LANGUAGES = new Set([
  'en', 'ko', 'es', 'pt', 'fr'
])

const argv = global.Bare ? global.Bare.argv : process.argv
const textArg = argv[2]
const voiceArg = argv[3]

if (!textArg || typeof textArg !== 'string' || textArg.trim().length === 0) {
  console.error('Usage: supertonic-mtl-tts.js "<text to synthesize>" [voice]')
  if (global.Bare) global.Bare.exit(1)
  else process.exit(1)
}

const pkgRoot = path.join(__dirname, '..')
const modelDir = path.join(pkgRoot, 'models')
const supertonicModel = path.join(modelDir, 'supertonic2.gguf')

if (!fs.existsSync(supertonicModel)) {
  console.error(`Missing model file: ${supertonicModel}`)
  console.error('Run "npm run setup-models" (or "bash scripts/convert-models.sh -t supertonic-mtl") to convert the Supertone Supertonic-2 ONNX bundle to GGUF.')
  if (global.Bare) global.Bare.exit(1)
  else process.exit(1)
}

function selectLanguage (text) {
  const detected = detectOne(text) || {}
  const rawCode = typeof detected.code === 'string' ? detected.code.toLowerCase() : 'und'
  const detectedName = typeof detected.language === 'string' ? detected.language : 'unknown'

  if (SUPPORTED_SUPERTONIC_LANGUAGES.has(rawCode)) {
    return { code: rawCode, detectedCode: rawCode, detectedName, fallbackReason: '' }
  }

  // Top-1 wasn't supported. tinyld often misclassifies short Romance
  // sentences with brand terms as Latin / Undetermined — scan the
  // top-K and pick the highest-ranked supported candidate before
  // surrendering to English.
  let topK = []
  try { topK = detectMultiple(text, 5) || [] } catch (_e) {}
  for (const c of topK) {
    const code = typeof c.code === 'string' ? c.code.toLowerCase() : ''
    if (SUPPORTED_SUPERTONIC_LANGUAGES.has(code)) {
      return {
        code,
        detectedCode: rawCode,
        detectedName,
        fallbackReason: `top-1 "${rawCode}" not in tier-1 set; using highest-ranked supported candidate "${code}"`
      }
    }
  }

  const fallbackReason = rawCode === 'und'
    ? 'language detection was undetermined and no supported candidate found; falling back to English'
    : `language "${rawCode}" is not in the Supertonic tier-1 set (en/ko/es/pt/fr) and no supported candidate found; falling back to English`

  return { code: 'en', detectedCode: rawCode, detectedName, fallbackReason }
}

async function main () {
  setLogger((priority, message) => {
    if (priority > 1) return
    const names = { 0: 'ERROR', 1: 'WARNING', 2: 'INFO', 3: 'DEBUG', 4: 'OFF' }
    const name = names[priority] || 'UNKNOWN'
    console.log(`[${new Date().toISOString()}] [C++ log] [${name}]: ${message}`)
  })

  const selection = selectLanguage(textArg)
  const voice = voiceArg || 'F1'
  const outputFile = path.join(__dirname, `supertonic-mtl-${selection.code}.wav`)

  console.log(`Input text: "${textArg}"`)
  console.log(`Detected language: ${selection.detectedName} (${selection.detectedCode})`)
  console.log(`Effective TTS language: ${selection.code}`)
  if (selection.fallbackReason) {
    console.warn(`Language fallback: ${selection.fallbackReason}`)
  }
  console.log(`Voice: ${voice}`)
  console.log(`Output file: ${outputFile}\n`)

  const model = new TTSGgml({
    engine: TTSGgml.ENGINE_SUPERTONIC,
    files: { supertonicModel },
    voice,
    config: { language: selection.code, useGPU: false },
    logger: console,
    opts: { stats: true }
  })

  try {
    console.log('Loading Supertonic MTL TTS model...')
    await model.load()
    console.log('Model loaded.')

    console.log(`Running TTS on: "${textArg}" (voice=${voice})`)
    const response = await model.run({ input: textArg, type: 'text' })

    let buffer = []
    await response
      .onUpdate(data => {
        if (data && data.outputArray) {
          buffer = buffer.concat(Array.from(data.outputArray))
        }
      })
      .await()

    console.log('TTS finished!')
    if (response.stats) {
      const s = response.stats
      console.log(`Inference stats: totalTime=${s.totalTime.toFixed(2)}s, tokensPerSecond=${s.tokensPerSecond.toFixed(2)}, realTimeFactor=${s.realTimeFactor.toFixed(3)}, audioDuration=${s.audioDurationMs}ms, totalSamples=${s.totalSamples}`)
    }

    console.log('\nWriting to .wav file...')
    createWav(buffer, SUPERTONIC_SAMPLE_RATE, outputFile)
    console.log(`Finished writing to ${outputFile}`)
  } catch (err) {
    console.error('Error during TTS processing:', err)
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
