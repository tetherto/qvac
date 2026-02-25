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
  const runJob = createStub()
  const cancel = createStub(() => Promise.resolve())
  return {
    finetune,
    runJob,
    activate: createStub(),
    cancel
  }
}

function completeFinetuneWith (model, status = 'COMPLETED', stats = null) {
  return () => {
    setImmediate(() => {
      const payload = { op: 'finetune', status }
      if (stats) payload.stats = stats
      model._addonOutputCallback(null, 'Output', payload, null)
    })
    return true
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
  t.alike(result, { op: 'finetune', status: 'COMPLETED' })
})

test('finetune(opts) throws when top-level evalDatasetPath is provided', async (t) => {
  const model = createModelWithMockAddon(null)
  const opts = baseFinetuneOpts({ evalDatasetPath: '/tmp/eval.jsonl', validation: { type: 'split' } })
  await t.exception(
    () => model.finetune(opts),
    /Top-level evalDatasetPath is no longer supported/
  )
  t.ok(!model.addon.finetune.called)
})

test('finetune(opts) stores params and calls addon.finetune', async (t) => {
  const model = createModelWithMockAddon(null)
  const opts = baseFinetuneOpts({ validation: { type: 'split' } })
  model.addon.finetune.callsFake(completeFinetuneWith(model))

  const handle = await model.finetune(opts)
  t.ok(model.addon.finetune.called)
  const expectedParams = { ...opts, validationSplit: 0.05, useEvalDatasetForValidation: false }
  delete expectedParams.validation
  t.alike(model.addon.finetune.lastArgs[0], expectedParams, 'addon receives normalized params')
  t.alike(model._defaultFinetuneParams, opts)
  t.ok(handle && typeof handle.await === 'function', 'finetune returns handle with await()')
  const result = await handle.await()
  t.alike(result, { op: 'finetune', status: 'COMPLETED' })
})

test('finetune() with no args uses stored params and calls addon.finetune', async (t) => {
  const opts = baseFinetuneOpts({ validation: { type: 'split' } })
  const model = createModelWithMockAddon(opts)

  model.addon.finetune.callsFake(completeFinetuneWith(model))

  const handle = await model.finetune()
  t.ok(model.addon.finetune.called)
  const expectedParams = { ...opts, validationSplit: 0.05, useEvalDatasetForValidation: false }
  delete expectedParams.validation
  t.alike(model.addon.finetune.lastArgs[0], expectedParams, 'addon receives normalized params')
  const result = await handle.await()
  t.alike(result, { op: 'finetune', status: 'COMPLETED' })
})

test('finetune(opts with resume key) passes opts to addon.finetune', async (t) => {
  const model = createModelWithMockAddon(null)
  const opts = baseFinetuneOpts({ resume: true, validation: { type: 'split' } })

  model.addon.finetune.callsFake(completeFinetuneWith(model))

  const handle = await model.finetune(opts)
  t.ok(model.addon.finetune.called)
  const expectedParams = { ...opts, validationSplit: 0.05, useEvalDatasetForValidation: false }
  delete expectedParams.validation
  t.alike(model.addon.finetune.lastArgs[0], expectedParams, 'addon receives normalized params')
  t.ok(handle && typeof handle.await === 'function', 'finetune returns handle')
})

test('finetune() runs inside exclusive queue wrapper', async (t) => {
  const model = createModelWithMockAddon(null)
  const opts = baseFinetuneOpts({ validation: { type: 'split' } })
  model.addon.finetune.callsFake(completeFinetuneWith(model))

  let wrapperCalled = false
  model._withExclusiveRun = async (fn) => {
    wrapperCalled = true
    return await fn()
  }

  const handle = await model.finetune(opts)
  t.ok(wrapperCalled, 'finetune should execute inside _withExclusiveRun')
  const result = await handle.await()
  t.alike(result, { op: 'finetune', status: 'COMPLETED' })
})

test('finetune() rejects when another active job exists', async (t) => {
  const model = createModelWithMockAddon(null)
  const opts = baseFinetuneOpts({ validation: { type: 'split' } })
  model._hasActiveResponse = true

  await t.exception(
    () => model.finetune(opts),
    /already set or being processed/
  )
  t.ok(!model.addon.finetune.called, 'addon.finetune is not called when busy')
})

test('finetune() marks busy and rejects second finetune while active', async (t) => {
  const model = createModelWithMockAddon(null)
  const opts = baseFinetuneOpts({ validation: { type: 'split' } })
  model.addon.finetune.callsFake(() => true)

  const firstHandle = await model.finetune(opts)
  t.is(model._hasActiveResponse, true, 'finetune should set active job flag after accept')

  await t.exception(
    () => model.finetune(opts),
    /already set or being processed/
  )

  model._addonOutputCallback(null, 'Output', { op: 'finetune', status: 'PAUSED' }, null)
  const firstResult = await firstHandle.await()
  t.alike(firstResult, { op: 'finetune', status: 'PAUSED' })
  t.is(model._hasActiveResponse, false, 'active job flag should clear after terminal await')
})

test('run rejects while finetune is active', async (t) => {
  const model = createModelWithMockAddon(null)
  const opts = baseFinetuneOpts({ validation: { type: 'split' } })
  model.addon.finetune.callsFake(() => true)

  const finetuneHandle = await model.finetune(opts)
  await t.exception(
    () => model._runInternal([{ role: 'user', content: 'Hello' }]),
    /already set or being processed/
  )
  t.ok(!model.addon.runJob.called, 'runJob should not be called when finetune is active')

  model._addonOutputCallback(null, 'Output', { op: 'finetune', status: 'PAUSED' }, null)
  await finetuneHandle.await()
})

test('finetune() clears busy state on error and allows next finetune', async (t) => {
  const model = createModelWithMockAddon(null)
  const opts = baseFinetuneOpts({ validation: { type: 'split' } })
  let calls = 0
  model.addon.finetune.callsFake(() => {
    calls++
    if (calls === 1) {
      setImmediate(() => {
        model._addonOutputCallback(null, 'SomeError', null, 'Training failed: out of memory')
      })
      return true
    }
    return completeFinetuneWith(model)()
  })

  const firstHandle = await model.finetune(opts)
  await t.exception(
    () => firstHandle.await(),
    /out of memory/
  )
  t.is(model._hasActiveResponse, false, 'busy state should clear after failed finetune')

  const secondHandle = await model.finetune(opts)
  const secondResult = await secondHandle.await()
  t.alike(secondResult, { op: 'finetune', status: 'COMPLETED' })
})

test('finetune() clears busy state on terminal callback even without await', async (t) => {
  const model = createModelWithMockAddon(null)
  const opts = baseFinetuneOpts({ validation: { type: 'split' } })
  model.addon.finetune.callsFake(completeFinetuneWith(model))

  await model.finetune(opts)
  t.is(model._hasActiveResponse, true, 'busy flag should be set after finetune starts')

  await new Promise(resolve => setImmediate(resolve))
  t.is(model._hasActiveResponse, false, 'busy flag should clear when terminal callback arrives')

  const secondHandle = await model.finetune(opts)
  const secondResult = await secondHandle.await()
  t.alike(secondResult, { op: 'finetune', status: 'COMPLETED' })
})

test('pause() is no-op when addon not initialized', async (t) => {
  const model = createModelWithMockAddon(null)
  model.addon = null
  await t.execution(async () => { await model.pause() })
})

test('pause() calls addon.cancel to trigger checkpoint save', async (t) => {
  const model = createModelWithMockAddon(null)
  model.addon.cancel.callsFake(() => Promise.resolve())
  await model.pause()
  t.ok(model.addon.cancel.called)
})

test('cancel() calls addon.cancel and clears pause checkpoints', async (t) => {
  const opts = baseFinetuneOpts({ checkpointSaveDir: '/tmp/test-checkpoints', validation: { type: 'none' } })
  const model = createModelWithMockAddon(opts)
  model.addon.cancel.callsFake(() => Promise.resolve())

  let clearCalled = false
  model._clearPauseCheckpoints = () => { clearCalled = true }

  await model.cancel()
  t.ok(model.addon.cancel.called, 'addon.cancel must be called')
  t.ok(clearCalled, '_clearPauseCheckpoints must be called after addon.cancel')
})

test('cancel() is no-op when addon not initialized', async (t) => {
  const model = createModelWithMockAddon(null)
  model.addon = null
  await t.execution(async () => { await model.cancel() })
})

test('cancel() does not throw when no checkpointSaveDir configured', async (t) => {
  const model = createModelWithMockAddon(null)
  model.addon.cancel.callsFake(() => Promise.resolve())
  await t.execution(async () => { await model.cancel() })
  t.ok(model.addon.cancel.called)
})

test('finetune() resolves with PAUSED when paused', async (t) => {
  const opts = baseFinetuneOpts({ validation: { type: 'none' } })
  const model = createModelWithMockAddon(opts)
  model.addon.finetune.callsFake(completeFinetuneWith(model, 'PAUSED'))

  const handle = await model.finetune(opts)
  const result = await handle.await()
  t.alike(result, { op: 'finetune', status: 'PAUSED' })
})

test('finetune() rejects handle.await() on runtime error (like inference)', async (t) => {
  const opts = baseFinetuneOpts({ validation: { type: 'none' } })
  const model = createModelWithMockAddon(opts)
  model.addon.finetune.callsFake(() => {
    setImmediate(() => {
      model._addonOutputCallback(null, 'SomeError', null, 'Training failed: out of memory')
    })
    return true
  })

  const handle = await model.finetune(opts)
  await t.exception(
    () => handle.await(),
    /out of memory/
  )
})

test('finetune() returns terminal stats when provided', async (t) => {
  const opts = baseFinetuneOpts({ validation: { type: 'split' } })
  const model = createModelWithMockAddon(opts)
  const stats = {
    train_loss: 1.25,
    val_loss: 1.1,
    train_accuracy: 0.78,
    val_accuracy: 0.74,
    learning_rate: 0.00001,
    global_steps: 320,
    epochs_completed: 2
  }
  model.addon.finetune.callsFake(completeFinetuneWith(model, 'COMPLETED', stats))

  const handle = await model.finetune()
  const result = await handle.await()
  t.alike(result, { op: 'finetune', status: 'COMPLETED', stats })
})