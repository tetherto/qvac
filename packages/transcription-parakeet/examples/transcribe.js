'use strict'

/**
 * Universal transcribe / diarize example.
 *
 * Loads a single Parakeet GGUF (CTC, TDT, EOU, or Sortformer) and
 * runs inference on a wav / raw PCM file via the public
 * `TranscriptionParakeet` class. The binding auto-detects the model
 * type from GGUF metadata, so the same script handles every engine.
 *
 * Usage:
 *   bare examples/transcribe.js --model <gguf> --audio <file>
 */

/* global Bare */
const path = require('bare-path')
const process = require('bare-process')
const TranscriptionParakeet = require('../index.js')
const addonLogging = require('../addonLogging.js')
const {
  setupLogger,
  parseWavFile,
  convertRawToFloat32,
  readFileAsStream,
  validatePaths,
  printResults
} = require('./utils.js')

function parseArgs () {
  const args = { model: null, audio: null }
  const argv = Bare.argv.slice(2)
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--model' || a === '-m') args.model = argv[++i]
    else if (a === '--audio' || a === '-a') args.audio = argv[++i]
  }
  return args
}

async function loadAudio (audioPath) {
  const ext = path.extname(audioPath).toLowerCase()
  if (ext === '.wav') return parseWavFile(audioPath)
  const rawBuffer = await readFileAsStream(audioPath)
  return convertRawToFloat32(rawBuffer)
}

async function main () {
  const args = parseArgs()
  if (!args.model || !args.audio) {
    console.error('Usage: bare examples/transcribe.js --model <gguf> --audio <file>')
    process.exit(1)
  }

  setupLogger(addonLogging)
  const modelPath = path.resolve(args.model)
  const audioPath = path.resolve(args.audio)
  if (!validatePaths({ model: modelPath, audio: audioPath })) {
    addonLogging.releaseLogger()
    process.exit(1)
  }

  console.log(`Model: ${modelPath}`)
  console.log(`Audio: ${audioPath}`)

  const model = new TranscriptionParakeet({
    files: { model: modelPath }
  })

  await model.load()

  const audioData = await loadAudio(audioPath)
  console.log(`Audio: ${(audioData.length / 16000).toFixed(2)}s\n`)

  const segments = []
  const response = await model.run(audioData)
  await response
    .onUpdate(out => {
      const items = Array.isArray(out) ? out : [out]
      for (const s of items) {
        if (s && s.text && s.toAppend) segments.push(s)
      }
    })
    .await()

  printResults(segments)
  await model.unload()
  addonLogging.releaseLogger()
}

main().catch(err => {
  console.error('Error:', err)
  addonLogging.releaseLogger()
  process.exit(1)
})
