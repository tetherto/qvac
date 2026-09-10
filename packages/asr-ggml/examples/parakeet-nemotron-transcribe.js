'use strict'

/**
 * Nemotron 3.5 ASR batch or cache-aware streaming transcription.
 *
 * Usage:
 *   bare examples/parakeet-nemotron-transcribe.js \
 *     [--model <gguf>] [--audio <wav>] [--language <locale>] \
 *     [--streaming] [--chunk-ms <80|160|320|560|1120>]
 *
 * An empty language selects Nemotron's `auto` prompt. Streaming defaults to
 * the model's trained 320 ms operating point when --chunk-ms is omitted.
 */

/* global Bare */
const path = require('bare-path')
const process = require('bare-process')
const ASRGgml = require('../index.js')
const { parseWavFile, printResults, validatePaths } = require('./parakeet-utils.js')

const DEFAULT_MODEL = 'models/nemotron-3.5-asr-streaming-0.6b.q8_0.gguf'
const DEFAULT_AUDIO = 'examples/samples/sample-16k.wav'
const SAMPLE_RATE = 16000

function parseArgs(argv) {
  const args = {
    model: DEFAULT_MODEL,
    audio: DEFAULT_AUDIO,
    language: '',
    streaming: false,
    chunkMs: null
  }

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (flag === '--model' || flag === '-m') args.model = argv[++i]
    else if (flag === '--audio' || flag === '-a') args.audio = argv[++i]
    else if (flag === '--language' || flag === '-l') args.language = argv[++i]
    else if (flag === '--streaming') args.streaming = true
    else if (flag === '--chunk-ms') args.chunkMs = Number(argv[++i])
    else throw new Error(`Unknown argument: ${flag}`)
  }

  const operatingPoints = [80, 160, 320, 560, 1120]
  if (args.chunkMs !== null && !operatingPoints.includes(args.chunkMs)) {
    throw new Error(`--chunk-ms must be one of: ${operatingPoints.join(', ')}`)
  }
  return args
}

async function* streamAudio(audio, chunkMs) {
  const samplesPerChunk = (SAMPLE_RATE * chunkMs) / 1000
  for (let offset = 0; offset < audio.length; offset += samplesPerChunk) {
    yield audio.subarray(offset, Math.min(offset + samplesPerChunk, audio.length))
  }
}

async function collect(response) {
  const segments = []
  await response
    .onUpdate((output) => {
      for (const segment of Array.isArray(output) ? output : [output]) {
        if (segment && segment.text) segments.push(segment)
      }
    })
    .await()
  return segments
}

async function main() {
  const args = parseArgs(Bare.argv.slice(2))
  const modelPath = path.resolve(args.model)
  const audioPath = path.resolve(args.audio)
  if (!validatePaths({ model: modelPath, audio: audioPath })) process.exit(1)

  const parakeetConfig = {
    language: args.language,
    streaming: args.streaming,
    useGPU: false
  }
  if (args.chunkMs !== null) parakeetConfig.streamingChunkMs = args.chunkMs

  const model = new ASRGgml({
    files: { model: modelPath },
    config: { engine: 'parakeet', parakeetConfig }
  })

  try {
    await model.load()
    const audio = parseWavFile(audioPath)
    const response = args.streaming
      ? await model.runStreaming(streamAudio(audio, args.chunkMs || 320))
      : await model.run(audio)
    printResults(await collect(response))
  } finally {
    await model.unload()
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
