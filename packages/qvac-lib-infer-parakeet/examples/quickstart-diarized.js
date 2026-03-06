'use strict'

/* global Bare */

/**
 * Parakeet Diarized Transcription Example
 *
 * Runs Sortformer to get speaker time segments, slices the audio by those
 * timestamps, then transcribes each slice with TDT for accurate speaker
 * attribution.
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

const SAMPLE_RATE = 16000

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

function sliceAudio (audioData, startSec, endSec) {
  const startSample = Math.floor(startSec * SAMPLE_RATE)
  const endSample = Math.min(Math.ceil(endSec * SAMPLE_RATE), audioData.length)
  if (startSample >= endSample) return null
  return audioData.slice(startSample, endSample)
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
  const audioDuration = audioData.length / SAMPLE_RATE
  console.log(`Audio: ${audioPath}`)
  console.log(`Duration: ${audioDuration.toFixed(2)}s\n`)

  // Step 1: Run Sortformer on full audio to get speaker time segments
  console.log('1. Running diarization (Sortformer)...')
  const sfTracker = createJobTracker()
  const sfInstance = new ParakeetInterface(
    binding,
    { modelPath: sfModelPath, modelType: 'sortformer', maxThreads: 4, useGPU: false },
    createOutputCallback(sfTracker),
    () => {}
  )
  await loadModelWeights(sfInstance, sfModelPath, SORTFORMER_MODEL_FILES)
  await sfInstance.activate()
  await sfInstance.append({ type: 'audio', data: audioData.buffer })
  await sfInstance.append({ type: 'end of job' })

  const sfTimeout = setTimeout(() => sfTracker.resolve(), 120000)
  await sfTracker.promise
  clearTimeout(sfTimeout)

  const diarization = sfTracker.transcriptions.map(s => s.text).join(' ').trim()
  await sfInstance.destroyInstance()

  const speakerSegments = parseSpeakerSegments(diarization)
  console.log(`   Found ${speakerSegments.length} segments:`)
  for (const seg of speakerSegments) {
    console.log(`     Speaker ${seg.speaker}: ${seg.start.toFixed(2)}s - ${seg.end.toFixed(2)}s`)
  }

  if (speakerSegments.length === 0) {
    console.log('\nNo speaker segments detected.')
    binding.releaseLogger()
    return
  }

  // Step 2: Load TDT once, transcribe each audio slice per speaker segment.
  // The C++ addon captures the callback at createInstance time, so we use a
  // mutable reference that the callback closes over to swap trackers per job.
  console.log('\n2. Loading transcription model (TDT)...')
  const activeTracker = { current: createJobTracker() }
  const tdtCallback = (handle, event, id, output, error) => {
    const tracker = activeTracker.current
    if (error) { console.error('Error:', error); return }
    if (event === 'Output' && output) {
      const segments = Array.isArray(output) ? output : [output]
      for (const seg of segments) {
        if (seg && seg.text && seg.toAppend) {
          tracker.transcriptions.push(seg)
        }
      }
      tracker.markOutput()
    }
    if (event === 'JobEnded') {
      tracker.markJobEnded()
    }
  }

  const tdtInstance = new ParakeetInterface(
    binding,
    { modelPath: tdtModelPath, modelType: 'tdt', maxThreads: 4, useGPU: false },
    tdtCallback,
    () => {}
  )
  await loadModelWeights(tdtInstance, tdtModelPath, TDT_MODEL_FILES)
  await tdtInstance.activate()

  console.log('\n3. Transcribing each speaker segment...\n')
  const results = []
  for (const seg of speakerSegments) {
    const slice = sliceAudio(audioData, seg.start, seg.end)
    if (!slice) {
      results.push({ speaker: seg.speaker, text: '[No speech detected]' })
      continue
    }

    activeTracker.current = createJobTracker()
    const tracker = activeTracker.current

    await tdtInstance.append({ type: 'audio', data: slice.buffer })
    await tdtInstance.append({ type: 'end of job' })

    const timeout = setTimeout(() => tracker.resolve(), 120000)
    await tracker.promise
    clearTimeout(timeout)

    const text = tracker.transcriptions.map(s => s.text).join(' ').trim()
    results.push({ speaker: seg.speaker, text: text || '[No speech detected]' })
    console.log(`   Speaker ${seg.speaker} (${seg.start.toFixed(2)}s-${seg.end.toFixed(2)}s): ${text || '[No speech detected]'}`)
  }

  await tdtInstance.destroyInstance()

  // Merge consecutive segments from the same speaker
  const merged = []
  for (const entry of results) {
    if (merged.length > 0 && merged[merged.length - 1].speaker === entry.speaker) {
      merged[merged.length - 1].text += ' ' + entry.text
    } else {
      merged.push({ ...entry })
    }
  }

  console.log('\n=== DIARIZED TRANSCRIPTION ===')
  console.log('='.repeat(60))
  for (const entry of merged) {
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
