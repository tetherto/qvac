'use strict'

/**
 * Duplex-streaming integration test (`runStreaming`).
 *
 * Exercises the new high-level `TranscriptionParakeet.runStreaming()`
 * entry point against a real Parakeet GGUF. The duplex API differs
 * from `run()` in that:
 *
 *   - `appendStreamingAudio` chunks bypass the addon framework's
 *     append-buffer-then-process lifecycle and reach the C++
 *     `parakeet::StreamSession` immediately;
 *   - per-chunk segments surface through `response.onUpdate(...)`
 *     as the engine emits them, with stable session state across
 *     chunks (rolling encoder context, EOU detector, Sortformer
 *     history all preserved);
 *   - `endStreaming` synthesises a JobEnded event in JS so the
 *     wrapper response chain (`onUpdate(...).await()`) resolves
 *     when the input iterable completes.
 *
 * Coverage:
 *
 *   1. Non-empty transcript text on a finalized clip -- proves the
 *      duplex feed reaches the engine and the addon's binding wire-up
 *      works end-to-end.
 *   2. At least one segment arrives BEFORE the input is exhausted --
 *      proves the duplex path is genuinely streaming-out (the
 *      offline `run()` path cannot satisfy this since it batches
 *      everything in JS until end-of-input).
 *   3. The response settles cleanly after `endStreaming` -- proves
 *      the JS-side synthetic JobEnded path actually resolves the
 *      response chain.
 *
 * Skips cleanly when no GGUF is available (matching the rest of the
 * integration suite). Uses the TDT model by default because it gives
 * the most stable transcript text under streaming.
 */

const test = require('brittle')
const fs = require('bare-fs')
const path = require('bare-path')
const {
  binding,
  TranscriptionParakeet,
  setupJsLogger,
  getTestPaths,
  loadGgufOrSkip
} = require('./helpers.js')

const { samplesDir } = getTestPaths()

const SAMPLE_RATE = 16000
const STREAM_CHUNK_MS = 1000
const FEED_CHUNK_MS = 500

function loadAudioSample () {
  const samplePath = path.join(samplesDir, 'sample.raw')
  if (!fs.existsSync(samplePath)) return null
  const rawBuffer = fs.readFileSync(samplePath)
  const pcm = new Int16Array(rawBuffer.buffer, rawBuffer.byteOffset, rawBuffer.length / 2)
  const audio = new Float32Array(pcm.length)
  for (let i = 0; i < pcm.length; i++) audio[i] = pcm[i] / 32768.0
  return audio
}

function pushableStream () {
  const queue = []
  let waiter = null
  let ended = false
  return {
    push (chunk) {
      if (ended) return
      queue.push(chunk)
      if (waiter) { const w = waiter; waiter = null; w() }
    },
    end () {
      ended = true
      if (waiter) { const w = waiter; waiter = null; w() }
    },
    async * [Symbol.asyncIterator] () {
      while (true) {
        if (queue.length > 0) { yield queue.shift(); continue }
        if (ended) return
        await new Promise(resolve => { waiter = resolve })
      }
    }
  }
}

async function feedAndCollect (model, audio) {
  const samplesPerChunk = Math.floor((FEED_CHUNK_MS / 1000) * SAMPLE_RATE)
  const stream = pushableStream()
  const segments = []
  const updateTimestamps = []
  let firstSegmentTime = null
  let lastChunkPushedTime = null

  const response = await model.runStreaming(stream)
  const updateDone = response
    .onUpdate(out => {
      const items = Array.isArray(out) ? out : [out]
      for (const seg of items) {
        if (!seg || !seg.text) continue
        segments.push(seg)
        const now = Date.now()
        updateTimestamps.push(now)
        if (firstSegmentTime === null) firstSegmentTime = now
      }
    })
    .await()

  for (let i = 0; i < audio.length; i += samplesPerChunk) {
    const endIdx = Math.min(i + samplesPerChunk, audio.length)
    const chunk = new Float32Array(audio.slice(i, endIdx))
    stream.push(chunk)
    lastChunkPushedTime = Date.now()
    if (i + samplesPerChunk < audio.length) {
      await new Promise(resolve => setTimeout(resolve, FEED_CHUNK_MS))
    }
  }
  stream.end()
  await updateDone

  return { segments, firstSegmentTime, lastChunkPushedTime }
}

test('runStreaming — duplex feed surfaces transcripts incrementally and resolves cleanly', { timeout: 600000 }, async (t) => {
  const loggerBinding = setupJsLogger(binding)

  try {
    const modelPath = await loadGgufOrSkip(t, 'tdt')
    if (!modelPath) return

    const audio = loadAudioSample()
    if (!audio) {
      t.pass('sample.raw not found - skipping')
      return
    }

    const audioDurationMs = (audio.length / SAMPLE_RATE) * 1000
    if (audioDurationMs < 4000) {
      t.pass(`sample.raw is too short (${audioDurationMs.toFixed(0)} ms) for incremental streaming check - skipping`)
      return
    }

    const model = new TranscriptionParakeet({
      files: { model: modelPath },
      config: {
        parakeetConfig: {
          streaming: true,
          streamingChunkMs: STREAM_CHUNK_MS,
          maxThreads: 4,
          useGPU: false
        }
      }
    })

    try {
      await model.load()

      console.log(`[duplex/streaming] audio duration: ${(audioDurationMs / 1000).toFixed(2)}s`)
      console.log(`[duplex/streaming] feed chunk: ${FEED_CHUNK_MS}ms; session chunk: ${STREAM_CHUNK_MS}ms`)

      const startTime = Date.now()
      const { segments, firstSegmentTime, lastChunkPushedTime } = await feedAndCollect(model, audio)
      const totalElapsed = Date.now() - startTime

      const transcript = segments.map(s => s.text).join(' ').trim()

      console.log(`[duplex/streaming] segments=${segments.length} chars=${transcript.length}`)
      console.log(`[duplex/streaming] result: "${transcript.substring(0, 150)}${transcript.length > 150 ? '...' : ''}"`)
      if (firstSegmentTime !== null && lastChunkPushedTime !== null) {
        const firstSegmentLeadMs = lastChunkPushedTime - firstSegmentTime
        console.log(`[duplex/streaming] first segment arrived ${firstSegmentLeadMs}ms before last chunk was pushed (negative = arrived after last push)`)
      }
      console.log(`[duplex/streaming] total elapsed=${totalElapsed}ms`)

      t.ok(segments.length > 0,
        `runStreaming should emit at least one segment (got ${segments.length})`)
      t.ok(transcript.length > 0,
        `runStreaming transcript should be non-empty (got ${transcript.length} chars)`)

      // The duplex API guarantees at least one segment arrives before
      // the *last* chunk is pushed, given an audio clip longer than
      // (chunkMs + right_lookahead_ms). The offline `run()` path
      // cannot satisfy this -- it batches everything until
      // end-of-input -- so this assertion is what differentiates the
      // two execution paths in the integration suite.
      t.ok(firstSegmentTime !== null && lastChunkPushedTime !== null &&
           firstSegmentTime <= lastChunkPushedTime,
      'first segment should arrive at or before the last chunk is pushed (incremental streaming)')
    } finally {
      try { await model.unload() } catch (e) { /* ignore */ }
    }
  } finally {
    try { loggerBinding.releaseLogger() } catch (e) { /* ignore */ }
  }
})
