'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const process = require('bare-process')
const TranscriptionWhispercpp = require('../index.js')
const FakeDL = require('../test/mocks/loader.fake.js')

/**
 * Example: Testing audio_ctx with duration_ms
 *
 * This example demonstrates how to use reload() to set duration_ms
 * and process only a specific portion of audio.
 *
 * Usage: bare examples/example.audio-ctx-chunking.js
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
 * Transcribe audio with specific offset, duration and audio_ctx
 */
async function transcribeChunk (model, audioStream, offsetMs, durationMs, audioCtx) {
  await model.reload({
    whisperConfig: {
      offset_ms: offsetMs,
      duration_ms: durationMs,
      audio_ctx: audioCtx
    }
  })
  // audioStream is provided by caller
  const response = await model.run(audioStream)

  const results = []
  response.onUpdate((outputArr) => {
    const items = Array.isArray(outputArr) ? outputArr : [outputArr]
    results.push(...items)
  })

  await response.await()
  return results
}

function createFullAudioStream (audioBuffer) {
  const { Readable } = require('streamx')
  return new Readable({
    read (cb) {
      this.push(audioBuffer)
      this.push(null)
      cb(null)
    }
  })
}

async function main () {
  const modelsDir = path.join(__dirname, '..', 'models')
  const modelPath = path.join(modelsDir, 'ggml-tiny.bin')
  const audioPath = path.join(__dirname, 'samples', '10min-16k-s16le.raw')

  console.log('=== Audio_ctx Chunking Example ===\n')

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
    modelName: 'ggml-tiny.bin',
    loader: new FakeDL({}),
    diskPath: modelsDir
  }

  const config = {
    whisperConfig: {
      language: 'en',
      audio_format: 's16le',
      temperature: 0.0,
      suppress_nst: true,
      n_threads: 8
    }
  }

  const model = new TranscriptionWhispercpp(constructorArgs, config)
  await model._load()

  const audioStats = fs.statSync(audioPath)
  const fullAudioBuffer = fs.readFileSync(audioPath)

  // Calculate audio duration and chunks
  const WHISPER_SAMPLE_RATE = 16000
  const BYTES_PER_SAMPLE = 2
  const totalDurationSeconds = (audioStats.size / BYTES_PER_SAMPLE) / WHISPER_SAMPLE_RATE
  const CHUNK_SIZE_SECONDS = 30
  const chunksToProcess = Math.ceil(totalDurationSeconds / CHUNK_SIZE_SECONDS)

  console.log(`Audio: ${totalDurationSeconds.toFixed(1)}s, Chunks: ${chunksToProcess} x ${CHUNK_SIZE_SECONDS}s`)
  console.log('Processing all chunks\n')

  const allResults = []
  let totalProcessingTime = 0

  for (let i = 0; i < chunksToProcess; i++) {
    const offsetSeconds = i * CHUNK_SIZE_SECONDS
    const chunkDuration = Math.min(CHUNK_SIZE_SECONDS, totalDurationSeconds - offsetSeconds)
    const audioCtx = i === 0 ? 0 : Math.min(Math.floor(50 * chunkDuration + 1), 1500)

    console.log(`[${i + 1}/${chunksToProcess}] offset=${offsetSeconds.toFixed(1)}s duration=${chunkDuration.toFixed(1)}s audio_ctx=${audioCtx}`)

    const audioStream = createFullAudioStream(fullAudioBuffer)
    const startTime = Date.now()
    const results = await transcribeChunk(
      model,
      audioStream,
      offsetSeconds * 1000,
      chunkDuration * 1000,
      audioCtx
    )

    totalProcessingTime += Date.now() - startTime

    if (results.length > 0) {
      const text = results.map(s => s.text).join(' ').replace(/\s+/g, ' ').trim()
      console.log(`  → ${text}\n`)
      allResults.push(...results)
    } else {
      console.log('  → [no output]\n')
    }
  }

  console.log(`Processing completed: ${(totalProcessingTime / 1000).toFixed(1)}s, ${allResults.length} segments`)

  const fullText = allResults.map(s => s.text).join(' ').replace(/\s+/g, ' ').trim()
  if (fullText.length) {
    console.log('\n=== FULL TRANSCRIPTION ===')
    console.log(fullText)
    console.log('==============================================\n')
  } else {
    console.log('No transcription output received.')
  }

  console.log('\n=== ALL CHUNKS COMPLETED ===\n')

  await model.destroy()
}

main().catch(err => {
  console.error('Error:', err)
  console.error(err.stack)
  process.exit(1)
})
