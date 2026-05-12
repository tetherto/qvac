'use strict'

/**
 * Unit tests for the duplex streaming API:
 *   - TranscriptionParakeet.runStreaming(audioStream, streamingConfig?)
 *   - ParakeetInterface.{startStreaming, appendStreamingAudio,
 *                       endStreaming, cancelStreaming}
 *
 * These tests are mock-binding driven (no native dependency) and
 * exercise the JS plumbing only -- they verify that:
 *
 *   - opening a session, pushing chunks, and closing it round-trips
 *     through to the binding's `startStreaming` /
 *     `appendStreamingAudio` / `endStreaming` calls without
 *     buffering the input the way the batched `run()` path does;
 *   - each pushed chunk surfaces one `Output` event through the
 *     wrapper's `onUpdate(...)` channel (incremental, not batched);
 *   - `endStreaming` synthesises a JobEnded event in JS so the
 *     wrapper's response chain (`response.onUpdate(...).await()`)
 *     resolves cleanly, which is the contract the live-mic example
 *     depends on (see parakeet.js -> async endStreaming);
 *   - cancellation tears the session down via the existing
 *     `cancel(handle)` route the streaming-aware C++ shim wraps;
 *   - calling `appendStreamingAudio` without an active session
 *     throws via `ParakeetInterface`.
 *
 * For end-to-end coverage against a real GGUF, see
 * test/integration/duplex-streaming.test.js.
 */

const test = require('brittle')
const TranscriptionParakeet = require('../../index.js')
const MockedBinding = require('../mocks/MockedBinding.js')
const { transitionCb, wait } = require('../mocks/utils.js')
const { ParakeetInterface } = require('../../parakeet')

const process = require('bare-process')
global.process = process
const sinon = require('sinon')

function createMockedModel ({
  onOutput = () => {},
  binding = undefined,
  parakeetConfig = {}
} = {}) {
  TranscriptionParakeet.prototype.validateModelFiles?.restore?.()
  const validateStub = sinon
    .stub(TranscriptionParakeet.prototype, 'validateModelFiles')
    .returns(undefined)

  const model = new TranscriptionParakeet({
    files: { model: './models/parakeet-tdt-0.6b-v3.q8_0.gguf' },
    config: {
      parakeetConfig: {
        streaming: true,
        streamingChunkMs: 2000,
        ...parakeetConfig
      }
    }
  })

  const _binding = binding || new MockedBinding()

  sinon.stub(model, '_createAddon').callsFake(configurationParams => {
    const addon = new ParakeetInterface(
      _binding,
      configurationParams,
      (addon, event, jobId, output, error) => {
        model._outputCallback(addon, event, jobId, output, error)
        onOutput(addon, event, jobId, output, error)
      },
      transitionCb
    )
    return addon
  })

  model._validateStub = validateStub
  model._mockedBinding = _binding
  return model
}

function pushable () {
  const queue = []
  let waiter = null
  let ended = false
  return {
    push (chunk) {
      if (ended) return
      queue.push(chunk)
      if (waiter) {
        const w = waiter
        waiter = null
        w()
      }
    },
    end () {
      ended = true
      if (waiter) {
        const w = waiter
        waiter = null
        w()
      }
    },
    async * [Symbol.asyncIterator] () {
      while (true) {
        if (queue.length > 0) {
          yield queue.shift()
          continue
        }
        if (ended) return
        await new Promise(resolve => { waiter = resolve })
      }
    }
  }
}

test('runStreaming surfaces one Output per pushed chunk and one JobEnded on close', async (t) => {
  const events = []
  const model = createMockedModel({
    onOutput: (addon, event, jobId, output, error) => {
      events.push({ event, jobId, output, error })
    }
  })
  await model.load()

  const audioStream = pushable()
  const response = await model.runStreaming(audioStream)

  // Attach `onUpdate` BEFORE pushing chunks: per-chunk Output events
  // fire on the next tick after each `appendStreamingAudio`, so a
  // handler that's attached after the pushes would miss any update
  // that fired before it landed in the response chain.
  const seenSegments = []
  const updateDone = response
    .onUpdate(items => {
      for (const seg of (Array.isArray(items) ? items : [items])) {
        seenSegments.push(seg)
      }
    })
    .await()

  audioStream.push(new Float32Array(1024))
  audioStream.push(new Float32Array(1024))
  audioStream.push(new Float32Array(1024))
  audioStream.end()

  await updateDone
  await wait()

  const outputEvents = events.filter(e => e.event === 'Output')
  t.is(outputEvents.length, 3, 'Three Output events for three pushed chunks')
  t.is(seenSegments.length, 3, 'onUpdate sees exactly three segments')
  t.is(seenSegments[0].text, 'Mock streaming chunk 0',
    'First segment text comes from chunk index 0')
  t.is(seenSegments[1].text, 'Mock streaming chunk 1',
    'Second segment text comes from chunk index 1')
  t.is(seenSegments[2].text, 'Mock streaming chunk 2',
    'Third segment text comes from chunk index 2')

  const jobEndedEvents = events.filter(e => e.event === 'JobEnded')
  t.is(jobEndedEvents.length, 1, 'Exactly one synthetic JobEnded')
  t.ok(jobEndedEvents[0].output && typeof jobEndedEvents[0].output === 'object',
    'JobEnded payload is the runtime-stats object placeholder')

  const log = model._mockedBinding._streamingLog
  t.is(log.starts, 1, 'startStreaming called once')
  t.is(log.appends, 3, 'appendStreamingAudio called once per pushed chunk')
  t.is(log.ends, 1, 'endStreaming called once on stream close')
  t.is(log.cancels, 0, 'No cancellations on the happy path')

  await model.unload()
})

test('runStreaming forwards per-call streamingConfig overrides to the binding', async (t) => {
  const model = createMockedModel()
  await model.load()

  const audioStream = pushable()
  const response = await model.runStreaming(audioStream, {
    chunkMs: 1500,
    rightLookaheadMs: 500
  })
  const updateDone = response.onUpdate(() => {}).await()
  audioStream.push(new Float32Array(512))
  audioStream.end()
  await updateDone

  const lastConfig = model._mockedBinding._streamingLog.lastConfig
  t.ok(lastConfig, 'Mock recorded the streamingConfig from startStreaming')
  t.is(lastConfig.chunkMs, 1500, 'chunkMs override was forwarded')
  t.is(lastConfig.rightLookaheadMs, 500, 'rightLookaheadMs override was forwarded')

  await model.unload()
})

test('appendStreamingAudio without an active session throws', async (t) => {
  const model = createMockedModel()
  await model.load()

  const samples = new Float32Array(512)

  await t.exception(
    () => model.addon.appendStreamingAudio(samples),
    /No active streaming session/,
    'Throws when no startStreaming has been issued yet'
  )

  await model.unload()
})

test('cancel after startStreaming tears down the session at the binding layer', async (t) => {
  // This exercises the C++ `cancelWithStreaming` wrapper's contract
  // at the binding level: a `cancel(handle)` call on an instance
  // with an active streaming session must (a) tear the session down
  // and (b) bump the cancellations log. We drive the lower-level
  // `addon.startStreaming` / `addon.appendStreamingAudio` directly
  // because the wrapper's cancel goes through the response-chain
  // promise dance (`_onCancelComplete`) which is already covered by
  // `test/unit/addon.test.js` and would deadlock without a
  // binding-side synthetic Error to unblock it -- noise we don't
  // need for the duplex-cleanup assertion.
  const model = createMockedModel()
  await model.load()

  await model.addon.startStreaming({ chunkMs: 2000 })
  await model.addon.appendStreamingAudio(new Float32Array(1024))
  await wait()

  t.ok(model._mockedBinding._streamingActive,
    'Streaming session active before cancel')

  model._mockedBinding.cancel(model.addon._handle)

  const log = model._mockedBinding._streamingLog
  t.is(log.starts, 1, 'startStreaming called once')
  t.is(log.appends, 1, 'appendStreamingAudio called once before cancel')
  t.is(log.cancels, 1, 'cancel invoked the streaming-aware tear-down once')
  t.absent(model._mockedBinding._streamingActive,
    'Mock binding flipped streamingActive=false after cancel')

  // Bypass `model.unload()` because we cancelled at the binding
  // level (without firing a synthetic terminal event); the wrapper's
  // cancel-await dance has nothing to resolve. `destroyInstance` is
  // the framework-level escape hatch for that case.
  await model.addon.destroyInstance()
})

test('endStreaming on a binding with no active session is a no-op', async (t) => {
  const model = createMockedModel()
  await model.load()

  // Drive the lower-level entry point directly -- this is what the
  // streaming-aware destroyInstance / cancel paths fall back to.
  // The C++ wrapper now returns { cleaned, audioDurationMs, totalSamples }
  // so JS can populate the synthetic JobEnded payload with the audio
  // duration captured by ParakeetStreamingProcessor; with no active
  // session, `cleaned` is false and the timing fields are zero.
  const result = model._mockedBinding.endStreaming(model.addon._handle)
  t.is(typeof result, 'object',
    'Mock returns the same { cleaned, audioDurationMs, totalSamples } shape as the C++ wrapper')
  t.is(result.cleaned, false,
    'cleaned is false when no streaming session was active')
  t.is(result.audioDurationMs, 0, 'no session = no audio observed')
  t.is(result.totalSamples, 0, 'no session = no samples observed')

  await model.addon.destroyInstance()
})
