'use strict'

/**
 * Chatterbox MULTILINGUAL TTS for @qvac/tts-ggml (auto language detect).
 *
 * Loads the multilingual GGUFs (chatterbox-t3-mtl + chatterbox-s3gen-mtl)
 * and synthesizes a single sentence whose language is auto-detected via
 * @qvac/langdetect-text.  Falls back to "en" with a warning when the
 * detected code isn't in the MTL tier-1 set or when detection is
 * undetermined.  Mirrors the API surface of chatterbox-tts.js: pass the
 * sentence on the command line, optionally followed by a reference wav.
 *
 * Usage:
 *   bare examples/chatterbox-mtl-tts.js "<text to synthesize>" [path/to/reference.wav]
 *
 * Examples:
 *   bare examples/chatterbox-mtl-tts.js "Hello from the multilingual Chatterbox engine."
 *   bare examples/chatterbox-mtl-tts.js "El zorro marron salta sobre el perro perezoso."
 *   bare examples/chatterbox-mtl-tts.js "Bonjour tout le monde." ~/voices/me.wav
 *
 * Expects the multilingual GGUF files at:
 *   models/chatterbox-t3-mtl.gguf
 *   models/chatterbox-s3gen-mtl.gguf
 *
 * Convert models with `npm run setup-models`.  For a back-to-back sweep
 * across the tier-1 set see chatterbox-mtl-sweep-tts.js; for the English
 * Turbo variant see chatterbox-tts.js.
 */

const fs = require('bare-fs')
const path = require('bare-path')
const { detectOne, detectMultiple } = require('@qvac/langdetect-text')
const TTSGgml = require('../')
const { createWav } = require('./wav-helper')
const { setLogger, releaseLogger } = require('../addonLogging')

const CHATTERBOX_SAMPLE_RATE = 24000

const SUPPORTED_MTL_LANGUAGES = new Set([
  'en', 'es', 'fr', 'de', 'it', 'pt', 'nl', 'pl', 'tr',
  'sv', 'da', 'fi', 'no', 'el', 'ms', 'sw', 'ar', 'ko'
])

const argv = global.Bare ? global.Bare.argv : process.argv
const textArg = argv[2]
const refAudioArg = argv[3]

if (!textArg || typeof textArg !== 'string' || textArg.trim().length === 0) {
  console.error('Usage: chatterbox-mtl-tts.js "<text to synthesize>" [path/to/reference.wav]')
  if (global.Bare) global.Bare.exit(1)
  else process.exit(1)
}

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

function selectLanguage (text) {
  const detected = detectOne(text) || {}
  const rawCode = typeof detected.code === 'string' ? detected.code.toLowerCase() : 'und'
  const detectedName = typeof detected.language === 'string' ? detected.language : 'unknown'

  if (SUPPORTED_MTL_LANGUAGES.has(rawCode)) {
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
    if (SUPPORTED_MTL_LANGUAGES.has(code)) {
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
    : `language "${rawCode}" is not in the MTL tier-1 set and no supported candidate found; falling back to English`

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
  const outputFile = path.join(__dirname, `chatterbox-mtl-${selection.code}.wav`)

  console.log(`Input text: "${textArg}"`)
  console.log(`Detected language: ${selection.detectedName} (${selection.detectedCode})`)
  console.log(`Effective TTS language: ${selection.code}`)
  if (selection.fallbackReason) {
    console.warn(`Language fallback: ${selection.fallbackReason}`)
  }
  console.log(`Output file: ${outputFile}\n`)

  const model = new TTSGgml({
    files: { t3Model, s3genModel },
    ...(refAudioArg ? { referenceAudio: refAudioArg } : {}),
    config: { language: selection.code },
    logger: console,
    opts: { stats: true }
  })

  try {
    console.log('Loading Chatterbox MTL TTS model...')
    await model.load()
    console.log('Model loaded.')

    console.log(`Running TTS on: "${textArg}"`)
    const response = await model.run({ input: textArg, type: 'text' })

    console.log('Waiting for TTS results...')
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
      console.log(`Inference stats: totalTime=${s.totalTime.toFixed(2)}s, tokensPerSecond=${s.tokensPerSecond.toFixed(2)}, realTimeFactor=${s.realTimeFactor.toFixed(2)}, audioDuration=${s.audioDurationMs}ms, totalSamples=${s.totalSamples}`)
    }

    console.log('\nWriting to .wav file...')
    createWav(buffer, CHATTERBOX_SAMPLE_RATE, outputFile)
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
