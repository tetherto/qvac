'use strict'

const test = require('brittle')
const LlmLlamacpp = require('../../index.js')

function createStub(defaultImpl = () => {}) {
  let impl = defaultImpl
  const fn = function (...args) {
    fn.called = true
    fn.lastArgs = args
    return impl.apply(this, args)
  }
  fn.called = false
  fn.lastArgs = null
  fn.callsFake = (newImpl) => {
    impl = newImpl || (() => {})
    return fn
  }
  return fn
}

function createModelWithMockAddon() {
  const model = new LlmLlamacpp({
    files: { model: ['/tmp/test.gguf'] },
    config: { device: 'cpu', ctx_size: '256' },
    opts: { stats: true },
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
  })
  model.addon = {
    finetune: createStub(),
    runJob: createStub(),
    cancel: createStub(() => Promise.resolve()),
    activeJobs: () => 0
  }
  return model
}

const FINETUNE_OPTS = {
  trainDatasetDir: '/tmp/train.jsonl',
  outputParametersDir: '/tmp/out',
  learningRate: 1e-5,
  validation: { type: 'none' }
}

test('finetune() registers a sink under the native id; tagged events route to it', async (t) => {
  const model = createModelWithMockAddon()
  model.addon.finetune.callsFake(() => 42)

  const response = await model.finetune(FINETUNE_OPTS)
  t.ok(model._jobSinks.has(42), 'the finetune sink must be registered under the native id')

  // Tagged streamed output routes through the sink to the finetune handler.
  model._addonOutputCallback(null, 'Output', 'epoch log line', null, 42)

  // Tagged terminal resolves the finetune response and deregisters the sink.
  model._addonOutputCallback(null, 'Output', { op: 'finetune', status: 'COMPLETED' }, null, 42)

  const result = await response.await()
  t.is(result.status, 'COMPLETED', 'the tagged terminal must resolve the finetune response')
  t.absent(model._jobSinks.has(42), 'the terminal must deregister the finetune sink')
})

test('a tagged finetune Error rejects the finetune response and deregisters the sink', async (t) => {
  const model = createModelWithMockAddon()
  model.addon.finetune.callsFake(() => 7)

  const response = await model.finetune(FINETUNE_OPTS)
  t.ok(model._jobSinks.has(7))

  model._addonOutputCallback(null, 'JobError', null, new Error('boom'), 7)

  await t.exception(() => response.await(), /boom/, 'the tagged error must reject the response')
  t.absent(model._jobSinks.has(7), 'a failed finetune must deregister its sink')
})

test('legacy boolean admission skips sink registration and keeps untagged routing', async (t) => {
  const model = createModelWithMockAddon()
  model.addon.finetune.callsFake(() => true)

  const response = await model.finetune(FINETUNE_OPTS)
  t.is(model._jobSinks.size, 0, 'a boolean admission must not register a sink')

  // Untagged terminal still routes via the payload.
  model._addonOutputCallback(null, 'Output', { op: 'finetune', status: 'COMPLETED' }, null)
  const result = await response.await()
  t.is(result.status, 'COMPLETED')
})
