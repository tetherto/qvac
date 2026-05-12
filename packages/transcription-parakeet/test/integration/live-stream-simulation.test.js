'use strict'

/**
 * Chunked-input simulation tests for the OFFLINE `run()` path.
 *
 * Despite the file name, this suite does NOT exercise the duplex
 * `runStreaming()` API -- for that, see
 * `test/integration/duplex-streaming.test.js`. What it validates is
 * that `TranscriptionParakeet.run(asyncIterable)` accepts arbitrary
 * chunk sizes / cadences without choking on the chunking itself
 * (the addon framework batches every appended chunk into a single
 * job before invoking the C++ `process()` once -- see
 * `ParakeetModel.cpp` for the JS-batches-then-C++-runs comment).
 *
 * If you're looking for evidence that the engine emits segments
 * incrementally as audio is fed, that's the duplex API; this suite
 * only covers the chunk-size invariance of the batched path.
 */

const test = require('brittle')
const fs = require('bare-fs')
const path = require('bare-path')
const {
  binding,
  TranscriptionParakeet,
  detectPlatform,
  setupJsLogger,
  getTestPaths,
  loadGgufOrSkip,
  isMobile
} = require('./helpers.js')

const platform = detectPlatform()
const { modelPath, samplesDir } = getTestPaths()

function loadAudio (samplePath) {
  const rawBuffer = fs.readFileSync(samplePath)
  const pcmData = new Int16Array(rawBuffer.buffer, rawBuffer.byteOffset, rawBuffer.length / 2)
  const audioData = new Float32Array(pcmData.length)
  for (let i = 0; i < pcmData.length; i++) audioData[i] = pcmData[i] / 32768.0
  return audioData
}

/**
 * Pushable async-iterable: producers `push(chunk)` / `end()`,
 * consumers `for await (const c of stream)`.
 */
function pushableStream () {
  const queue = []
  let waiter = null
  let ended = false
  function push (chunk) {
    if (ended) return
    queue.push(chunk)
    if (waiter) { const w = waiter; waiter = null; w() }
  }
  function end () {
    ended = true
    if (waiter) { const w = waiter; waiter = null; w() }
  }
  return {
    push,
    end,
    async * [Symbol.asyncIterator] () {
      while (true) {
        if (queue.length > 0) { yield queue.shift(); continue }
        if (ended) return
        await new Promise(resolve => { waiter = resolve })
      }
    }
  }
}

/**
 * Run streaming inference on `audioData` by chunking it and pushing
 * each chunk through a `pushableStream`. Returns
 * `{ chunksFed, totalSamplesFed, segments, firstUpdateTime,
 *    feedDurationMs }`.
 */
async function streamAudio (model, audioData, chunkDurationMs, delayMs) {
  const sampleRate = 16000
  const samplesPerChunk = Math.floor((chunkDurationMs / 1000) * sampleRate)
  const totalChunks = Math.ceil(audioData.length / samplesPerChunk)
  const stream = pushableStream()
  const segments = []
  let firstUpdateTime = null
  const startTime = Date.now()

  const runPromise = (async () => {
    const response = await model.run(stream)
    await response
      .onUpdate(out => {
        if (firstUpdateTime === null) firstUpdateTime = Date.now()
        const items = Array.isArray(out) ? out : [out]
        for (const seg of items) {
          if (seg && seg.text) {
            const txt = seg.text
            console.log(`[onUpdate] segment: "${txt.substring(0, 60)}${txt.length > 60 ? '...' : ''}"`)
            segments.push(seg)
          }
        }
      })
      .await()
  })()

  let chunksFed = 0
  let totalSamplesFed = 0
  for (let i = 0; i < audioData.length; i += samplesPerChunk) {
    const endIdx = Math.min(i + samplesPerChunk, audioData.length)
    const chunk = audioData.slice(i, endIdx)
    stream.push(new Float32Array(chunk))
    chunksFed++
    totalSamplesFed += chunk.length
    if (delayMs > 0 && i + samplesPerChunk < audioData.length) {
      await new Promise(resolve => setTimeout(resolve, delayMs))
    }
  }
  stream.end()

  const feedDurationMs = Date.now() - startTime
  await runPromise
  return { chunksFed, totalSamplesFed, totalChunks, segments, firstUpdateTime, feedDurationMs }
}

test('Live stream simulation: chunked audio feeding', { timeout: 300000 }, async (t) => {
  const loggerBinding = setupJsLogger(binding)

  console.log('\n' + '='.repeat(60))
  console.log('LIVE STREAM SIMULATION TEST')
  console.log('='.repeat(60))
  console.log(` Platform: ${platform}`)
  console.log(` Model path: ${modelPath}`)
  console.log(` Mobile: ${isMobile}`)
  console.log('='.repeat(60) + '\n')

  const stagedGguf = await loadGgufOrSkip(t)
  if (!stagedGguf) return

  const samplePath = path.join(samplesDir, 'sample.raw')
  if (!fs.existsSync(samplePath)) {
    loggerBinding.releaseLogger()
    t.pass('Test skipped - sample audio not found')
    return
  }

  const audioData = loadAudio(samplePath)
  const audioDuration = audioData.length / 16000
  console.log(`Audio file: ${path.basename(samplePath)}`)
  console.log(`Audio duration: ${audioDuration.toFixed(2)}s`)
  console.log(`Total samples: ${audioData.length}\n`)

  const model = new TranscriptionParakeet({
    files: { model: stagedGguf },
    config: { parakeetConfig: { maxThreads: 4, useGPU: false } }
  })
  try {
    await model.load()
    console.log('Model activated, starting live stream simulation...\n')

    const { chunksFed, totalSamplesFed, segments, firstUpdateTime, feedDurationMs } =
      await streamAudio(model, audioData, 500, 10)

    console.log('\n' + '='.repeat(60))
    console.log('📊 LIVE STREAM RESULTS')
    console.log('='.repeat(60))
    console.log('\n  Feed statistics:')
    console.log(`    Chunks fed: ${chunksFed}`)
    console.log(`    Total samples: ${totalSamplesFed}`)
    console.log(`    Feed duration: ${feedDurationMs}ms`)
    console.log('\n  Timing:')
    if (firstUpdateTime) {
      console.log('    Time to first update (from feed start): see [onUpdate] log lines above')
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

    t.ok(chunksFed > 0, 'Should have fed chunks (chunksFed > 0)')
    t.ok(totalSamplesFed > 0, 'Should have fed samples (totalSamplesFed > 0)')
    t.ok(segments.length > 0, 'Should receive transcription segments')
  } finally {
    try { await model.unload() } catch (e) { /* ignore */ }
    try { loggerBinding.releaseLogger() } catch (e) { /* ignore */ }
  }
})

test('Rapid chunk feeding: stress test with no delay', { timeout: 300000 }, async (t) => {
  const loggerBinding = setupJsLogger(binding)

  console.log('\n' + '='.repeat(60))
  console.log('RAPID CHUNK FEEDING TEST')
  console.log('Feeding audio chunks as fast as possible (no delay)')
  console.log('='.repeat(60) + '\n')

  const stagedGguf = await loadGgufOrSkip(t)
  if (!stagedGguf) return

  const samplePath = path.join(samplesDir, 'sample.raw')
  if (!fs.existsSync(samplePath)) {
    loggerBinding.releaseLogger()
    t.pass('Test skipped - sample audio not found')
    return
  }

  const audioData = loadAudio(samplePath)
  const model = new TranscriptionParakeet({
    files: { model: stagedGguf },
    config: { parakeetConfig: { maxThreads: 4, useGPU: false } }
  })
  try {
    await model.load()

    console.log('Feeding audio rapidly (100ms chunks, no delay)...')
    const { chunksFed, totalSamplesFed, segments, feedDurationMs } =
      await streamAudio(model, audioData, 100, 0)

    console.log('\n' + '='.repeat(60))
    console.log('📊 RAPID FEED RESULTS')
    console.log('='.repeat(60))
    console.log(`  Chunks fed: ${chunksFed}`)
    console.log(`  Feed time: ${feedDurationMs}ms`)
    console.log(`  Throughput: ${(totalSamplesFed / (feedDurationMs / 1000)).toFixed(0)} samples/sec`)
    console.log(`  Segments: ${segments.length}`)
    console.log('='.repeat(60) + '\n')

    t.ok(chunksFed > 10, 'Should have fed many chunks (rapid feeding)')
    t.ok(segments.length > 0, 'Should produce transcription despite rapid feeding')
  } finally {
    try { await model.unload() } catch (e) { /* ignore */ }
    try { loggerBinding.releaseLogger() } catch (e) { /* ignore */ }
  }
})

test('Variable chunk sizes: small to large chunks', { timeout: 300000 }, async (t) => {
  const loggerBinding = setupJsLogger(binding)

  console.log('\n' + '='.repeat(60))
  console.log('VARIABLE CHUNK SIZE TEST')
  console.log('Testing with different chunk sizes')
  console.log('='.repeat(60) + '\n')

  const stagedGguf = await loadGgufOrSkip(t)
  if (!stagedGguf) return

  const samplePath = path.join(samplesDir, 'sample.raw')
  if (!fs.existsSync(samplePath)) {
    loggerBinding.releaseLogger()
    t.pass('Test skipped - sample audio not found')
    return
  }

  const audioData = loadAudio(samplePath)
  const CHUNK_SIZES_MS = [100, 500, 1000, 2000]
  const results = []

  for (const chunkSizeMs of CHUNK_SIZES_MS) {
    console.log(`\n--- Testing ${chunkSizeMs}ms chunks ---`)
    const model = new TranscriptionParakeet({
      files: { model: stagedGguf },
      config: { parakeetConfig: { maxThreads: 4, useGPU: false } }
    })
    try {
      await model.load()
      const { chunksFed, segments, feedDurationMs } =
        await streamAudio(model, audioData, chunkSizeMs, 0)
      const fullText = segments.map(s => s.text).join(' ').trim()
      results.push({
        chunkSizeMs,
        chunksFed,
        feedTime: feedDurationMs,
        segments: segments.length,
        textLength: fullText.length
      })
      console.log(`  Chunks: ${chunksFed}, Time: ${feedDurationMs}ms, Segments: ${segments.length}`)
    } finally {
      try { await model.unload() } catch (e) { /* ignore */ }
    }
  }

  console.log('\n' + '='.repeat(60))
  console.log('📊 VARIABLE CHUNK SIZE SUMMARY')
  console.log('='.repeat(60))
  for (const result of results) {
    console.log(`  ${result.chunkSizeMs}ms chunks: ${result.chunksFed} chunks, ${result.feedTime}ms, ${result.segments} segments`)
  }
  console.log('='.repeat(60) + '\n')

  t.ok(results.length === CHUNK_SIZES_MS.length, 'Should test all chunk sizes')
  t.ok(results.every(r => r.segments > 0), 'All chunk sizes should produce output')

  try { loggerBinding.releaseLogger() } catch (e) { /* ignore */ }
})
