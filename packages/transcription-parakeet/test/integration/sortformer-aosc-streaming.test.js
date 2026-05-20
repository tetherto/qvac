'use strict'

/**
 * Sortformer v2.1 + AOSC streaming integration test.
 *
 * Verifies that:
 *   1. The v2.1 Sortformer GGUF loads and the JS-side AOSC config
 *      knobs flow through the native binding without errors.
 *   2. A streaming diarization session with default AOSC config emits
 *      well-formed speaker segments matching the
 *      "Speaker N: HH:MM:SS.fff - HH:MM:SS.fff" pattern that the
 *      offline diarization path also produces.
 *   3. Forcing `streamingSpkCacheEnable: false` on the same v2.1 GGUF
 *      falls back to the v1 sliding-window path cleanly (still emits
 *      segments; just without the AOSC stability guarantees).
 *
 * The full AOSC slot-stability contract (same speaker -> same hyp_<id>
 * across non-contiguous re-entries) is verified at C++ level by
 * `parakeet-cpp/test/test_sortformer_aosc_speakers.cpp` using the
 * `abcba.wav` / `abcdba.wav` fixtures. This JS-level test focuses on
 * wiring correctness; if it passes, the AOSC knobs are reaching the
 * engine and parakeet-cpp's own regression tests cover the runtime
 * behaviour.
 *
 * Skips cleanly when the v2.1 GGUF is missing
 * (`MODEL_CONFIGS.sortformerStreaming`); the file isn't bundled with
 * the repo -- stage it via `npm run setup-models` or by pointing
 * `QVAC_TEST_GGUF_DIR` at a directory containing
 * `diar_streaming_sortformer_4spk-v2.1.q8_0.gguf`.
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
const STREAM_CHUNK_MS = 2000
const FEED_CHUNK_MS = 500

function loadAudioSample () {
  const samplePath = path.join(samplesDir, 'sample.raw')
  if (!fs.existsSync(samplePath)) return null
  const rawBuffer = fs.readFileSync(samplePath)
  const pcm = new Int16Array(
    rawBuffer.buffer, rawBuffer.byteOffset, rawBuffer.length / 2)
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

  const response = await model.runStreaming(stream)
  const updateDone = response
    .onUpdate(out => {
      const items = Array.isArray(out) ? out : [out]
      for (const seg of items) {
        if (!seg || !seg.text) continue
        segments.push(seg)
      }
    })
    .await()

  for (let i = 0; i < audio.length; i += samplesPerChunk) {
    const endIdx = Math.min(i + samplesPerChunk, audio.length)
    const chunk = new Float32Array(audio.slice(i, endIdx))
    stream.push(chunk)
    if (i + samplesPerChunk < audio.length) {
      await new Promise(resolve => setTimeout(resolve, FEED_CHUNK_MS))
    }
  }
  stream.end()
  await updateDone

  return segments
}

// Pull "Speaker N" out of the addon's emitted text. Returns -1 when
// the text doesn't match (e.g. silence sentinels). Mirrors the parser
// used by examples/live-mic-diarized.js so the assertion below stays
// in sync with the actual contract consumers rely on.
function parseSpeakerId (text) {
  const m = typeof text === 'string' ? text.match(/Speaker\s+(\d+)/) : null
  return m ? parseInt(m[1], 10) : -1
}

test('Sortformer v2.1 AOSC — default config streams diarization segments',
  { timeout: 600000 }, async (t) => {
    const loggerBinding = setupJsLogger(binding)

    try {
      const modelPath = await loadGgufOrSkip(t, 'sortformerStreaming')
      if (!modelPath) return

      const audio = loadAudioSample()
      if (!audio) { t.pass('sample.raw not found - skipping'); return }

      const model = new TranscriptionParakeet({
        files: { model: modelPath },
        config: {
          parakeetConfig: {
            streaming: true,
            streamingChunkMs: STREAM_CHUNK_MS,
            // streamingSpkCacheEnable defaults to true; left unset so
            // the AOSC default path runs as it would for real users.
            maxThreads: 4,
            useGPU: false
          }
        }
      })

      try {
        await model.load()
        const segments = await feedAndCollect(model, audio)

        t.ok(segments.length > 0,
          `AOSC streaming should emit at least one segment (got ${segments.length})`)

        const speakerIds = segments
          .map(s => parseSpeakerId(s.text))
          .filter(id => id >= 0)
        t.ok(speakerIds.length > 0,
          'segments should match the "Speaker N: ..." format')

        const distinctIds = new Set(speakerIds)
        console.log(
          `[aosc/default] segments=${segments.length} ` +
          `speakers=${distinctIds.size} ids=[${[...distinctIds].sort().join(',')}]`)
      } finally {
        try { await model.unload() } catch (e) { /* ignore */ }
      }
    } finally {
      try { loggerBinding.releaseLogger() } catch (e) { /* ignore */ }
    }
  })

test('Sortformer v2.1 AOSC — streamingSpkCacheEnable=false falls back to v1 path',
  { timeout: 600000 }, async (t) => {
    const loggerBinding = setupJsLogger(binding)

    try {
      const modelPath = await loadGgufOrSkip(t, 'sortformerStreaming')
      if (!modelPath) return

      const audio = loadAudioSample()
      if (!audio) { t.pass('sample.raw not found - skipping'); return }

      const model = new TranscriptionParakeet({
        files: { model: modelPath },
        config: {
          parakeetConfig: {
            streaming: true,
            streamingChunkMs: STREAM_CHUNK_MS,
            // Force the v1 sliding-window code path on the v2.1 GGUF.
            // The engine must accept this without errors and continue
            // to emit speaker segments; speaker IDs may drift in ways
            // they would not with AOSC active.
            streamingSpkCacheEnable: false,
            maxThreads: 4,
            useGPU: false
          }
        }
      })

      try {
        await model.load()
        const segments = await feedAndCollect(model, audio)

        t.ok(segments.length > 0,
          'v1-path streaming should still emit at least one segment ' +
          `(got ${segments.length})`)

        const speakerIds = segments
          .map(s => parseSpeakerId(s.text))
          .filter(id => id >= 0)
        t.ok(speakerIds.length > 0,
          'segments should match the "Speaker N: ..." format')

        console.log(`[aosc/disabled] segments=${segments.length}`)
      } finally {
        try { await model.unload() } catch (e) { /* ignore */ }
      }
    } finally {
      try { loggerBinding.releaseLogger() } catch (e) { /* ignore */ }
    }
  })
