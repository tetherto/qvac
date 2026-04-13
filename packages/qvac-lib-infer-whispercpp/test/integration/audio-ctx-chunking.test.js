'use strict'
const fs = require('bare-fs')
const path = require('bare-path')
const test = require('brittle')
const TranscriptionWhispercpp = require('../../index.js')
const { ensureWhisperModel, getTestPaths, createAudioStream, isMobile } = require('./helpers.js')

async function transcribeChunk (model, audioStream, offsetMs, durationMs, audioCtx) {
  await model.reload({
    whisperConfig: {
      offset_ms: offsetMs,
      duration_ms: durationMs,
      audio_ctx: audioCtx
    }
  })

  // audioStream is provided by caller to avoid reading the whole file inside this function

  const response = await model.run(audioStream)

  const results = []
  response.onUpdate((outputArr) => {
    const items = Array.isArray(outputArr) ? outputArr : [outputArr]
    results.push(...items)
  })

  await response.await()

  return results
}

const { modelPath } = getTestPaths()

// Skip on mobile - requires 10min audio file (~19MB) which is too large to bundle
test('Audio context chunking - 10 minute audio file with 30s chunks', { skip: isMobile }, async (t) => {
  // Increase timeout as we process ~30 chunks from disk with model reloads
  t.timeout(180000)
  console.log('\n=== Audio Context Chunking Integration Test ===\n')

  // Ensure whisper model is available
  const whisperResult = await ensureWhisperModel(modelPath)

  if (!whisperResult.success && !whisperResult.isReal) {
    console.log('Whisper model not available - skipping audio chunking test')
    t.pass('Audio chunking test skipped (model not available)')
    return
  }

  // Check if 10-minute test audio file exists
  const audioFile = path.resolve(__dirname, '../../examples/samples/10min-16k-s16le.raw')

  if (!fs.existsSync(audioFile)) {
    console.log(`Test audio file not found: ${audioFile}`)
    t.pass('Audio chunking test skipped (10min-16k-s16le.raw not found)')
    return
  }

  // Get file size
  const stats = fs.statSync(audioFile)
  const fileSizeBytes = stats.size
  const WHISPER_SAMPLE_RATE = 16000
  const BYTES_PER_SAMPLE = 2 // s16le = 2 bytes per sample
  const totalDurationSeconds = (fileSizeBytes / BYTES_PER_SAMPLE) / WHISPER_SAMPLE_RATE

  console.log(`Audio file: ${path.basename(audioFile)}`)
  console.log(`File size: ${(fileSizeBytes / 1024 / 1024).toFixed(2)} MB`)
  console.log(`Duration: ${totalDurationSeconds.toFixed(1)}s (~${(totalDurationSeconds / 60).toFixed(1)} minutes)`)
  console.log(`Model: ${path.basename(modelPath)}\n`)

  // Configuration
  const CHUNK_SIZE_SECONDS = 30
  const totalChunks = Math.ceil(totalDurationSeconds / CHUNK_SIZE_SECONDS)

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
      suppress_nst: true
    }
  }

  let model
  try {
    model = new TranscriptionWhispercpp(constructorArgs, config)
    await model._load()

    console.log('Reading full audio file into memory...')
    const fullAudioBuffer = fs.readFileSync(audioFile)

    console.log(`Processing ${totalChunks} chunks of ${CHUNK_SIZE_SECONDS}s each...\n`)
    const allResults = []
    let errorCount = 0
    let chunksWithSegments = 0

    // Process each chunk - always pass full audio, only change offset_ms, duration_ms, audio_ctx
    let currentOffsetSeconds = 0
    for (let i = 0; i < totalChunks; i++) {
      const chunkDuration = Math.min(CHUNK_SIZE_SECONDS, totalDurationSeconds - currentOffsetSeconds)
      const audioCtx = i === 0 ? 0 : Math.min(Math.floor(50 * chunkDuration + 1), 1500)

      console.log(`[${i + 1}/${totalChunks}] offset=${currentOffsetSeconds.toFixed(1)}s duration=${chunkDuration.toFixed(1)}s audio_ctx=${audioCtx}`)

      const fullAudioStream = createAudioStream(fullAudioBuffer)

      let results = []
      try {
        results = await transcribeChunk(
          model,
          fullAudioStream,
          currentOffsetSeconds * 1000,
          chunkDuration * 1000,
          audioCtx
        )
      } catch (err) {
        errorCount++
        console.error(`Chunk ${i + 1} failed:`, err)
      }

      currentOffsetSeconds += chunkDuration

      if (results.length > 0) {
        const text = results.map(s => s.text).join(' ').replace(/\s+/g, ' ').trim()
        console.log(`  → ${text}\n`)
        allResults.push(...results)
        chunksWithSegments++
      } else {
        console.log('  → [no output]\n')
      }
    }

    console.log('\n=== RESULTS ===')
    console.log(`Total segments: ${allResults.length}`)
    console.log(`Total chunks processed: ${totalChunks}`)
    console.log(`Chunks with segments: ${chunksWithSegments}`)
    console.log(`Chunk errors: ${errorCount}`)
    console.log(`Duration processed: ${totalDurationSeconds.toFixed(1)}s`)

    // Assertions
    t.ok(allResults.length > 0, 'Should produce transcription segments')
    t.is(chunksWithSegments, totalChunks, 'Should transcribe exactly totalChunks chunks')
    t.is(errorCount, 0, 'No chunk errors or exceptions')

    // Verify segments have required properties
    if (allResults.length > 0) {
      const firstSegment = allResults[0]
      t.ok(firstSegment.text, 'Segments should have text')
      t.ok(typeof firstSegment.start === 'number', 'Segments should have start time')
      t.ok(typeof firstSegment.end === 'number', 'Segments should have end time')
    }

    // Build full transcription
    const fullTranscription = allResults
      .map(s => s.text.trim())
      .filter(text => text.length > 0)
      .join(' ')

    console.log(`\nTranscription length: ${fullTranscription.length} characters`)

    if (fullTranscription.length > 0) {
      console.log('\n=== FULL TRANSCRIPTION (test) ===')
      console.log(fullTranscription)
      console.log('=== END FULL TRANSCRIPTION ===\n')
    }

    t.ok(fullTranscription.length > 0, 'Should produce non-empty transcription')

    console.log('✅ Audio context chunking test completed successfully!\n')
  } catch (error) {
    console.error('Test failed with error:', error)
    t.fail(error.message)
  } finally {
    if (model) {
      await model.destroy()
    }
  }
})
