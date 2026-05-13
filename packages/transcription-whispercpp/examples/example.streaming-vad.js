'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const process = require('bare-process')
const TranscriptionWhispercpp = require('../index.js')
const binding = require('../binding.js')

const LOG_PRIORITIES = ['ERROR', 'WARNING', 'INFO', 'DEBUG']
binding.setLogger((priority, message) => {
  const priorityName = LOG_PRIORITIES[priority] || `UNKNOWN(${priority})`
  console.log(`[C++ ${priorityName}] ${message}`)
})

/**
 * Example: Streaming VAD transcription
 *
 * Demonstrates the runStreaming() API which uses Silero VAD to automatically
 * detect speech boundaries and transcribe each segment independently.
 *
 * Unlike the batch model.run() path, runStreaming() feeds audio continuously
 * and receives per-segment transcriptions as they are detected by the VAD.
 *
 * The audio source is a standard readable stream (fs.createReadStream here,
 * but could be a microphone, network socket, or any other byte source).
 *
 * Usage: bare examples/example.streaming-vad.js [audioPath] [modelPath] [vadModelPath]
 */

async function main () {
  const args = process.argv.slice(2)
  const modelsDir = path.join(__dirname, '..', 'models')
  const audioFilePath = args[0] || path.join(__dirname, 'samples', 'sample.raw')
  const modelPath = args[1] || path.join(modelsDir, 'ggml-tiny.bin')
  const vadModelPath = args[2] || path.join(modelsDir, 'ggml-silero-v5.1.2.bin')

  if (!fs.existsSync(modelPath)) {
    console.error(`Model file not found at ${modelPath}`)
    process.exit(1)
  }
  if (!fs.existsSync(audioFilePath)) {
    console.error(`Audio file not found at ${audioFilePath}`)
    process.exit(1)
  }
  if (!fs.existsSync(vadModelPath)) {
    console.error(`VAD model not found at ${vadModelPath}`)
    process.exit(1)
  }

  console.log('=== Streaming VAD Transcription Example ===\n')
  console.log(`Model:     ${modelPath}`)
  console.log(`VAD Model: ${vadModelPath}`)
  console.log(`Audio:     ${audioFilePath}\n`)

  const model = new TranscriptionWhispercpp(
    {
      files: {
        model: modelPath,
        vadModel: vadModelPath
      }
    },
    {
      whisperConfig: {
        language: 'en',
        audio_format: 's16le',
        temperature: 0.0,
        suppress_nst: true,
        vad_params: {
          threshold: 0.5,
          min_silence_duration_ms: 500,
          min_speech_duration_ms: 250,
          max_speech_duration_s: 30,
          speech_pad_ms: 30,
          samples_overlap: 0.1
        }
      },
      vadModelPath
    }
  )

  await model._load()

  const SAMPLE_RATE = 16000
  const BYTES_PER_SAMPLE = 2
  const BYTES_PER_SECOND = SAMPLE_RATE * BYTES_PER_SAMPLE

  const audioStream = fs.createReadStream(audioFilePath, {
    highWaterMark: BYTES_PER_SECOND
  })

  const { size: fileSize } = fs.statSync(audioFilePath)
  const totalDurationS = (fileSize / BYTES_PER_SAMPLE) / SAMPLE_RATE
  console.log(`Audio duration: ${totalDurationS.toFixed(1)}s\n`)

  const segments = []
  let segmentCount = 0
  const startTime = Date.now()

  const response = await model.runStreaming(audioStream)

  response.onUpdate((data) => {
    const items = Array.isArray(data) ? data : [data]
    for (const item of items) {
      segmentCount++
      segments.push(item)
      const text = (item.text || '').trim()
      if (text) {
        console.log(`[segment ${segmentCount}] [${item.start.toFixed(1)}s - ${item.end.toFixed(1)}s] ${text}`)
      }
    }
  })

  try {
    await response.await()
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
    console.log('\n=== RESULTS ===')
    console.log(`Segments: ${segments.length}`)
    console.log(`Processing time: ${elapsed}s`)
    console.log(`Audio duration: ${totalDurationS.toFixed(1)}s`)

    const fullText = segments
      .map(s => (s.text || '').trim())
      .filter(t => t.length > 0)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()

    if (fullText) {
      console.log('\n=== TRANSCRIPTION ===')
      console.log(fullText)
      console.log('=== END ===\n')
    } else {
      console.log('No transcription output received.')
    }
  } catch (err) {
    console.error('Streaming transcription failed:', err.message)
  }

  await model.destroy()
  binding.releaseLogger()
}

main().catch(err => {
  console.error(err)
  binding.releaseLogger()
  process.exit(1)
})
