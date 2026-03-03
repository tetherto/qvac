'use strict'

/* global Bare */

/**
 * Parakeet Diarized Transcription Example
 *
 * Combines TDT (transcription) and Sortformer (speaker diarization)
 * to produce speaker-attributed transcription output.
 *
 * Usage: bare examples/quickstart-diarized.js [path/to/audio.wav]
 */

const path = require('bare-path')
const binding = require('../binding.js')
const { ParakeetInterface } = require('../parakeet.js')
const {
  setupLogger,
  parseWavFile,
  loadModelWeights,
  validatePaths,
  createJobTracker,
  createOutputCallback,
  TDT_MODEL_FILES,
  SORTFORMER_MODEL_FILES
} = require('./utils.js')

async function runPipeline (binding, config, modelPath, modelFiles, audioData) {
  const tracker = createJobTracker()

  const instance = new ParakeetInterface(
    binding,
    config,
    createOutputCallback(tracker),
    () => {}
  )

  await loadModelWeights(instance, modelPath, modelFiles)
  await instance.activate()
  await instance.append({ type: 'audio', data: audioData.buffer })
  await instance.append({ type: 'end of job' })

  const timeout = setTimeout(() => tracker.resolve(), 120000)
  await tracker.promise
  clearTimeout(timeout)

  const text = tracker.transcriptions.map(s => s.text).join(' ').trim()

  await instance.destroyInstance()
  return text
}

function parseSpeakerSegments (diarizationText) {
  const segments = []
  for (const line of diarizationText.split('\n')) {
    const match = line.match(/Speaker (\d+): ([\d.]+)s - ([\d.]+)s/)
    if (match) {
      segments.push({
        speaker: parseInt(match[1]),
        start: parseFloat(match[2]),
        end: parseFloat(match[3])
      })
    }
  }
  segments.sort((a, b) => a.start - b.start)
  return segments
}

// Approximate: words are distributed proportionally to segment duration because
// word-level timestamps are not available from the transcription model. Attribution
// near segment boundaries may be imprecise.
function assignWordsToSpeakers (transcription, speakerSegments) {
  if (speakerSegments.length === 0 || !transcription) {
    return [{ speaker: 0, text: transcription || '[No speech detected]' }]
  }

  const words = transcription.split(/\s+/)
  if (words.length === 0) {
    return [{ speaker: 0, text: '[No speech detected]' }]
  }

  const totalSpeakingTime = speakerSegments.reduce(
    (sum, seg) => sum + (seg.end - seg.start), 0
  )

  const result = []
  let wordIdx = 0

  for (let i = 0; i < speakerSegments.length; i++) {
    const seg = speakerSegments[i]
    const segDuration = seg.end - seg.start
    const proportion = segDuration / totalSpeakingTime

    let wordCount
    if (i === speakerSegments.length - 1) {
      wordCount = words.length - wordIdx
    } else {
      wordCount = Math.max(1, Math.round(proportion * words.length))
    }

    if (wordIdx >= words.length) break

    const segWords = words.slice(wordIdx, wordIdx + wordCount)
    wordIdx += wordCount

    if (result.length > 0 && result[result.length - 1].speaker === seg.speaker) {
      result[result.length - 1].text += ' ' + segWords.join(' ')
    } else {
      result.push({ speaker: seg.speaker, text: segWords.join(' ') })
    }
  }

  return result
}

async function main () {
  console.log('=== Parakeet Diarized Transcription ===\n')

  setupLogger(binding)

  const tdtModelPath = path.join(__dirname, '..', 'models', 'parakeet-tdt-0.6b-v3-onnx')
  const sfModelPath = path.join(__dirname, '..', 'models', 'sortformer-4spk-v2-onnx')
  const audioPath = Bare.argv[2]
    ? path.resolve(Bare.argv[2])
    : path.join(__dirname, 'samples', 'diarization-sample-16k.wav')

  if (!validatePaths({ model: tdtModelPath, audio: audioPath })) {
    binding.releaseLogger()
    return
  }
  if (!validatePaths({ model: sfModelPath })) {
    binding.releaseLogger()
    return
  }

  const audioData = parseWavFile(audioPath)
  const audioDuration = audioData.length / 16000
  console.log(`Audio: ${audioPath}`)
  console.log(`Duration: ${audioDuration.toFixed(2)}s\n`)

  console.log('1. Running transcription (TDT)...')
  const tdtConfig = { modelPath: tdtModelPath, modelType: 'tdt', maxThreads: 4, useGPU: false }
  const transcription = await runPipeline(binding, tdtConfig, tdtModelPath, TDT_MODEL_FILES, audioData)
  console.log(`   Transcription: ${transcription.substring(0, 80)}${transcription.length > 80 ? '...' : ''}\n`)

  console.log('2. Running diarization (Sortformer)...')
  const sfConfig = { modelPath: sfModelPath, modelType: 'sortformer', maxThreads: 4, useGPU: false }
  const diarization = await runPipeline(binding, sfConfig, sfModelPath, SORTFORMER_MODEL_FILES, audioData)
  console.log(`   Segments: ${diarization.replace(/\n/g, ', ')}\n`)

  console.log('3. Combining results...\n')
  const speakerSegments = parseSpeakerSegments(diarization)
  const attributed = assignWordsToSpeakers(transcription, speakerSegments)

  console.log('=== DIARIZED TRANSCRIPTION ===')
  console.log('='.repeat(60))
  for (const entry of attributed) {
    console.log(`Speaker ${entry.speaker}: ${entry.text}`)
  }
  console.log('='.repeat(60))

  console.log('\nCleaning up...')
  binding.releaseLogger()
  console.log('Done!')
}

main().catch(err => {
  console.error('Error:', err)
  binding.releaseLogger()
})
