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
  const cancel = createStub(() => Promise.resolve())
  return {
    finetune,
    activate: createStub(),
    cancel
  }
}

function completeFinetuneWith (model, status = 'COMPLETED') {
  return () => {
    setImmediate(() => {
      if (model._finetuneCompletionResolve) model._finetuneCompletionResolve(status)
    })
  }
}

function baseFinetuneOpts (overrides = {}) {
  return {
    trainDatasetDir: '/tmp/train.jsonl',
    outputParametersDir: '/tmp/out',
    numberOfEpochs: 1,
    learningRate: 1e-5,
    ...overrides
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

test('finetune(opts) throws when validation object is missing', async (t) => {
  const model = createModelWithMockAddon(null)
  const opts = baseFinetuneOpts()
  await t.exception(
    () => model.finetune(opts),
    /must include validation/
  )
  t.ok(!model.addon.finetune.called)
})

test('finetune(opts) with validation.type dataset requires validation.path', async (t) => {
  const model = createModelWithMockAddon(null)
  const opts = baseFinetuneOpts({ validation: { type: 'dataset' } })
  await t.exception(
    () => model.finetune(opts),
    /no path is provided/
  )
  t.ok(!model.addon.finetune.called)
})

test('finetune(opts) with validation.type dataset throws when path same as trainDatasetDir', async (t) => {
  const model = createModelWithMockAddon(null)
  const opts = baseFinetuneOpts({ validation: { type: 'dataset', path: '/tmp/train.jsonl' } })
  await t.exception(
    () => model.finetune(opts),
    /same as trainDatasetDir/
  )
  t.ok(!model.addon.finetune.called)
})

test('finetune(opts) with validation.type dataset and validation.path passes evalDatasetPath to addon', async (t) => {
  const model = createModelWithMockAddon(null)
  const opts = baseFinetuneOpts({ validation: { type: 'dataset', path: '/tmp/eval.jsonl' } })
  model.addon.finetune.callsFake(completeFinetuneWith(model))
  const handle = await model.finetune(opts)
  t.ok(model.addon.finetune.called)
  const params = model.addon.finetune.lastArgs[0]
  t.is(params.evalDatasetPath, '/tmp/eval.jsonl')
  t.ok(params.useEvalDatasetForValidation === true)
  t.is(params.validationSplit, 0)
  t.ok(!('validation' in params))
  const result = await handle.await()
  t.alike(result, { status: 'COMPLETED' })
})

test('finetune(opts) stores params and calls addon.finetune', async (t) => {
  const model = createModelWithMockAddon(null)
  const opts = baseFinetuneOpts({ evalDatasetDir: '/tmp/eval.jsonl', validation: { type: 'split' } })
  model.addon.finetune.callsFake(completeFinetuneWith(model))

  const handle = await model.finetune(opts)
  t.ok(model.addon.finetune.called)
  const expectedParams = { ...opts, validationSplit: 0.05, useEvalDatasetForValidation: false }
  delete expectedParams.validation
  t.alike(model.addon.finetune.lastArgs[0], expectedParams, 'addon receives normalized params')
  t.alike(model._defaultFinetuneParams, opts)
  t.ok(handle && typeof handle.await === 'function', 'finetune returns handle with await()')
  const result = await handle.await()
  t.alike(result, { status: 'COMPLETED' })
})

test('finetune() with no args uses stored params and calls addon.finetune', async (t) => {
  const opts = baseFinetuneOpts({ evalDatasetDir: '/tmp/eval.jsonl', validation: { type: 'split' } })
  const model = createModelWithMockAddon(opts)

  model.addon.finetune.callsFake(completeFinetuneWith(model))

  const handle = await model.finetune()
  t.ok(model.addon.finetune.called)
  const expectedParams = { ...opts, validationSplit: 0.05, useEvalDatasetForValidation: false }
  delete expectedParams.validation
  t.alike(model.addon.finetune.lastArgs[0], expectedParams, 'addon receives normalized params')
  const result = await handle.await()
  t.alike(result, { status: 'COMPLETED' })
})

test('finetune(opts with resume key) passes opts to addon.finetune', async (t) => {
  const model = createModelWithMockAddon(null)
  const opts = baseFinetuneOpts({ evalDatasetDir: '/tmp/eval.jsonl', resume: true, validation: { type: 'split' } })

  model.addon.finetune.callsFake(completeFinetuneWith(model))

  const handle = await model.finetune(opts)
  t.ok(model.addon.finetune.called)
  const expectedParams = { ...opts, validationSplit: 0.05, useEvalDatasetForValidation: false }
  delete expectedParams.validation
  t.alike(model.addon.finetune.lastArgs[0], expectedParams, 'addon receives normalized params')
  t.ok(handle && typeof handle.await === 'function', 'finetune returns handle')
})

test('cancel() throws when addon not initialized', async (t) => {
  const model = createModelWithMockAddon(null)
  model.addon = null
  await t.exception(
    () => model.cancel(),
    /Addon not initialized/
  )
})

test('cancel() does not throw when finetuning not running', async (t) => {
  const model = createModelWithMockAddon(null)
  model.addon.cancel.callsFake(() => Promise.resolve())
  await t.execution(async () => { await model.cancel() })
  t.ok(model.addon.cancel.called)
})

test('cancel() calls addon.cancel when running', async (t) => {
  const model = createModelWithMockAddon(null)
  await model.cancel()
  t.ok(model.addon.cancel.called)
})

test('finetune() resolves with PAUSED when paused', async (t) => {
  const opts = baseFinetuneOpts({ evalDatasetDir: '/tmp/eval.jsonl', validation: { type: 'none' } })
  const model = createModelWithMockAddon(opts)
  model.addon.finetune.callsFake(completeFinetuneWith(model, 'PAUSED'))

  const handle = await model.finetune(opts)
  const result = await handle.await()
  t.alike(result, { status: 'PAUSED' })
})
