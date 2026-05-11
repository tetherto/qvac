'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const process = require('bare-process')
const { Readable } = require('streamx')
const TranscriptionWhispercpp = require('../index.js')

/**
 * Example: Simulating live transcription with small audio chunks
 *
 * This example demonstrates how to simulate live transcription by:
 * 1. Reading a large .raw audio file
 * 2. Splitting it into small chunks (2-3 seconds)
 * 3. Sending chunks sequentially to the same job
 * 4. Maintaining state between chunks using whisper_full_with_state
 *
 * Usage: bare examples/example.live-transcription.js
 */

/**
 * Download model if not present
 */
async function downloadRealModel (url, filepath, minSize = 1000000) {
  if (fs.existsSync(filepath)) {
    const stats = fs.statSync(filepath)
    if (stats.size >= minSize) {
      console.log(`✓ Using cached model: ${filepath} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`)
      return { success: true, path: filepath }
    } else {
      console.log('✗ Cached file too small, re-downloading...')
      fs.unlinkSync(filepath)
    }
  }

  console.log(`⬇ Downloading model: ${filepath}...`)
  try {
    const { spawnSync } = require('bare-subprocess')
    const result = spawnSync('curl', [
      '-L', '-o', filepath, url,
      '--fail', '--silent', '--show-error',
      '--connect-timeout', '30',
      '--max-time', '300'
    ], { stdio: ['inherit', 'inherit', 'pipe'] })

    if (result.status === 0 && fs.existsSync(filepath)) {
      const stats = fs.statSync(filepath)
      if (stats.size >= minSize) {
        console.log(`✓ Downloaded model: ${filepath} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`)
        return { success: true, path: filepath }
      }
    }
  } catch (e) {
    console.error(`✗ Download error: ${e.message}`)
  }

  throw new Error('Failed to download model')
}

/**
 * Split audio buffer into small chunks for live transcription simulation
 */
function splitAudioIntoChunks (audioBuffer, chunkSizeSeconds, sampleRate, bytesPerSample) {
  const chunkSizeBytes = chunkSizeSeconds * sampleRate * bytesPerSample
  const chunks = []

  for (let offset = 0; offset < audioBuffer.length; offset += chunkSizeBytes) {
    const end = Math.min(offset + chunkSizeBytes, audioBuffer.length)
    chunks.push(audioBuffer.slice(offset, end))
  }

  return chunks
}

/**
 * Simulate live transcription by sending small audio chunks sequentially
 */
async function transcribeLiveStream (model, audioChunks, audioCtx) {
  const startTime = Date.now()

  const results = []
  let segmentCount = 0

  console.log(`\nSending ${audioChunks.length} chunks sequentially...\n`)

  const liveReadable = new Readable({
    read (cb) { cb(null) }
  })

  const response = await model.run(liveReadable)

  response.onUpdate((outputArr) => {
    const items = Array.isArray(outputArr) ? outputArr : [outputArr]
    results.push(...items)
    segmentCount += items.length

    const latestText = items.map(i => i.text).join(' ').trim()
    if (latestText) {
      process.stdout.write(`\r[${segmentCount} segments] Latest: ${latestText.substring(0, 60)}...`)
    }
  })

  const chunkDelayMs = 5
  for (let i = 0; i < audioChunks.length; i++) {
    const chunk = audioChunks[i]
    const view = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    liveReadable.push(view)

    if ((i + 1) % 25 === 0 || i === audioChunks.length - 1) {
      process.stdout.write(`\r[feed] sent ${i + 1}/${audioChunks.length} chunks`)
    }

    if (chunkDelayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, chunkDelayMs))
    }
  }
  liveReadable.push(null)

  process.stdout.write('\n')

  const timeout = setTimeout(() => {
    console.log('\n⚠️  Warning: Timeout waiting for JobEnded event after 5 minutes')
    console.log(`Received ${segmentCount} segments total`)
    console.log('Forcing exit...')
    console.log('*** TIMEOUT TRIGGERED - ABOUT TO CALL process.exit(0) ***')
    process.exit(0)
  }, 300000)

  try {
    await response.await()
    clearTimeout(timeout)
    console.log('✓ Job completed successfully')
  } catch (err) {
    clearTimeout(timeout)
    console.error('Error waiting for job:', err)
    throw err
  }

  process.stdout.write('\n')
  const processingTime = Date.now() - startTime
  return { results, processingTime }
}

async function main () {
  const modelsDir = path.join(__dirname, '..', 'models')
  const modelPath = path.join(modelsDir, 'ggml-tiny.bin')
  const audioPath = path.join(__dirname, 'samples', '10min-16k-s16le.raw')

  console.log('=== Live Transcription Simulation Example ===\n')

  // Download model if needed
  const whisperUrls = ['https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin']
  for (const url of whisperUrls) {
    try {
      await downloadRealModel(url, modelPath, 30000000)
      break
    } catch (e) {
      console.log(`Failed to download from ${url}`)
    }
  }

  if (!fs.existsSync(audioPath)) {
    console.error(`Audio file not found at ${audioPath}`)
    process.exit(1)
  }

  const constructorArgs = {
    files: {
      model: modelPath
    }
  }

  const config = {
    path: modelPath,
    whisperConfig: {
      language: 'en',
      audio_format: 's16le',
      temperature: 0.0,
      suppress_nst: true,
      audio_ctx: 1500
    }
  }

  const model = new TranscriptionWhispercpp(constructorArgs, config)
  await model._load()

  const audioStats = fs.statSync(audioPath)

  // Calculate audio duration and chunks
  const WHISPER_SAMPLE_RATE = 16000
  const BYTES_PER_SAMPLE = 2
  const totalDurationSeconds = (audioStats.size / BYTES_PER_SAMPLE) / WHISPER_SAMPLE_RATE
  const CHUNK_SIZE_SECONDS = 3
  const audioCtx = 1500

  console.log(`Audio file: ${audioPath}`)
  console.log(`File size: ${(audioStats.size / 1024 / 1024).toFixed(2)} MB`)
  console.log(`Duration: ${totalDurationSeconds.toFixed(1)}s (~${(totalDurationSeconds / 60).toFixed(1)} minutes)`)
  console.log(`Chunk size: ${CHUNK_SIZE_SECONDS}s`)
  console.log(`Audio context: ${audioCtx}ms`)
  console.log(`Model: ${modelPath}\n`)

  console.log('Reading audio file into memory...')
  const fullAudioBuffer = fs.readFileSync(audioPath)

  console.log('Splitting audio into chunks...')
  const audioChunks = splitAudioIntoChunks(
    fullAudioBuffer,
    CHUNK_SIZE_SECONDS,
    WHISPER_SAMPLE_RATE,
    BYTES_PER_SAMPLE
  )

  console.log(`Created ${audioChunks.length} chunks of ~${CHUNK_SIZE_SECONDS}s each\n`)

  const { results, processingTime } = await transcribeLiveStream(
    model,
    audioChunks,
    audioCtx
  )

  console.log('\n=== RESULTS ===')
  console.log(`Total segments: ${results.length}`)
  console.log(`Total chunks processed: ${audioChunks.length}`)
  console.log(`Processing time: ${(processingTime / 1000).toFixed(1)}s`)
  console.log(`Duration processed: ${totalDurationSeconds.toFixed(1)}s`)

  // Build full transcription
  const fullTranscription = results
    .map(s => s.text.trim())
    .filter(t => t.length > 0)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()

  console.log(`\nTranscription length: ${fullTranscription.length} characters`)

  if (fullTranscription.length > 0) {
    console.log('\n=== FULL TRANSCRIPTION ===')
    console.log(fullTranscription)
    console.log('=== END FULL TRANSCRIPTION ===\n')
  } else {
    console.log('No transcription output received.')
  }

  await model.destroy()
}

main().catch(err => {
  console.error('Error:', err)
  console.error(err.stack)
  process.exit(1)
})
