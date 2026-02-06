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

const createMockAddon = () => ({
  finetune: createStub(),
  activate: createStub(),
  pause: createStub(() => Promise.resolve()),
  isFinetuningRunning: createStub(() => true),
  resolvePauseComplete: createStub()
})

function completeFinetuneWith (model, status = 'IDLE') {
  return () => {
    setImmediate(() => {
      if (model._finetuneCompletionResolve) model._finetuneCompletionResolve(status)
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

test('finetune() throws on resume when no stored params', async (t) => {
  const model = createModelWithMockAddon(null)
  await t.exception(
    () => model.finetune({ resume: true }),
    /No stored finetuning parameters/
  )
  t.ok(!model.addon.activate.called)
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

  const result = await model.finetune(opts)
  t.ok(model.addon.finetune.called)
  t.ok(model.addon.finetune.calledWith(opts))
  t.alike(model._defaultFinetuneParams, opts)
  t.alike(result, { status: 'IDLE' })
})

test('finetune({ resume: true }) uses stored params and calls addon.activate', async (t) => {
  const opts = {
    trainDatasetDir: '/tmp/train.jsonl',
    evalDatasetDir: '/tmp/eval.jsonl',
    outputParametersDir: '/tmp/out',
    numberOfEpochs: 1,
    learningRate: 1e-5
  }
  const model = createModelWithMockAddon(opts)

  model.addon.activate.callsFake(completeFinetuneWith(model))

  const result = await model.finetune({ resume: true })
  t.ok(model.addon.activate.called)
  t.ok(!model.addon.finetune.called)
  t.alike(result, { status: 'IDLE' })
})

test('finetune(opts, { resume: true }) calls activate', async (t) => {
  const storedOpts = {
    trainDatasetDir: '/tmp/train.jsonl',
    evalDatasetDir: '/tmp/eval.jsonl',
    outputParametersDir: '/tmp/out',
    numberOfEpochs: 1,
    learningRate: 1e-5
  }
  const model = createModelWithMockAddon(storedOpts)

  model.addon.activate.callsFake(completeFinetuneWith(model))

  await model.finetune(storedOpts, { resume: true })
  t.ok(model.addon.activate.called)
  t.ok(!model.addon.finetune.called)
})

test('finetune(opts, { resume: false }) starts fresh with addon.finetune', async (t) => {
  const opts = {
    trainDatasetDir: '/tmp/train.jsonl',
    evalDatasetDir: '/tmp/eval.jsonl',
    outputParametersDir: '/tmp/out',
    numberOfEpochs: 1,
    learningRate: 1e-5
  }
  const model = createModelWithMockAddon(null)

  model.addon.finetune.callsFake(completeFinetuneWith(model))

  await model.finetune(opts, { resume: false })
  t.ok(model.addon.finetune.called)
  t.ok(!model.addon.activate.called)
})

test('finetune(opts with resume key) does NOT trigger resume shorthand', async (t) => {
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

  await model.finetune(opts)
  t.ok(model.addon.finetune.called)
  t.ok(model.addon.finetune.calledWith(opts))
  t.ok(!model.addon.activate.called)
})

test('pauseFinetune() throws when addon not initialized', async (t) => {
  const model = createModelWithMockAddon(null)
  model.addon = null
  await t.exception(
    () => model.pauseFinetune(),
    /Addon not initialized/
  )
})

test('pauseFinetune() throws when finetuning not running', async (t) => {
  const model = createModelWithMockAddon(null)
  model.addon.isFinetuningRunning.callsFake(() => false)
  await t.exception(
    () => model.pauseFinetune(),
    /Finetuning not running/
  )
  t.ok(!model.addon.pause.called)
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

  const result = await model.finetune(opts)
  t.alike(result, { status: 'PAUSED' })
})
