'use strict'

/**
 * Live Stream Simulation Tests
 *
 * These tests simulate real-time audio streaming by:
 * 1. Reading audio files and chunking them
 * 2. Feeding chunks at a controlled rate (simulating microphone input)
 * 3. Verifying the model can handle streaming input
 */

const test = require('brittle')
const fs = require('bare-fs')
const path = require('bare-path')
const binding = require('../../binding')
const { ParakeetInterface } = require('../../parakeet')
const {
  detectPlatform,
  setupJsLogger,
  getTestPaths,
  ensureModel,
  getNamedPathsConfig,
  isMobile
} = require('./helpers.js')

const platform = detectPlatform()
const { modelPath, samplesDir } = getTestPaths()

/**
 * Feed audio chunks at a simulated rate
 * @param {ParakeetInterface} parakeet - The model interface
 * @param {Float32Array} audioData - Full audio data
 * @param {number} chunkDurationMs - Duration of each chunk in milliseconds
 * @param {number} delayMs - Delay between chunks in milliseconds (0 = as fast as possible)
 * @returns {Promise<Object>} Stats about the feeding process
 */
async function feedAudioChunked (parakeet, audioData, chunkDurationMs = 500, delayMs = 10) {
  const sampleRate = 16000
  const samplesPerChunk = Math.floor((chunkDurationMs / 1000) * sampleRate)
  const totalChunks = Math.ceil(audioData.length / samplesPerChunk)

  let chunksFed = 0
  let totalSamplesFed = 0

  for (let i = 0; i < audioData.length; i += samplesPerChunk) {
    const endIdx = Math.min(i + samplesPerChunk, audioData.length)
    const chunk = audioData.slice(i, endIdx)

    // Convert to ArrayBuffer for the append call
    const chunkBuffer = new Float32Array(chunk).buffer

    await parakeet.append({ type: 'audio', data: chunkBuffer })

    chunksFed++
    totalSamplesFed += chunk.length

    console.log(`[feed] chunk #${chunksFed}/${totalChunks} samples=${chunk.length} total=${totalSamplesFed}`)

    // Simulate real-time delay between chunks
    if (delayMs > 0 && i + samplesPerChunk < audioData.length) {
      await new Promise(resolve => setTimeout(resolve, delayMs))
    }
  }

  return { chunksFed, totalSamplesFed, totalChunks }
}

/**
 * Test live stream simulation - feed audio in small chunks
 */
test('Live stream simulation: chunked audio feeding', { timeout: 300000 }, async (t) => {
  const loggerBinding = setupJsLogger(binding)

  console.log('\n' + '='.repeat(60))
  console.log('LIVE STREAM SIMULATION TEST')
  console.log('='.repeat(60))
  console.log(` Platform: ${platform}`)
  console.log(` Model path: ${modelPath}`)
  console.log(` Mobile: ${isMobile}`)
  console.log('='.repeat(60) + '\n')

  // Ensure model is available
  await ensureModel(modelPath)

  // Check sample audio exists
  const samplePath = path.join(samplesDir, 'sample.raw')
  if (!fs.existsSync(samplePath)) {
    loggerBinding.releaseLogger()
    t.pass('Test skipped - sample audio not found')
    return
  }

  // Load audio
  const rawBuffer = fs.readFileSync(samplePath)
  const pcmData = new Int16Array(rawBuffer.buffer, rawBuffer.byteOffset, rawBuffer.length / 2)
  const audioData = new Float32Array(pcmData.length)
  for (let i = 0; i < pcmData.length; i++) {
    audioData[i] = pcmData[i] / 32768.0
  }

  const audioDuration = audioData.length / 16000
  console.log(`Audio file: ${path.basename(samplePath)}`)
  console.log(`Audio duration: ${audioDuration.toFixed(2)}s`)
  console.log(`Total samples: ${audioData.length}\n`)

  // Configuration
  const config = {
    modelPath,
    modelType: 'tdt',
    maxThreads: 4,
    useGPU: false,
    sampleRate: 16000,
    channels: 1,
    ...getNamedPathsConfig('tdt', modelPath)
  }

  // Track results
  const segments = []
  let firstUpdateTime = null
  const feedStartTime = Date.now()
  let outputResolve = null
  const outputPromise = new Promise(resolve => { outputResolve = resolve })

  function outputCallback (handle, event, id, output, error) {
    if (event === 'Output' && Array.isArray(output)) {
      if (firstUpdateTime === null) {
        firstUpdateTime = Date.now()
      }
      for (const segment of output) {
        if (segment && segment.text) {
          const txt = segment.text
          console.log(`[onUpdate] segment: "${txt.substring(0, 60)}${txt.length > 60 ? '...' : ''}"`)
          segments.push(segment)
        }
      }
    }
    if ((event === 'JobEnded' || event === 'Error') && outputResolve) {
      if (event === 'Error') {
        console.log(`[error] ${error}`)
      }
      outputResolve()
      outputResolve = null
    }
  }

  let parakeet = null

  try {
    parakeet = new ParakeetInterface(binding, config, outputCallback)

    await parakeet.activate()
    console.log('Model activated, starting live stream simulation...\n')

    // Feed audio in chunks (500ms chunks, 10ms delay between)
    const CHUNK_DURATION_MS = 500
    const DELAY_BETWEEN_CHUNKS_MS = 10

    const feedStats = await feedAudioChunked(
      parakeet,
      audioData,
      CHUNK_DURATION_MS,
      DELAY_BETWEEN_CHUNKS_MS
    )

    // Signal end of stream
    console.log('\n[feed] Sending end of job signal...')
    await parakeet.append({ type: 'end of job' })

    const feedEndTime = Date.now()

    // Wait for output with timeout
    const timeout = setTimeout(() => { if (outputResolve) { outputResolve(); outputResolve = null } }, 600000)
    await outputPromise
    clearTimeout(timeout)

    // Timing analysis
    const totalFeedTime = feedEndTime - feedStartTime
    const timeToFirstUpdate = firstUpdateTime ? firstUpdateTime - feedStartTime : null

    console.log('\n' + '='.repeat(60))
    console.log('📊 LIVE STREAM RESULTS')
    console.log('='.repeat(60))
    console.log('\n  Feed statistics:')
    console.log(`    Chunks fed: ${feedStats.chunksFed}`)
    console.log(`    Total samples: ${feedStats.totalSamplesFed}`)
    console.log(`    Feed duration: ${totalFeedTime}ms`)

    console.log('\n  Timing:')
    if (timeToFirstUpdate) {
      console.log(`    Time to first update: ${timeToFirstUpdate}ms`)
      console.log(`    First update vs feed end: ${firstUpdateTime - feedEndTime}ms`)
    } else {
      console.log('    No updates received during/after feed')
    }

    console.log('\n  Output:')
    console.log(`    Segments received: ${segments.length}`)
    if (segments.length > 0) {
      const fullText = segments.map(s => s.text).join(' ').trim()
      console.log(`    Full text: "${fullText.substring(0, 100)}${fullText.length > 100 ? '...' : ''}"`)
    }

    console.log('='.repeat(60) + '\n')

    // Assertions
    t.ok(feedStats.chunksFed > 0, 'Should have fed chunks (chunksFed > 0)')
    t.ok(feedStats.totalSamplesFed > 0, 'Should have fed samples (totalSamplesFed > 0)')
    t.ok(segments.length > 0, 'Should receive transcription segments')

    console.log('✅ Live stream simulation completed successfully!\n')
  } finally {
    if (parakeet) {
      try {
        await parakeet.destroyInstance()
      } catch (e) {
        // Ignore
      }
    }
    try {
      loggerBinding.releaseLogger()
    } catch (e) {
      // Ignore
    }
  }
})

/**
 * Test rapid chunk feeding - feed as fast as possible
 */
test('Rapid chunk feeding: stress test with no delay', { timeout: 300000 }, async (t) => {
  const loggerBinding = setupJsLogger(binding)

  console.log('\n' + '='.repeat(60))
  console.log('RAPID CHUNK FEEDING TEST')
  console.log('Feeding audio chunks as fast as possible (no delay)')
  console.log('='.repeat(60) + '\n')

  // Ensure model is available
  await ensureModel(modelPath)

  // Check sample audio exists
  const samplePath = path.join(samplesDir, 'sample.raw')
  if (!fs.existsSync(samplePath)) {
    loggerBinding.releaseLogger()
    t.pass('Test skipped - sample audio not found')
    return
  }

  // Load audio
  const rawBuffer = fs.readFileSync(samplePath)
  const pcmData = new Int16Array(rawBuffer.buffer, rawBuffer.byteOffset, rawBuffer.length / 2)
  const audioData = new Float32Array(pcmData.length)
  for (let i = 0; i < pcmData.length; i++) {
    audioData[i] = pcmData[i] / 32768.0
  }

  // Configuration
  const config = {
    modelPath,
    modelType: 'tdt',
    maxThreads: 4,
    useGPU: false,
    sampleRate: 16000,
    channels: 1,
    ...getNamedPathsConfig('tdt', modelPath)
  }

  // Track results
  const segments = []
  let outputResolve = null
  const outputPromise = new Promise(resolve => { outputResolve = resolve })

  function outputCallback (handle, event, id, output, error) {
    if (event === 'Output' && Array.isArray(output)) {
      for (const segment of output) {
        if (segment && segment.text) {
          segments.push(segment)
        }
      }
    }
    if ((event === 'JobEnded' || event === 'Error') && outputResolve) {
      outputResolve()
      outputResolve = null
    }
  }

  let parakeet = null

  try {
    parakeet = new ParakeetInterface(binding, config, outputCallback)

    await parakeet.activate()

    // Feed audio in small chunks with NO delay (stress test)
    const CHUNK_DURATION_MS = 100 // 100ms chunks = smaller, more chunks
    const DELAY_BETWEEN_CHUNKS_MS = 0 // No delay

    console.log('Feeding audio rapidly (100ms chunks, no delay)...')
    const startTime = Date.now()

    const feedStats = await feedAudioChunked(
      parakeet,
      audioData,
      CHUNK_DURATION_MS,
      DELAY_BETWEEN_CHUNKS_MS
    )

    await parakeet.append({ type: 'end of job' })

    const feedTime = Date.now() - startTime

    // Wait for output
    const timeout = setTimeout(() => { if (outputResolve) { outputResolve(); outputResolve = null } }, 600000)
    await outputPromise
    clearTimeout(timeout)

    console.log('\n' + '='.repeat(60))
    console.log('📊 RAPID FEED RESULTS')
    console.log('='.repeat(60))
    console.log(`  Chunks fed: ${feedStats.chunksFed}`)
    console.log(`  Feed time: ${feedTime}ms`)
    console.log(`  Throughput: ${(feedStats.totalSamplesFed / (feedTime / 1000)).toFixed(0)} samples/sec`)
    console.log(`  Segments: ${segments.length}`)
    console.log('='.repeat(60) + '\n')

    t.ok(feedStats.chunksFed > 10, 'Should have fed many chunks (rapid feeding)')
    t.ok(segments.length > 0, 'Should produce transcription despite rapid feeding')

    console.log('✅ Rapid chunk feeding test completed!\n')
  } finally {
    if (parakeet) {
      try {
        await parakeet.destroyInstance()
      } catch (e) {
        // Ignore
      }
    }
    try {
      loggerBinding.releaseLogger()
    } catch (e) {
      // Ignore
    }
  }
})

/**
 * Test chunked feeding with varying chunk sizes
 */
test('Variable chunk sizes: small to large chunks', { timeout: 300000 }, async (t) => {
  const loggerBinding = setupJsLogger(binding)

  console.log('\n' + '='.repeat(60))
  console.log('VARIABLE CHUNK SIZE TEST')
  console.log('Testing with different chunk sizes')
  console.log('='.repeat(60) + '\n')

  // Ensure model is available
  await ensureModel(modelPath)

  // Check sample audio exists
  const samplePath = path.join(samplesDir, 'sample.raw')
  if (!fs.existsSync(samplePath)) {
    loggerBinding.releaseLogger()
    t.pass('Test skipped - sample audio not found')
    return
  }

  // Load audio
  const rawBuffer = fs.readFileSync(samplePath)
  const pcmData = new Int16Array(rawBuffer.buffer, rawBuffer.byteOffset, rawBuffer.length / 2)
  const audioData = new Float32Array(pcmData.length)
  for (let i = 0; i < pcmData.length; i++) {
    audioData[i] = pcmData[i] / 32768.0
  }

  // Test different chunk sizes
  const CHUNK_SIZES_MS = [100, 500, 1000, 2000] // 100ms, 500ms, 1s, 2s chunks
  const results = []

  for (const chunkSizeMs of CHUNK_SIZES_MS) {
    console.log(`\n--- Testing ${chunkSizeMs}ms chunks ---`)

    const segments = []
    let outputResolve = null
    const outputPromise = new Promise(resolve => { outputResolve = resolve })

    function outputCallback (handle, event, id, output, error) {
      if (event === 'Output' && Array.isArray(output)) {
        for (const segment of output) {
          if (segment && segment.text) {
            segments.push(segment)
          }
        }
      }
      if ((event === 'JobEnded' || event === 'Error') && outputResolve) {
        outputResolve()
        outputResolve = null
      }
    }

    const config = {
      modelPath,
      modelType: 'tdt',
      maxThreads: 4,
      useGPU: false,
      sampleRate: 16000,
      channels: 1,
      ...getNamedPathsConfig('tdt', modelPath)
    }

    let parakeet = null

    try {
      parakeet = new ParakeetInterface(binding, config, outputCallback)

      await parakeet.activate()

      const startTime = Date.now()
      const feedStats = await feedAudioChunked(parakeet, audioData, chunkSizeMs, 0)
      await parakeet.append({ type: 'end of job' })
      const feedTime = Date.now() - startTime

      // Wait for output
      const timeout = setTimeout(() => { if (outputResolve) { outputResolve(); outputResolve = null } }, 600000)
      await outputPromise
      clearTimeout(timeout)

      const fullText = segments.map(s => s.text).join(' ').trim()

      results.push({
        chunkSizeMs,
        chunksFed: feedStats.chunksFed,
        feedTime,
        segments: segments.length,
        textLength: fullText.length
      })

      console.log(`  Chunks: ${feedStats.chunksFed}, Time: ${feedTime}ms, Segments: ${segments.length}`)
    } finally {
      if (parakeet) {
        try {
          await parakeet.destroyInstance()
        } catch (e) {
          // Ignore
        }
      }
    }
  }

  // Summary
  console.log('\n' + '='.repeat(60))
  console.log('📊 VARIABLE CHUNK SIZE SUMMARY')
  console.log('='.repeat(60))

  for (const result of results) {
    console.log(`  ${result.chunkSizeMs}ms chunks: ${result.chunksFed} chunks, ${result.feedTime}ms, ${result.segments} segments`)
  }

  console.log('='.repeat(60) + '\n')

  // Assertions
  t.ok(results.length === CHUNK_SIZES_MS.length, 'Should test all chunk sizes')
  t.ok(results.every(r => r.segments > 0), 'All chunk sizes should produce output')

  try {
    loggerBinding.releaseLogger()
  } catch (e) {
    // Ignore
  }

  console.log('✅ Variable chunk size test completed!\n')
})
