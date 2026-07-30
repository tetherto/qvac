'use strict'

// Unified exclusiveRun semantics (two independent queues, per-call release
// policy):
//   - run(): serialized TO COMPLETION for both engines (whisper's semantics;
//     a deliberate behavior change for parakeet).
//   - runStreaming(): the slot is held for session SETUP only — the queue is
//     released at session-open, never for the (potentially minutes-long)
//     session itself.
//   - reload()/unload()/destroy() run on a SEPARATE lifecycle queue: they
//     serialize against each other but pre-empt an in-flight run instead of
//     queueing behind it (both pre-merge packages behaved this way).
//   - open-session guard: run()/runStreaming() during an open streaming
//     session reject with STREAMING_SESSION_ACTIVE instead of queuing.
//   - exclusiveRun: false bypasses the inference queue entirely.

const test = require('brittle')
const ASRGgml = require('../../index.js')
const WhisperMockedBinding = require('../mocks/MockedBinding.js')
const ParakeetMockedBinding = require('../mocks/ParakeetMockedBinding.js')
const { wait } = require('../mocks/utils.js')
const { createWhisperModel, createParakeetModel, pushable } = require('../mocks/createModel.js')

const process = require('bare-process')
global.process = process

test('whisper: run() is serialized to completion under exclusiveRun', async (t) => {
  const binding = new WhisperMockedBinding()
  binding.setJobDelayMs(40)
  const { model } = createWhisperModel({ binding })
  await model.load()

  const r1 = await model.run(new Uint8Array([1, 2, 3, 4]))

  let secondStarted = false
  const p2 = model.run(new Uint8Array([5, 6, 7, 8])).then(async (r2) => {
    secondStarted = true
    await r2.await()
    return r2
  })

  await wait(10)
  t.ok(!secondStarted, 'Second run must not start while the first job is still active')

  await r1.await()
  await p2
  t.ok(secondStarted, 'Second run starts after the first response settles')

  await model.destroy()
})

test('parakeet: run() is serialized to completion under exclusiveRun', async (t) => {
  // Behavior change vs the standalone parakeet package: the slot used to
  // be released at submission; the unified queue holds it until the response
  // settles.
  const binding = new ParakeetMockedBinding()
  const { model } = createParakeetModel({ binding })
  await model.load()

  // Gate the first run's audio stream so its job stays open.
  const stream = pushable()
  const r1 = await model.run(stream)

  let secondStarted = false
  const p2 = model.run(new Float32Array(64)).then(async (r2) => {
    secondStarted = true
    await r2.await()
    return r2
  })

  await wait(20)
  t.ok(!secondStarted, 'Second run must wait for the first response to settle')

  stream.push(new Float32Array(64))
  stream.end()
  await r1.await()
  await p2
  t.ok(secondStarted, 'Second run starts after the first response settles')

  await model.destroy()
})

test('runStreaming holds the queue slot for setup only', async (t) => {
  const { model } = createWhisperModel()
  await model.load()

  let releaseStream
  const gate = new Promise((resolve) => {
    releaseStream = resolve
  })
  const openEndedStream = {
    async *[Symbol.asyncIterator]() {
      yield new Uint8Array([1, 2, 3, 4])
      await gate
    }
  }

  // If runStreaming held the slot to completion, this await would hang until
  // the stream ends. Session-open resolution means it resolves promptly.
  const response = await model.runStreaming(openEndedStream)
  t.ok(response, 'runStreaming resolves at session-open, before the stream ends')

  // The slot is free: lifecycle calls (always queued) proceed while the
  // session is open. cancel() tears the session down.
  await model.cancel()
  try {
    await response.await()
  } catch {
    // cancelled session: expected
  }

  releaseStream()
  await model.destroy()
})

test('open-session guard rejects concurrent work for both engines', async (t) => {
  for (const engine of ['whisper', 'parakeet']) {
    const { model } = engine === 'whisper' ? createWhisperModel() : createParakeetModel()
    await model.load()

    const stream = pushable()
    const session = await model.runStreaming(stream)

    for (const attempt of ['run', 'runStreaming']) {
      try {
        await model[attempt](
          engine === 'whisper' ? [new Uint8Array([1, 2, 3, 4])] : [new Float32Array(16)]
        )
        t.fail(`${engine}: concurrent ${attempt}() must be rejected`)
      } catch (error) {
        t.is(
          error.code,
          ASRGgml.ERR_CODES.STREAMING_SESSION_ACTIVE,
          `${engine}: ${attempt}() rejects with STREAMING_SESSION_ACTIVE`
        )
      }
    }

    stream.end()
    await session.await()
    await model.destroy()
  }
})

test('exclusiveRun: false bypasses the queue', async (t) => {
  const binding = new WhisperMockedBinding()
  binding.setJobDelayMs(40)
  const { model } = createWhisperModel({
    binding,
    options: { exclusiveRun: false }
  })
  await model.load()

  t.is(model.exclusiveRun, false, 'exclusiveRun option is exposed')

  const r1 = await model.run(new Uint8Array([1, 2, 3, 4]))
  // Without the queue the second submission goes straight through instead of
  // waiting for the first response to settle.
  const r2 = await model.run(new Uint8Array([5, 6, 7, 8]))
  t.ok(r2, 'Second run is accepted immediately without queuing')

  // The single-slot JobHandler is now the only guard: it fails the stale first
  // response as soon as the second job starts. This is the fallback the
  // open-session guard makes unreachable for the streaming-vs-run case.
  const settled = await Promise.allSettled([r1.await(), r2.await()])
  t.is(settled[0].status, 'rejected', 'The stale first response is failed by the JobHandler')
  t.ok(
    /Stale job replaced by new run/.test(String(settled[0].reason)),
    'Stale-job replacement is the reported reason'
  )
  // The native engine is still busy with the first job, so the second
  // submission is rejected by the addon rather than queued behind it — the
  // documented cost of opting out of exclusiveRun.
  t.is(settled[1].status, 'rejected', 'Overlapping runs are not serialized for the caller')

  await model.destroy()
})

test('destroy() pre-empts an in-flight batch run', async (t) => {
  // Teardown must NOT queue behind the running job: the whole point of the
  // `if (this._job.active) this._job.fail(...)` in destroy() is to abort it.
  const binding = new WhisperMockedBinding()
  const { model } = createWhisperModel({ binding })
  await model.load()

  // A gated stream keeps the batch job open for the duration of the test.
  const stream = pushable()
  stream.push(new Uint8Array([1, 2, 3, 4]))
  const response = await model.run(stream)

  await wait(10)
  const settled = response.await().then(
    () => 'resolved',
    (error) => String(error)
  )

  await model.destroy()
  t.ok(model.getState().destroyed, 'destroy() completes while the run is still in flight')
  t.ok(/destroyed/.test(await settled), 'the in-flight response is failed by destroy()')

  stream.end()
})

test('unload() pre-empts an in-flight batch run', async (t) => {
  const { model } = createWhisperModel()
  await model.load()

  const stream = pushable()
  stream.push(new Uint8Array([1, 2, 3, 4]))
  const response = await model.run(stream)
  await wait(10)
  const settled = response.await().then(
    () => 'resolved',
    (error) => String(error)
  )

  await model.unload()
  t.is(model.getState().weightsLoaded, false, 'unload() completes while the run is in flight')
  t.ok(/unloaded/.test(await settled), 'the in-flight response is failed by unload()')

  stream.end()
  await model.destroy()
})

test('teardown does not deadlock on a non-terminating audio iterable', async (t) => {
  // A live mic (or a stalled socket) fed into run() never appends
  // END_OF_INPUT, so the job never settles. With one shared queue, destroy()
  // waited on that settlement and hung forever.
  for (const engine of ['whisper', 'parakeet']) {
    const { model } = engine === 'whisper' ? createWhisperModel() : createParakeetModel()
    await model.load()

    let stalledForever = true
    const neverEnding = {
      async *[Symbol.asyncIterator]() {
        yield engine === 'whisper' ? new Uint8Array([1, 2, 3, 4]) : new Float32Array(64)
        // Never resolves: no further chunks, no completion.
        await new Promise(() => {})
        stalledForever = false
      }
    }

    const response = await model.run(neverEnding)
    const settled = response.await().then(
      () => 'resolved',
      (error) => String(error)
    )
    await wait(10)

    await model.destroy()
    t.ok(model.getState().destroyed, `${engine}: destroy() resolves despite the stalled iterable`)
    t.ok(/destroyed/.test(await settled), `${engine}: the stalled job is failed, not left hanging`)
    t.ok(stalledForever, `${engine}: the iterable really never completed`)
  }
})

test('lifecycle calls stay queued regardless of exclusiveRun', async (t) => {
  const binding = new WhisperMockedBinding()
  const { model } = createWhisperModel({
    binding,
    options: { exclusiveRun: false }
  })
  await model.load()

  // reload/unload/destroy always route through the queue — back-to-back calls
  // must serialize instead of interleaving native teardown.
  await model.reload({ whisperConfig: { language: 'es' } })
  await model.unload()
  await model.destroy()
  t.ok(model.getState().destroyed, 'Lifecycle chain completes cleanly in order')
})
