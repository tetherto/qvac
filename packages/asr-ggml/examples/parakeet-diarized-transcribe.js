'use strict'

/* global Bare */
const path = require('bare-path')
const process = require('bare-process')
const ASRGgml = require('../index.js')
const {
  parseWavFile,
  convertRawToFloat32,
  readFileAsStream,
  validatePaths
} = require('./parakeet-utils.js')

function parseArgs(argv) {
  const flags = {
    '--asr-model': 'asrModel',
    '-m': 'asrModel',
    '--diar-model': 'diarModel',
    '-d': 'diarModel',
    '--audio': 'audio',
    '-a': 'audio',
    '--backend': 'backend',
    '--min-segment-ms': 'minSegmentMs',
    '--pad-segment-ms': 'padSegmentMs'
  }
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--no-merge') {
      args.mergeSameSpeaker = false
      continue
    }
    const key = flags[argv[i]]
    if (!key || argv[i + 1] === undefined) {
      throw new Error(`Unknown or incomplete option: ${argv[i]}`)
    }
    const value = argv[++i]
    args[key] = key.endsWith('Ms') ? Number(value) : value
  }
  return args
}

async function loadAudio(audioPath) {
  if (path.extname(audioPath).toLowerCase() === '.wav') return parseWavFile(audioPath)
  return convertRawToFloat32(await readFileAsStream(audioPath))
}

function printSegments(output) {
  for (const segment of Array.isArray(output) ? output : [output]) {
    console.log(JSON.stringify(segment))
  }
}

async function main() {
  const args = parseArgs(Bare.argv.slice(2))
  if (!args.asrModel || !args.diarModel || !args.audio) {
    throw new Error(
      'Usage: bare examples/parakeet-diarized-transcribe.js --asr-model <gguf> --diar-model <gguf> --audio <16k-mono.wav> [--backend <device>] [--no-merge] [--min-segment-ms <ms>] [--pad-segment-ms <ms>]'
    )
  }
  if (!validatePaths({ model: args.asrModel, diarizer: args.diarModel, audio: args.audio })) {
    process.exit(1)
  }
  const model = new ASRGgml({
    files: { model: path.resolve(args.asrModel) },
    config: {
      engine: 'parakeet',
      parakeetConfig: {
        backend: args.backend,
        speakerAttribution: {
          modelPath: path.resolve(args.diarModel),
          mergeSameSpeaker: args.mergeSameSpeaker,
          minSegmentMs: args.minSegmentMs,
          padSegmentMs: args.padSegmentMs
        }
      }
    }
  })
  try {
    await model.load()
    console.log('Backend:', model.getBackendInfo())
    const response = await model.run(await loadAudio(args.audio))
    await response.onUpdate(printSegments).await()
  } finally {
    await model.unload()
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
