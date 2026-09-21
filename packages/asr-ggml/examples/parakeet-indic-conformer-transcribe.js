'use strict'

/* global Bare */
const path = require('bare-path')
const process = require('bare-process')
const ASRGgml = require('../index.js')
const addonLogging = require('../addonLogging.js')
const {
  setupLogger,
  parseWavFile,
  convertRawToFloat32,
  readFileAsStream,
  validatePaths,
  printResults
} = require('./parakeet-utils.js')

const SAMPLE_RATE = 16000
const USAGE =
  'Usage: bare examples/parakeet-indic-conformer-transcribe.js --model <gguf> --audio <file> --language <id>'

function parseArgs() {
  const args = { model: null, audio: null, language: null }
  const argv = Bare.argv.slice(2)
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    if (argument === '--model' || argument === '-m') args.model = argv[++index]
    else if (argument === '--audio' || argument === '-a') args.audio = argv[++index]
    else if (argument === '--language' || argument === '-l') args.language = argv[++index]
  }
  return args
}

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

async function transcribe(model, audioData) {
  const segments = []
  const response = await model.run(audioData)
  await response.onUpdate((output) => appendSegments(segments, output)).await()
  return segments
}

async function main() {
  const args = parseArgs()
  if (!args.model || !args.audio || !args.language) {
    console.error(USAGE)
    process.exit(1)
  }

  const modelPath = path.resolve(args.model)
  const audioPath = path.resolve(args.audio)
  if (!validatePaths({ model: modelPath, audio: audioPath })) process.exit(1)

  setupLogger(addonLogging)
  const model = new ASRGgml({
    files: { model: modelPath },
    config: {
      engine: 'parakeet',
      parakeetConfig: { language: args.language }
    }
  })

  try {
    await model.load()
    const audioData = await loadAudio(audioPath)
    console.log(`Model: ${modelPath}`)
    console.log(`Audio: ${audioPath}`)
    console.log(`Language: ${args.language}`)
    console.log(`Duration: ${(audioData.length / SAMPLE_RATE).toFixed(2)}s`)
    printResults(await transcribe(model, audioData))
  } finally {
    await model.unload()
    addonLogging.releaseLogger()
  }
}

main().catch((error) => {
  console.error('Error:', error)
  addonLogging.releaseLogger()
  process.exit(1)
})
