'use strict'

/**
 * Unit tests for the parakeet duplex streaming API:
 *   - ASRGgml.runStreaming(audioStream, streamingConfig?) with engine "parakeet"
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
 *   - `appendStreamingAudio` resolves the boolean back-pressure signal
 *     the merged binding returns (false iff zero samples decoded);
 *   - `endStreaming` returns the { cleaned, audioDurationMs, totalSamples }
 *     teardown object and the JS layer synthesises a JobEnded from it so
 *     the wrapper's response chain (`response.onUpdate(...).await()`)
 *     resolves cleanly, which is the contract the live-mic example
 *     depends on;
 *   - a concurrent run()/runStreaming() during an open session rejects
 *     with the structured STREAMING_SESSION_ACTIVE error;
 *   - cancellation tears the session down via the existing
 *     `cancel(handle)` route the streaming-aware C++ shim wraps;
 *   - calling `appendStreamingAudio` without an active session
 *     throws via `ParakeetInterface`.
 *
 * For end-to-end coverage against a real GGUF, see
 * test/integration/parakeet-duplex-streaming.test.js.
 */

const test = require('brittle')
const ASRGgml = require('../../index.js')
const MockedBinding = require('../mocks/ParakeetMockedBinding.js')
const { wait } = require('../mocks/utils.js')
const { createParakeetModel, getAddon, getJob, pushable } = require('../mocks/createModel.js')

const process = require('bare-process')
global.process = process

function createMockedModel({ onOutput = () => {}, binding = undefined, parakeetConfig = {} } = {}) {
  const { model } = createParakeetModel({
    binding: binding || new MockedBinding(),
    onOutput,
    parakeetConfig: {
      streaming: true,
      streamingChunkMs: 2000,
      ...parakeetConfig
    }
  })
  return model
}

test('runStreaming before load does not activate a response', async (t) => {
  const model = createMockedModel()
  const unloadedStream = pushable()
  unloadedStream.end()

  await t.exception(
    () => model.runStreaming(unloadedStream),
    /not loaded/,
    'Pre-load streaming rejects before starting a response'
  )
  t.absent(getJob(model).active, 'No response remains active after rejection')

  await model.load()
  const loadedStream = pushable()
  const response = await model.runStreaming(loadedStream)
  loadedStream.end()
  await response.await()

  await model.unload()
})

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
    .onUpdate((items) => {
      for (const seg of Array.isArray(items) ? items : [items]) {
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

  const outputEvents = events.filter((e) => e.event === 'Output')
  t.is(outputEvents.length, 3, 'Three Output events for three pushed chunks')
  t.is(seenSegments.length, 3, 'onUpdate sees exactly three segments')
  t.is(
    seenSegments[0].text,
    'Mock streaming chunk 0',
    'First segment text comes from chunk index 0'
  )
  t.is(
    seenSegments[1].text,
    'Mock streaming chunk 1',
    'Second segment text comes from chunk index 1'
  )
  t.is(
    seenSegments[2].text,
    'Mock streaming chunk 2',
    'Third segment text comes from chunk index 2'
  )

  const jobEndedEvents = events.filter((e) => e.event === 'JobEnded')
  t.is(jobEndedEvents.length, 1, 'Exactly one synthetic JobEnded')
  t.ok(
    jobEndedEvents[0].output && typeof jobEndedEvents[0].output === 'object',
    'JobEnded payload is the runtime-stats object placeholder'
  )

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

test('runStreaming rejects unknown per-call streaming options', async (t) => {
  const model = createMockedModel()
  await model.load()

  const audioStream = pushable()
  audioStream.end()
  try {
    await model.runStreaming(audioStream, { emitVadEvents: true })
    t.fail('Whisper-vocabulary streaming option should be rejected for parakeet')
  } catch (error) {
    t.is(
      error.code,
      ASRGgml.ERR_CODES.INVALID_CONFIG,
      'Unknown streaming option rejects with INVALID_CONFIG'
    )
  }

  await model.unload()
})

test('appendStreamingAudio resolves the boolean back-pressure signal', async (t) => {
  const model = createMockedModel()
  await model.load()
  const addon = getAddon(model)

  await addon.startStreaming({ chunkMs: 2000 })

  const acceptedNonEmpty = await addon.appendStreamingAudio(new Float32Array(512))
  t.is(acceptedNonEmpty, true, 'Non-empty chunk resolves true')

  const acceptedEmpty = await addon.appendStreamingAudio(new Float32Array(0))
  t.is(acceptedEmpty, false, 'Zero-sample chunk resolves false (nothing decoded)')

  await addon.endStreaming()
  await addon.destroyInstance()
})

test('concurrent run() during an open streaming session rejects with STREAMING_SESSION_ACTIVE', async (t) => {
  const model = createMockedModel()
  await model.load()

  const audioStream = pushable()
  const response = await model.runStreaming(audioStream)

  try {
    await model.run(new Float32Array(256))
    t.fail('run() must not queue behind an open streaming session')
  } catch (error) {
    t.is(
      error.code,
      ASRGgml.ERR_CODES.STREAMING_SESSION_ACTIVE,
      'run() rejects with the structured STREAMING_SESSION_ACTIVE error'
    )
    t.is(
      error.constructor.name,
      'QvacErrorAddonASRGgml',
      'The rejection uses the unified error class'
    )
  }

  audioStream.end()
  await response.await()
  await model.unload()
})

test('appendStreamingAudio without an active session throws', async (t) => {
  const model = createMockedModel()
  await model.load()
  const addon = getAddon(model)

  const samples = new Float32Array(512)

  await t.exception(
    () => addon.appendStreamingAudio(samples),
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
  // `test/unit/parakeet-addon.test.js` and would deadlock without a
  // binding-side synthetic Error to unblock it -- noise we don't
  // need for the duplex-cleanup assertion.
  const model = createMockedModel()
  await model.load()
  const addon = getAddon(model)

  await addon.startStreaming({ chunkMs: 2000 })
  await addon.appendStreamingAudio(new Float32Array(1024))
  await wait()

  t.ok(model._mockedBinding._streamingActive, 'Streaming session active before cancel')

  model._mockedBinding.cancel(addon._handle)

  const log = model._mockedBinding._streamingLog
  t.is(log.starts, 1, 'startStreaming called once')
  t.is(log.appends, 1, 'appendStreamingAudio called once before cancel')
  t.is(log.cancels, 1, 'cancel invoked the streaming-aware tear-down once')
  t.absent(
    model._mockedBinding._streamingActive,
    'Mock binding flipped streamingActive=false after cancel'
  )

  // Bypass `model.unload()` because we cancelled at the binding
  // level (without firing a synthetic terminal event); the wrapper's
  // cancel-await dance has nothing to resolve. `destroyInstance` is
  // the framework-level escape hatch for that case.
  await addon.destroyInstance()
})

test('endStreaming on a binding with no active session is a no-op', async (t) => {
  const model = createMockedModel()
  await model.load()
  const addon = getAddon(model)

  // Drive the lower-level entry point directly -- this is what the
  // streaming-aware destroyInstance / cancel paths fall back to.
  // The C++ wrapper returns { cleaned, audioDurationMs, totalSamples }
  // so JS can populate the synthetic JobEnded payload with the audio
  // duration captured by the streaming processor; with no active
  // session, `cleaned` is false and the timing fields are zero.
  const result = model._mockedBinding.endStreaming(addon._handle)
  t.is(
    typeof result,
    'object',
    'Mock returns the same { cleaned, audioDurationMs, totalSamples } shape as the C++ wrapper'
  )
  t.is(result.cleaned, false, 'cleaned is false when no streaming session was active')
  t.is(result.audioDurationMs, 0, 'no session = no audio observed')
  t.is(result.totalSamples, 0, 'no session = no samples observed')

  await addon.destroyInstance()
})

test('endStreaming teardown object feeds the synthetic JobEnded payload', async (t) => {
  const events = []
  const model = createMockedModel({
    onOutput: (addon, event, jobId, output, error) => {
      events.push({ event, jobId, output, error })
    }
  })
  await model.load()

  const audioStream = pushable()
  const response = await model.runStreaming(audioStream, { chunkMs: 1000 })
  const updateDone = response.onUpdate(() => {}).await()
  audioStream.push(new Float32Array(1024))
  audioStream.push(new Float32Array(1024))
  audioStream.end()
  await updateDone
  await wait()

  const jobEnded = events.find((e) => e.event === 'JobEnded')
  t.ok(jobEnded, 'JobEnded synthesised on endStreaming')
  t.ok(
    typeof jobEnded.output.audioDurationMs === 'number' && jobEnded.output.audioDurationMs > 0,
    'Synthetic JobEnded carries the teardown audio duration'
  )
  t.ok(
    typeof jobEnded.output.totalSamples === 'number' && jobEnded.output.totalSamples > 0,
    'Synthetic JobEnded carries the teardown sample count'
  )

  await model.unload()
})
