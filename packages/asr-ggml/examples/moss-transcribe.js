'use strict'

/**
 * MOSS-Transcribe-Diarize example: one pass over a whole recording that
 * returns timestamped, speaker-labelled segments, optionally biased toward
 * the names and terms passed as hotwords.
 *
 * The model is validated for Spanish and Chinese. Its output is
 * `[start-end] Sxx: text` per segment; `speaker` carries the label and
 * `speakerId` the same speaker 0-based.
 *
 * Usage:
 *   bare examples/moss-transcribe.js --model <gguf> --audio <file.wav|file.raw>
 *        [--hotwords "QVAC,vcpkg,Parakeet"] [--gpu]
 *
 * Example:
 *   bare examples/moss-transcribe.js --model models/moss-transcribe-diarize-q8_0.gguf \
 *        --audio examples/samples/LastQuestion_long_ES.raw --gpu
 */

/* global Bare */
const path = require('bare-path')
const ASRGgml = require('../index.js')
const {
  parseWavFile,
  convertRawToFloat32,
  readFileAsStream,
  validatePaths
} = require('./parakeet-utils.js')

function parseArgs() {
  const args = { model: null, audio: null, hotwords: [], gpu: false }
  const argv = Bare.argv.slice(2)
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--model' || arg === '-m') args.model = argv[++i]
    else if (arg === '--audio' || arg === '-a') args.audio = argv[++i]
    else if (arg === '--hotwords') args.hotwords = argv[++i].split(',').map((word) => word.trim())
    else if (arg === '--gpu') args.gpu = true
  }
  return args
}

async function loadAudio(audioPath) {
  if (path.extname(audioPath).toLowerCase() === '.wav') return parseWavFile(audioPath)
  return convertRawToFloat32(await readFileAsStream(audioPath))
}

function formatSegment(segment) {
  return `[${segment.start.toFixed(2)}-${segment.end.toFixed(2)}] ${segment.speaker}: ${segment.text}`
}

async function main() {
  const args = parseArgs()
  if (!args.model || !args.audio) {
    console.error(
      'Usage: moss-transcribe.js --model <gguf> --audio <file> [--hotwords "a,b"] [--gpu]'
    )
    Bare.exit(1)
  }
  if (!validatePaths({ model: args.model, audio: args.audio })) Bare.exit(1)

  const model = new ASRGgml({
    files: { model: args.model },
    config: { engine: 'moss-transcribe', mossTranscribeConfig: { useGPU: args.gpu } }
  })
  try {
    await model.load()
    const audio = await loadAudio(args.audio)
    const options = args.hotwords.length > 0 ? { hotwords: args.hotwords } : {}
    const response = await model.run(audio, options)
    await response
      .onUpdate((segments) => {
        for (const segment of Array.isArray(segments) ? segments : [segments]) {
          if (segment && segment.text) console.log(formatSegment(segment))
        }
      })
      .await()
    console.log('Stats:', response.stats)
  } finally {
    await model.unload()
  }
}

main().catch((error) => {
  console.error(error)
  Bare.exit(1)
})
