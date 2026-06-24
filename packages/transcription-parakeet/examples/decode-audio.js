'use strict'

/**
 * Decode + transcribe example.
 *
 * Same flag surface as `examples/transcribe.js`, but pipes the input
 * audio through `@qvac/decoder-audio` (FFmpeg) first so any
 * container / codec FFmpeg supports (mp3, m4a, ogg, flac, mp4, ...)
 * works -- not just 16 kHz mono `.wav` / raw s16le PCM. Drives
 * inference through the public `TranscriptionParakeet` class.
 *
 * Usage:
 *   bare examples/decode-audio.js --model <gguf> --audio <file>
 */

/* global Bare */
const fs = require('bare-fs')
const path = require('bare-path')
const process = require('bare-process')
const { FFmpegDecoder } = require('@qvac/decoder-audio')
const TranscriptionParakeet = require('../index.js')
const addonLogging = require('../addonLogging.js')
const { setupLogger, validatePaths, printResults } = require('./utils.js')

const SAMPLE_RATE = 16000

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

const silentLogger = {
  debug () {}, info () {}, warn () {}, error () {}
}

async function decodeToFloat32 (audioPath) {
  const decoder = new FFmpegDecoder({
    config: { streamIndex: 0 },
    logger: silentLogger
  })
  await decoder.load()
  try {
    const chunks = []
    let totalSamples = 0
    const audioStream = fs.createReadStream(audioPath)
    const response = await decoder.run(audioStream)

    response.on('output', (data) => {
      const view = new DataView(data.outputArray.buffer,
        data.outputArray.byteOffset,
        data.outputArray.byteLength)
      const n = Math.floor(data.outputArray.byteLength / 2)
      const f32 = new Float32Array(n)
      for (let i = 0; i < n; i++) {
        f32[i] = view.getInt16(i * 2, true) / 32768
      }
      chunks.push(f32)
      totalSamples += n
    })

    await new Promise((resolve, reject) => {
      response.on('end', resolve)
      response.on('error', reject)
    })

    const merged = new Float32Array(totalSamples)
    let offset = 0
    for (const c of chunks) {
      merged.set(c, offset)
      offset += c.length
    }
    return merged
  } finally {
    await decoder.unload()
  }
}

async function main () {
  const args = parseArgs()
  if (!args.model || !args.audio) {
    console.error('Usage: bare examples/decode-audio.js --model <gguf> --audio <file>')
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

  const audioData = await decodeToFloat32(audioPath)
  console.log(`Audio: ${(audioData.length / SAMPLE_RATE).toFixed(2)}s (decoded)\n`)

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
