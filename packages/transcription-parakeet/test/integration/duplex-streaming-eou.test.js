'use strict'

/**
 * Duplex-streaming + EOU integration test.
 *
 * The existing `eou-streaming.test.js` covers `model.run()` (the
 * offline `runStreamingProcess_` path that calls `asr_session_->
 * finalize()` on every `process()` invocation). The existing
 * `duplex-streaming.test.js` covers `model.runStreaming()` (the
 * `ParakeetStreamingProcessor` duplex path) but only with the TDT
 * model — it does NOT assert `isEndOfTurn`.
 *
 * This test closes the gap: load the EOU model, drive it through the
 * duplex `runStreaming()` API end-to-end (the exact path
 * `@qvac/sdk`'s `transcribeStream({ parakeetStreamingConfig })` uses),
 * and assert that at least one segment carries
 * `isEndOfTurn === true`. A regression that fails to surface `<EOU>`
 * boundaries via the duplex path — for example because mid-stream
 * `feed_pcm_f32` calls don't reach `eou_decode_window` without a
 * `finalize()`, or because `ParakeetStreamingProcessor::onAsrSegment_`
 * drops the `is_eou_boundary` flag — would set the count to zero.
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
// Inter-utterance silence between the two concatenated copies of the
// speech sample. >= the streaming session's `right_lookahead_ms`
// (default 2000 ms) so the first copy's terminal chunk decodes
// mid-stream with the silence as trailing context -- that is when the
// EOU head fires its first `<EOU>` token, *before* `stream.end()`.
// The second copy's terminal `<EOU>` then surfaces during finalize as
// usual. 3 s gives a comfortable margin over the 2 s lookahead.
const INTER_UTTERANCE_SILENCE_MS = 3000

function loadAudioSample () {
  const samplePath = path.join(samplesDir, 'sample.raw')
  if (!fs.existsSync(samplePath)) return null
  const rawBuffer = fs.readFileSync(samplePath)
  const pcm = new Int16Array(rawBuffer.buffer, rawBuffer.byteOffset, rawBuffer.length / 2)
  const speech = new Float32Array(pcm.length)
  for (let i = 0; i < pcm.length; i++) speech[i] = pcm[i] / 32768.0

  // Speech | silence | speech. The mid-stream silence gives the EOU
  // head enough trailing context to decode the first utterance's
  // terminal chunk (and emit `<EOU>`) before `stream.end()` is
  // called; the second utterance's `<EOU>` arrives at finalize.
  const silenceSamples = Math.floor((INTER_UTTERANCE_SILENCE_MS / 1000) * SAMPLE_RATE)
  const audio = new Float32Array(speech.length * 2 + silenceSamples)
  audio.set(speech, 0)
  // Float32Array is zero-initialised, so the middle slice is already silence.
  audio.set(speech, speech.length + silenceSamples)
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

async function feedDuplex (model, audio) {
  const samplesPerChunk = Math.floor((FEED_CHUNK_MS / 1000) * SAMPLE_RATE)
  const stream = pushableStream()
  const segments = []
  const eotBeforeEnd = []
  let lastChunkPushedAt = null
  let endCalledAt = null

  const response = await model.runStreaming(stream)
  const updateDone = response
    .onUpdate(out => {
      const items = Array.isArray(out) ? out : [out]
      for (const seg of items) {
        if (!seg) continue
        segments.push(seg)
        // Bucket EOU events into "arrived before stream.end()" vs
        // "arrived during the finalize() flush". If the duplex path
        // only surfaces EOU at flush time, mid-stream consumers (live
        // mic) will see nothing — that's the SDK-side bug we're
        // trying to localise.
        if (seg.isEndOfTurn && endCalledAt === null) {
          eotBeforeEnd.push({ at: Date.now(), text: seg.text || '' })
        }
      }
    })
    .await()

  for (let i = 0; i < audio.length; i += samplesPerChunk) {
    const endIdx = Math.min(i + samplesPerChunk, audio.length)
    const chunk = new Float32Array(audio.slice(i, endIdx))
    stream.push(chunk)
    lastChunkPushedAt = Date.now()
    if (i + samplesPerChunk < audio.length) {
      await new Promise(resolve => setTimeout(resolve, FEED_CHUNK_MS))
    }
  }
  endCalledAt = Date.now()
  stream.end()
  await updateDone

  return { segments, eotBeforeEnd, lastChunkPushedAt, endCalledAt }
}

test('duplex runStreaming + EOU — emits isEndOfTurn boundaries from <EOU> tokens', { timeout: 600000 }, async (t) => {
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

      console.log(`[duplex-eou] audio duration: ${(audio.length / SAMPLE_RATE).toFixed(2)}s`)
      console.log(`[duplex-eou] feed chunk: ${FEED_CHUNK_MS}ms; session chunk: ${STREAM_CHUNK_MS}ms`)

      const { segments, eotBeforeEnd, lastChunkPushedAt, endCalledAt } =
        await feedDuplex(model, audio)

      const allEot = segments.filter(s => s.isEndOfTurn === true)
      const transcript = segments
        .filter(s => s.text)
        .map(s => s.text)
        .join(' ')
        .trim()

      console.log(`[duplex-eou] segments=${segments.length} chars=${transcript.length}`)
      console.log(`[duplex-eou] eot total=${allEot.length} before stream.end()=${eotBeforeEnd.length}`)
      console.log(`[duplex-eou] last push -> end gap: ${endCalledAt - lastChunkPushedAt}ms`)
      console.log(`[duplex-eou] transcript: "${transcript.substring(0, 200)}${transcript.length > 200 ? '...' : ''}"`)

      t.ok(segments.length > 0,
        `duplex runStreaming should emit at least one segment (got ${segments.length})`)
      t.ok(transcript.length > 0,
        `duplex runStreaming transcript should be non-empty (got ${transcript.length} chars)`)
      // Primary assertion: the duplex path must surface EOU boundaries.
      t.ok(allEot.length > 0,
        `duplex runStreaming should mark at least one end-of-turn boundary on the EOU model (got ${allEot.length})`)
      // Diagnostic: distinguishes "EOU only at finalize" (the SDK live
      // mic bug we suspect) from "EOU works mid-stream too".
      t.ok(eotBeforeEnd.length > 0,
        `duplex runStreaming should emit at least one EOU before stream.end() so live mic consumers see boundaries mid-stream (got ${eotBeforeEnd.length})`)
    } finally {
      try { await model.unload() } catch (e) { /* ignore */ }
    }
  } finally {
    try { loggerBinding.releaseLogger() } catch (e) { /* ignore */ }
  }
})
