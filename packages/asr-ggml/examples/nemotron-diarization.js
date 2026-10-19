'use strict'

const path = require('bare-path')
const process = require('bare-process')
const ASRGgml = require('../index.js')
const { parseWavFile, validatePaths } = require('./parakeet-utils.js')

const MODEL_TYPE = 'nemotron-diarization'

function parseArgs(argv) {
  const args = { model: null, audio: null }
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--model') args.model = argv[++index]
    else if (argv[index] === '--audio') args.audio = argv[++index]
  }
  return args
}

function appendSpeakerSegments(target, updates) {
  const items = Array.isArray(updates) ? updates : [updates]
  for (const item of items) {
    if (item && item.speakerSegments) target.push(...item.speakerSegments)
  }
}

async function diarize(model, audio) {
  const segments = []
  const response = await model.run(audio)
  await response.onUpdate((updates) => appendSpeakerSegments(segments, updates)).await()
  return segments
}

function printSegments(segments) {
  for (const segment of segments) {
    console.log(
      `Speaker ${segment.speakerId}: ${segment.start.toFixed(2)} - ${segment.end.toFixed(2)}`
    )
  }
}

async function main() {
  const args = parseArgs(globalThis.Bare.argv.slice(2))
  if (!args.model || !args.audio) {
    throw new Error('Usage: bare examples/nemotron-diarization.js --model <gguf> --audio <wav>')
  }
  const modelPath = path.resolve(args.model)
  const audioPath = path.resolve(args.audio)
  if (!validatePaths({ model: modelPath, audio: audioPath })) {
    throw new Error('Model or audio file is missing')
  }

  const model = new ASRGgml({ engine: 'parakeet', files: { model: modelPath } })
  await model.load()
  try {
    if (model.getBackendInfo().modelType !== MODEL_TYPE) {
      throw new Error(`Expected ${MODEL_TYPE} GGUF`)
    }
    printSegments(await diarize(model, parseWavFile(audioPath)))
  } finally {
    await model.unload()
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
