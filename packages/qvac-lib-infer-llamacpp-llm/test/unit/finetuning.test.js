'use strict'

const test = require('brittle')
const LlmLlamacpp = require('../../index.js')

function createStub (defaultImpl = () => {}) {
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
  fn.calledWith = (...expected) =>
    fn.called && fn.lastArgs && fn.lastArgs.length >= expected.length &&
    expected.every((e, i) => e === fn.lastArgs[i])
  return fn
}

function createMockAddon () {
  const finetuneStub = createStub()
  const finetune = function (...args) {
    finetune.called = true
    finetune.lastArgs = args
    return finetuneStub.apply(this, args)
  }
  finetune.called = false
  finetune.lastArgs = null
  finetune.callsFake = (impl) => { finetuneStub.callsFake(impl); return finetune }
  finetune.calledWith = (...expected) => finetuneStub.calledWith(...expected)
  return {
    finetune,
    activate: createStub(),
    pause: createStub(() => Promise.resolve(true))
  }
}

function completeFinetuneWith (model, status = 'IDLE') {
  return () => {
    setImmediate(() => {
      if (model._finetuneCompletionResolve) model._finetuneCompletionResolve(status)
      if (model._finetuneRelease) {
        model._finetuneRelease()
        model._finetuneRelease = null
      }
    })
  }
}

const createModelWithMockAddon = (finetuningParams = null) => {
  const loader = { close: () => Promise.resolve() }
  const model = new LlmLlamacpp(
    {
      loader,
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      diskPath: '.',
      modelName: 'test.gguf'
    },
    { device: 'cpu', ctx_size: '256' },
    finetuningParams
  )
  model.addon = createMockAddon()
  return model
}

test('finetune() throws when no params and no stored params', async (t) => {
  const model = createModelWithMockAddon(null)
  await t.exception(
    () => model.finetune(),
    /Finetuning parameters are required/
  )
  t.ok(!model.addon.finetune.called)
})

test('finetune() with no args throws when no stored params', async (t) => {
  const model = createModelWithMockAddon(null)
  await t.exception(
    () => model.finetune(),
    /Finetuning parameters are required/
  )
  t.ok(!model.addon.finetune.called)
})

test('finetune(opts) stores params and calls addon.finetune', async (t) => {
  const model = createModelWithMockAddon(null)
  const opts = {
    trainDatasetDir: '/tmp/train.jsonl',
    evalDatasetDir: '/tmp/eval.jsonl',
    outputParametersDir: '/tmp/out',
    numberOfEpochs: 1,
    learningRate: 1e-5
  }

  model.addon.finetune.callsFake(completeFinetuneWith(model))

  const handle = await model.finetune(opts)
  t.ok(model.addon.finetune.called)
  t.ok(model.addon.finetune.calledWith(opts))
  t.alike(model._defaultFinetuneParams, opts)
  t.ok(handle && typeof handle.await === 'function', 'finetune returns handle with await()')
  const result = await handle.await()
  t.alike(result, { status: 'IDLE' })
})

test('finetune() with no args uses stored params and calls addon.finetune', async (t) => {
  const opts = {
    trainDatasetDir: '/tmp/train.jsonl',
    evalDatasetDir: '/tmp/eval.jsonl',
    outputParametersDir: '/tmp/out',
    numberOfEpochs: 1,
    learningRate: 1e-5
  }
  const model = createModelWithMockAddon(opts)

  model.addon.finetune.callsFake(completeFinetuneWith(model))

  const handle = await model.finetune()
  t.ok(model.addon.finetune.called)
  t.ok(model.addon.finetune.calledWith(opts))
  const result = await handle.await()
  t.alike(result, { status: 'IDLE' })
})

test('finetune(opts with resume key) passes opts to addon.finetune', async (t) => {
  const opts = {
    trainDatasetDir: '/tmp/train.jsonl',
    evalDatasetDir: '/tmp/eval.jsonl',
    outputParametersDir: '/tmp/out',
    numberOfEpochs: 1,
    learningRate: 1e-5,
    resume: true
  }
  const model = createModelWithMockAddon(null)

  model.addon.finetune.callsFake(completeFinetuneWith(model))

  const handle = await model.finetune(opts)
  t.ok(model.addon.finetune.called)
  t.ok(model.addon.finetune.calledWith(opts))
  t.ok(handle && typeof handle.await === 'function', 'finetune returns handle')
})

test('pauseFinetune() throws when addon not initialized', async (t) => {
  const model = createModelWithMockAddon(null)
  model.addon = null
  await t.exception(
    () => model.pauseFinetune(),
    /Addon not initialized/
  )
})

test('pauseFinetune() does not throw when finetuning not running', async (t) => {
  const model = createModelWithMockAddon(null)
  model.addon.pause.callsFake(() => Promise.resolve(false))
  await t.execution(async () => { await model.pauseFinetune() })
  t.ok(model.addon.pause.called)
})

test('pauseFinetune() calls addon.pause when running', async (t) => {
  const model = createModelWithMockAddon(null)
  await model.pauseFinetune()
  t.ok(model.addon.pause.called)
})

test('finetune() resolves with PAUSED when paused', async (t) => {
  const opts = {
    trainDatasetDir: '/tmp/train.jsonl',
    evalDatasetDir: '/tmp/eval.jsonl',
    outputParametersDir: '/tmp/out',
    numberOfEpochs: 1,
    learningRate: 1e-5
  }
  const model = createModelWithMockAddon(null)
  model.addon.finetune.callsFake(completeFinetuneWith(model, 'PAUSED'))

  const handle = await model.finetune(opts)
  const result = await handle.await()
  t.alike(result, { status: 'PAUSED' })
})
