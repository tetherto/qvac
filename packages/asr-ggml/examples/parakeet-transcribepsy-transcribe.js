'use strict'

/**
 * TranscribePsy example, for EU-sub and the full 25-language EU model.
 *
 * Loads the published EU-sub q8_0 GGUF, or on an Apple build the encoder-less
 * `transcribepsy-250m-eu-sub-coreml.gguf` next to its Neural Engine encoder
 * and decoder sidecars, and transcribes a wav / raw 16 kHz PCM file. The full
 * `transcribepsy-250m-eu.gguf` loads the same way; `--language` selects its
 * English trunk (`en`), its adapters (`other`) or the language gate (`auto`),
 * and on an Apple build its Core ML sidecars are used when they sit next to
 * the GGUF. Long recordings use the 60 s / 25 % windows the model recommends
 * unless `--window-sec` (and `--overlap`) ask for others. The example reports
 * which backend ran the encoder, whether every window ran on Core ML and
 * whether the decoder did.
 *
 * Usage:
 *   bare examples/parakeet-transcribepsy-transcribe.js --model <gguf> --audio <file> \
 *     [--window-sec <seconds>] [--overlap <fraction>] [--language <auto|en|other>]
 */

/* global Bare */
const path = require('bare-path')
const process = require('bare-process')
const ASRGgml = require('../index.js')
const addonLogging = require('../addonLogging.js')
const {
  NO_CONTEXT_FRAMES,
  USAGE,
  describeCoremlRouting,
  parakeetConfigFor,
  parseLongFormArguments
} = require('./parakeet-long-form-arguments.js')
const {
  setupLogger,
  parseWavFile,
  convertRawToFloat32,
  readFileAsStream,
  validatePaths,
  printResults
} = require('./parakeet-utils.js')

const SAMPLE_RATE = 16000

async function loadAudio(audioPath) {
  if (path.extname(audioPath).toLowerCase() === '.wav') return parseWavFile(audioPath)
  return convertRawToFloat32(await readFileAsStream(audioPath))
}

function appendSegments(segments, output) {
  const items = Array.isArray(output) ? output : [output]
  for (const item of items) {
    if (item && item.text && item.toAppend) segments.push(item)
  }
}

async function transcribe(model, audio) {
  const segments = []
  const response = await model.run(audio)
  await response.onUpdate((output) => appendSegments(segments, output)).await()
  return { segments, stats: response.stats }
}

function describeWindows(parakeetConfig) {
  if (parakeetConfig.longFormWindowFrames === undefined) {
    console.log('Windows: recommended by the model (60 s / 25 % for TranscribePsy)')
    return
  }
  const context =
    parakeetConfig.longFormContextFrames === NO_CONTEXT_FRAMES
      ? 'no context'
      : `${parakeetConfig.longFormContextFrames} frames of context each side`
  console.log(`Windows: ${parakeetConfig.longFormWindowFrames} encoder frames, ${context}`)
}

async function main() {
  const args = parseLongFormArguments(Bare.argv.slice(2))
  if (!args.model || !args.audio) {
    console.error(USAGE)
    process.exit(1)
  }

  setupLogger(addonLogging)
  const modelPath = path.resolve(args.model)
  const audioPath = path.resolve(args.audio)
  if (!validatePaths({ model: modelPath, audio: audioPath })) {
    addonLogging.releaseLogger()
    process.exit(1)
  }

  const parakeetConfig = parakeetConfigFor(args)
  console.log(`Model: ${modelPath}`)
  console.log(`Audio: ${audioPath}`)
  if (parakeetConfig.language) console.log(`Language route: ${parakeetConfig.language}`)
  describeWindows(parakeetConfig)

  const model = new ASRGgml({
    files: { model: modelPath },
    config: { engine: 'parakeet', parakeetConfig }
  })
  await model.load()

  const audio = await loadAudio(audioPath)
  console.log(`Duration: ${(audio.length / SAMPLE_RATE).toFixed(2)} s\n`)

  const { segments, stats } = await transcribe(model, audio)
  for (const line of describeCoremlRouting(model.getBackendInfo(), stats)) console.log(line)
  printResults(segments)

  await model.unload()
  addonLogging.releaseLogger()
}

main().catch((err) => {
  console.error('Error:', err.message || err)
  addonLogging.releaseLogger()
  process.exit(1)
})
