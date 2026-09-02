'use strict'

/* global Bare */
const path = require('bare-path')
const process = require('bare-process')
const ASRGgml = require('../index.js')
const { parseWavFile, printResults, validatePaths } = require('./parakeet-utils.js')

const DEFAULT_MODEL = 'models/parakeet-unified-en-0.6b.q8_0.gguf'
const DEFAULT_AUDIO = 'examples/samples/sample-16k.wav'

function valueAfter(argv, flag, fallback) {
  const index = argv.indexOf(flag)
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback
}

function collectSegments(response, segments) {
  return response
    .onUpdate((output) => {
      const items = Array.isArray(output) ? output : [output]
      for (const segment of items) {
        if (segment && segment.text) segments.push(segment)
      }
    })
    .await()
}

async function transcribe(modelPath, audioPath) {
  const model = new ASRGgml({
    files: { model: modelPath },
    config: {
      engine: 'parakeet',
      parakeetConfig: { useGPU: false }
    }
  })
  try {
    await model.load()
    const segments = []
    const response = await model.run(parseWavFile(audioPath))
    await collectSegments(response, segments)
    return segments
  } finally {
    await model.unload()
  }
}

async function main() {
  const argv = Bare.argv.slice(2)
  const modelPath = path.resolve(valueAfter(argv, '--model', DEFAULT_MODEL))
  const audioPath = path.resolve(valueAfter(argv, '--audio', DEFAULT_AUDIO))
  if (!validatePaths({ model: modelPath, audio: audioPath })) process.exit(1)
  printResults(await transcribe(modelPath, audioPath))
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
