'use strict'

/**
 * EOU streaming integration test.
 *
 * The EOU 120m model is a streaming end-of-utterance detector that
 * doubles as a small ASR head. Its `streaming: true` session emits
 * per-chunk transcript segments; when the chunk contains an `<EOU>`
 * token, the segment's `isEndOfTurn` flag is set (see
 * ParakeetModel.cpp's stream_start callback). The text field still
 * carries any speech decoded in the same chunk, so the boundary
 * signal is independent of the transcript content.
 *
 * This test guards three regressions at once:
 *
 *   1. Joint-network correctness. ggml-metal's Q-variant
 *      mul_mv + ADD(bias) [+ ADD(residual)] fusion empirically
 *      produces zero tokens on the EOU q8_0 joint network; the
 *      offline CTC / TDT / Sortformer paths stay correct under the
 *      same fusion. Asserting non-empty transcript text catches that
 *      case directly without needing a Metal-only runner.
 *
 *   2. Streaming session lifecycle. The EOU streaming code path
 *      (asr_session_ + pending_streaming_segments_ + the chunked
 *      `feed_pcm_f32` cadence) only runs when `streaming: true` is
 *      set; the `addon-multimodel` desktop test runs EOU offline, so
 *      a streaming-only regression would not surface there.
 *
 *   3. End-of-turn boundary signal. Asserts at least one segment
 *      carries `isEndOfTurn === true` on a finalized clip: the EOU
 *      detector should fire on the trailing `<EOU>` token after the
 *      last sentence's terminal punctuation. A regression that
 *      breaks the `<EOU>` token id lookup, the joint-network's
 *      argmax-best path, or the JS-side flag propagation would set
 *      this count to zero.
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

async function streamEou (model, audioData) {
  const samplesPerChunk = Math.floor((FEED_CHUNK_MS / 1000) * SAMPLE_RATE)
  const stream = pushableStream()
  const segments = []

  const runPromise = (async () => {
    const response = await model.run(stream)
    await response
      .onUpdate(out => {
        const items = Array.isArray(out) ? out : [out]
        for (const seg of items) {
          if (seg && seg.text) segments.push(seg)
        }
      })
      .await()
  })()

  for (let i = 0; i < audioData.length; i += samplesPerChunk) {
    const endIdx = Math.min(i + samplesPerChunk, audioData.length)
    const chunk = new Float32Array(audioData.slice(i, endIdx))
    stream.push(chunk)
    if (i + samplesPerChunk < audioData.length) {
      await new Promise(resolve => setTimeout(resolve, FEED_CHUNK_MS))
    }
  }
  stream.end()
  await runPromise

  return segments
}

test('EOU streaming — emits transcript segments and end-of-turn boundaries', { timeout: 600000 }, async (t) => {
  const loggerBinding = setupJsLogger(binding)

  try {
    const modelPath = await loadGgufOrSkip(t, 'eou')
    if (!modelPath) return

    const audio = loadAudioSample()
    if (!audio) {
      t.pass('sample.raw not found - skipping')
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

      console.log(`[eou/streaming] audio duration: ${(audio.length / SAMPLE_RATE).toFixed(2)}s`)
      console.log(`[eou/streaming] feed chunk: ${FEED_CHUNK_MS}ms; session chunk: ${STREAM_CHUNK_MS}ms`)

      const segments = await streamEou(model, audio)

      const eotSegments = segments.filter(s => s.isEndOfTurn === true)
      const transcript = segments.map(s => s.text).join(' ').trim()

      console.log(`[eou/streaming] segments=${segments.length} eotSegments=${eotSegments.length} chars=${transcript.length}`)
      console.log(`[eou/streaming] result: "${transcript.substring(0, 150)}${transcript.length > 150 ? '...' : ''}"`)

      t.ok(segments.length > 0,
        `EOU streaming should emit at least one segment (got ${segments.length})`)
      t.ok(transcript.length > 0,
        `EOU streaming transcript should be non-empty (got ${transcript.length} chars)`)
      t.ok(eotSegments.length > 0,
        `EOU streaming should mark at least one end-of-turn boundary on a finalized clip (got ${eotSegments.length})`)
    } finally {
      try { await model.unload() } catch (e) { /* ignore */ }
    }
  } finally {
    try { loggerBinding.releaseLogger() } catch (e) { /* ignore */ }
  }
})
