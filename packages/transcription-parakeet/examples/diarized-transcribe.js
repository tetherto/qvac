'use strict'

/**
 * Combined ASR + diarization example (offline).
 *
 * Runs Sortformer to find speaker time-segments, then transcribes
 * each speaker's audio slice with the ASR model. Output is a
 * "Speaker N: ..." per-segment transcript. Both engines run
 * through the public `TranscriptionParakeet` class.
 *
 * Recommended `--diar-model`: the v1 Sortformer GGUF
 * (`sortformer-4spk-v1.q8_0.gguf`). v2.1 also works but the AOSC
 * speaker cache it brings is a *streaming* optimisation -- in batch /
 * offline mode the entire clip is available at once, so AOSC's slot
 * stability across silence/re-entry provides no additional benefit
 * over v1. For live capture, use `examples/live-mic-diarized.js`
 * (or `examples/live-mic-diarized-aosc.js`) with the v2.1 GGUF.
 *
 * Usage:
 *   bare examples/diarized-transcribe.js \
 *        --asr-model <gguf> --diar-model <gguf> --audio <file>
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
  validatePaths
} = require('./utils.js')

const SAMPLE_RATE = 16000

function parseArgs () {
  const args = { asrModel: null, diarModel: null, audio: null }
  const argv = Bare.argv.slice(2)
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--asr-model' || a === '-m') args.asrModel = argv[++i]
    else if (a === '--diar-model' || a === '-d') args.diarModel = argv[++i]
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

function parseSpeakerSegments (sortformerText) {
  const segments = []
  for (const line of sortformerText.split('\n')) {
    const m = line.match(/Speaker\s+(\d+)\s*:\s*([\d.:]+)\s*-\s*([\d.:]+)/)
    if (!m) continue
    const toSec = (ts) => {
      const parts = ts.split(':').map(parseFloat)
      if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
      if (parts.length === 2) return parts[0] * 60 + parts[1]
      return parts[0]
    }
    segments.push({
      speaker: parseInt(m[1], 10),
      start: toSec(m[2]),
      end: toSec(m[3])
    })
  }
  segments.sort((a, b) => a.start - b.start)
  return segments
}

function sliceAudio (audioData, startS, endS) {
  const i0 = Math.max(0, Math.floor(startS * SAMPLE_RATE))
  const i1 = Math.min(audioData.length, Math.ceil(endS * SAMPLE_RATE))
  if (i1 <= i0) return null
  return audioData.slice(i0, i1)
}

async function transcribeSegments (asrModel, audioData, segments) {
  const results = []
  for (const seg of segments) {
    const slice = sliceAudio(audioData, seg.start, seg.end)
    if (!slice) {
      results.push({ speaker: seg.speaker, text: '[no audio]' })
      continue
    }
    const segments = []
    const response = await asrModel.run(slice)
    await response
      .onUpdate(out => {
        const items = Array.isArray(out) ? out : [out]
        for (const s of items) {
          if (s && s.text && s.toAppend) segments.push(s)
        }
      })
      .await()
    const text = segments.map(s => s.text).join(' ').trim()
    results.push({ speaker: seg.speaker, text: text || '[no speech]' })
  }
  return results
}

async function main () {
  const args = parseArgs()
  if (!args.asrModel || !args.diarModel || !args.audio) {
    console.error('Usage: bare examples/diarized-transcribe.js --asr-model <gguf> --diar-model <gguf> --audio <file>')
    process.exit(1)
  }

  setupLogger(addonLogging)
  const asrPath = path.resolve(args.asrModel)
  const diarPath = path.resolve(args.diarModel)
  const audioPath = path.resolve(args.audio)
  if (!validatePaths({ model: asrPath, audio: audioPath })) {
    addonLogging.releaseLogger()
    process.exit(1)
  }
  if (!validatePaths({ model: diarPath })) {
    addonLogging.releaseLogger()
    process.exit(1)
  }

  console.log(`ASR:   ${asrPath}`)
  console.log(`Diar:  ${diarPath}`)
  console.log(`Audio: ${audioPath}`)

  const audioData = await loadAudio(audioPath)
  console.log(`Audio: ${(audioData.length / SAMPLE_RATE).toFixed(2)}s\n`)

  // Step 1: diarize.
  const diarModel = new TranscriptionParakeet({ files: { model: diarPath } })
  await diarModel.load()
  const sortformerSegments = []
  const diarResponse = await diarModel.run(audioData)
  await diarResponse
    .onUpdate(out => {
      const items = Array.isArray(out) ? out : [out]
      for (const s of items) {
        if (s && s.text) sortformerSegments.push(s)
      }
    })
    .await()
  await diarModel.unload()

  const sfText = sortformerSegments.map(s => s.text).join(' ').trim()
  const segments = parseSpeakerSegments(sfText)
  if (segments.length === 0) {
    console.log('No speakers detected.')
    addonLogging.releaseLogger()
    return
  }

  // Step 2: transcribe each speaker segment.
  const asrModel = new TranscriptionParakeet({ files: { model: asrPath } })
  await asrModel.load()
  const results = await transcribeSegments(asrModel, audioData, segments)
  await asrModel.unload()

  console.log('\n=== Diarized Transcription ===')
  for (const e of results) console.log(`Speaker ${e.speaker}: ${e.text}`)

  addonLogging.releaseLogger()
}

main().catch(err => {
  console.error('Error:', err)
  addonLogging.releaseLogger()
  process.exit(1)
})
