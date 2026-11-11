/**
 * Nemotron streaming accepts only its trained chunk cadences (80, 160, 320,
 * 560, 1120 ms). An unsupported run-level `chunkMs` must be rejected before
 * the native session is opened, with INVALID_CONFIG naming the supported
 * values, and the model must stay usable afterwards. A session start the engine itself
 * refuses must surface as FAILED_TO_START_STREAMING and leave no job behind.
 */

const test = require('brittle')
const MockedBinding = require('../mocks/ParakeetMockedBinding.js')
const { createParakeetModel, getJob, pushable } = require('../mocks/createModel.js')

const process = require('bare-process')
global.process = process

class NemotronBinding extends MockedBinding {
  getBackendInfo(handle) {
    return { ...super.getBackendInfo(handle), modelType: 'nemotron' }
  }
}

class RefusingStartBinding extends NemotronBinding {
  startStreaming() {
    throw new Error(
      'Engine::stream_start: unsupported Nemotron chunk_ms; supported values are 80, 160, 320, 560, and 1120'
    )
  }
}

function createNemotron({ binding, parakeetConfig = {} } = {}) {
  const { model } = createParakeetModel({
    binding,
    parakeetConfig: { streaming: true, ...parakeetConfig }
  })
  return model
}

test('an unsupported chunkMs is rejected before the session opens and the model stays usable', async (t) => {
  const binding = new NemotronBinding()
  const model = createNemotron({ binding })
  await model.load()

  const stream = pushable()
  const error = await model.runStreaming(stream, { chunkMs: 1000 }).then(
    () => null,
    (e) => e
  )
  t.ok(error, 'rejects')
  t.is(error.name, 'INVALID_CONFIG')
  t.ok(/80, 160, 320, 560, 1120/.test(error.message), 'names the supported values')
  t.is(binding._streamingActive, false, 'native session never opened')
  t.absent(getJob(model).active, 'no response left active')
  stream.end()

  const ok = pushable()
  const response = await model.runStreaming(ok, { chunkMs: 560 })
  ok.end()
  await response.await()
  await model.unload()
})

test('a run-level chunkMs of 0 keeps the load-time cadence and is accepted', async (t) => {
  // Native rules: a run-level chunkMs of 0 is ignored (the load-time value
  // applies) and a load-time streamingChunkMs of 0 resolves to Nemotron's
  // 320 ms default. A load-time value the model does not support is the
  // engine's to refuse at load (FAILED_TO_ACTIVATE), not runStreaming()'s.
  const binding = new NemotronBinding()
  const model = createNemotron({ binding, parakeetConfig: { streamingChunkMs: 0 } })
  await model.load()

  const byLoad = pushable()
  const first = await model.runStreaming(byLoad)
  byLoad.end()
  await first.await()

  const byRun = pushable()
  const second = await model.runStreaming(byRun, { chunkMs: 0 })
  byRun.end()
  await second.await()
  await model.unload()

  const loaded560 = createNemotron({
    binding: new NemotronBinding(),
    parakeetConfig: { streamingChunkMs: 560 }
  })
  await loaded560.load()
  const keep = pushable()
  const third = await loaded560.runStreaming(keep, { chunkMs: 0 })
  keep.end()
  await third.await()
  await loaded560.unload()
})

test('the supported cadences are published as a frozen array', (t) => {
  // The same reference is exposed as the ASRGgml.NEMOTRON_STREAMING_CHUNK_MS
  // static; index.js is not loaded here because it binds the native addon.
  const { NEMOTRON_STREAMING_CHUNK_MS } = require('../../lib/constants.js')
  t.alike([...NEMOTRON_STREAMING_CHUNK_MS], [80, 160, 320, 560, 1120])
  t.ok(Object.isFrozen(NEMOTRON_STREAMING_CHUNK_MS), 'callers cannot edit what the driver accepts')
  let pushError
  try {
    NEMOTRON_STREAMING_CHUNK_MS.push(1000)
  } catch (err) {
    pushError = err
  }
  t.ok(pushError instanceof TypeError, 'push on the frozen array throws')
  t.alike([...NEMOTRON_STREAMING_CHUNK_MS], [80, 160, 320, 560, 1120], 'and leaves it unchanged')
})

test('non-Nemotron models keep accepting any chunkMs', async (t) => {
  const model = createNemotron({ binding: new MockedBinding() })
  await model.load()
  const stream = pushable()
  const response = await model.runStreaming(stream, { chunkMs: 1000 })
  stream.end()
  await response.await()
  await model.unload()
})

test('a session start the engine refuses settles as FAILED_TO_START_STREAMING', async (t) => {
  const model = createNemotron({ binding: new RefusingStartBinding() })
  await model.load()
  const stream = pushable()
  const error = await model.runStreaming(stream, { chunkMs: 560 }).then(
    () => null,
    (e) => e
  )
  t.ok(error, 'rejects')
  t.is(error.name, 'FAILED_TO_START_STREAMING')
  const { ERR_CODES } = require('../../lib/error.js')
  t.is(error.code, ERR_CODES.FAILED_TO_START_STREAMING, 'one code per name: the shared 6012')
  t.is(error.code, 6012)
  t.ok(/supported values are 80, 160, 320, 560/.test(error.message), 'carries the engine message')
  t.absent(getJob(model).active, 'no response left active')
  stream.end()
  await model.unload()
})
