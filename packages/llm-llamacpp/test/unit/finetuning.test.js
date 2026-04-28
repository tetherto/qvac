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
  return fn
}

function createMockAddon () {
  return {
    finetune: createStub(),
    runJob: createStub(),
    activate: createStub(),
    cancel: createStub(() => Promise.resolve())
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
    learningRate: 1e-5,
    ...overrides
  }
}

async function assertInferenceSucceeds (t, model, token) {
  model.addon.runJob.callsFake(() => true)
  const response = await model._runInternal([{ role: 'user', content: 'test' }])
  model._addonOutputCallback(null, 'Output', token, null)
  model._addonOutputCallback(null, 'Output', { TPS: 1, tokens: 1 }, null)
  const output = await response.await()
  t.ok(Array.isArray(output), 'inference should resolve with output array')
  t.ok(output.includes(token), 'output should contain the generated token')
  t.is(model._hasActiveResponse, false, 'busy state must clear after inference ends')
}

const createModelWithMockAddon = (opts = {}) => {
  const model = new LlmLlamacpp({
    files: { model: ['/tmp/test.gguf'] },
    config: { device: 'cpu', ctx_size: '256' },
    opts,
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
  })
  model.addon = createMockAddon()
  return model
}

test('finetune() throws when no params provided', async (t) => {
  const model = createModelWithMockAddon()
  await t.exception(
    () => model.finetune(),
    /Finetuning parameters are required/
  )
  t.ok(!model.addon.finetune.called)
})

test('finetune(opts) throws when validation object is missing', async (t) => {
  const model = createModelWithMockAddon()
  const opts = baseFinetuneOpts()
  await t.exception(
    () => model.finetune(opts),
    /must include validation/
  )
  t.ok(!model.addon.finetune.called)
})

test('finetune(opts) with validation.type dataset requires validation.path', async (t) => {
  const model = createModelWithMockAddon()
  const opts = baseFinetuneOpts({ validation: { type: 'dataset' } })
  await t.exception(
    () => model.finetune(opts),
    /no path is provided/
  )
  t.ok(!model.addon.finetune.called)
})

test('finetune(opts) with validation.type dataset throws when path same as trainDatasetDir', async (t) => {
  const model = createModelWithMockAddon()
  const opts = baseFinetuneOpts({ validation: { type: 'dataset', path: '/tmp/train.jsonl' } })
  await t.exception(
    () => model.finetune(opts),
    /same as trainDatasetDir/
  )
  t.ok(!model.addon.finetune.called)
})

test('finetune(opts) with validation.type dataset and validation.path passes evalDatasetPath to addon', async (t) => {
  const model = createModelWithMockAddon()
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
  const model = createModelWithMockAddon()
  const opts = baseFinetuneOpts({ evalDatasetPath: '/tmp/eval.jsonl', validation: { type: 'split' } })
  await t.exception(
    () => model.finetune(opts),
    /Top-level evalDatasetPath is no longer supported/
  )
  t.ok(!model.addon.finetune.called)
})

test('finetune(opts) stores params and calls addon.finetune', async (t) => {
  const model = createModelWithMockAddon()
  const opts = baseFinetuneOpts({ validation: { type: 'split' } })
  model.addon.finetune.callsFake(completeFinetuneWith(model))

  const handle = await model.finetune(opts)
  t.ok(model.addon.finetune.called)
  const expectedParams = { ...opts, validationSplit: 0.05, useEvalDatasetForValidation: false }
  delete expectedParams.validation
  t.alike(model.addon.finetune.lastArgs[0], expectedParams, 'addon receives normalized params')
  t.ok(handle && typeof handle.await === 'function', 'finetune returns handle with await()')
  const result = await handle.await()
  t.alike(result, { op: 'finetune', status: 'COMPLETED' })
})

test('finetune() with no args throws', async (t) => {
  const model = createModelWithMockAddon()
  await t.exception(
    () => model.finetune(),
    /Finetuning parameters are required/
  )
  t.ok(!model.addon.finetune.called)
})

test('finetune(opts with resume key) passes opts to addon.finetune', async (t) => {
  const model = createModelWithMockAddon()
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
  const model = createModelWithMockAddon()
  const opts = baseFinetuneOpts({ validation: { type: 'split' } })
  model.addon.finetune.callsFake(completeFinetuneWith(model))

  let wrapperCalled = false
  const originalRun = model._run
  model._run = async (fn) => {
    wrapperCalled = true
    return await originalRun(fn)
  }

  const handle = await model.finetune(opts)
  t.ok(wrapperCalled, 'finetune should execute inside exclusiveRunQueue')
  const result = await handle.await()
  t.alike(result, { op: 'finetune', status: 'COMPLETED' })
})

test('finetune() rejects when another active job exists', async (t) => {
  const model = createModelWithMockAddon()
  const opts = baseFinetuneOpts({ validation: { type: 'split' } })
  model._hasActiveResponse = true

  await t.exception(
    () => model.finetune(opts),
    /already set or being processed/
  )
  t.ok(!model.addon.finetune.called, 'addon.finetune is not called when busy')
})

test('finetune() marks busy and rejects second finetune while active', async (t) => {
  const model = createModelWithMockAddon()
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
  const model = createModelWithMockAddon()
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

test('inference succeeds on same model instance after finetune completes', async (t) => {
  const model = createModelWithMockAddon()
  const opts = baseFinetuneOpts({ validation: { type: 'split' } })
  model.addon.finetune.callsFake(() => true)

  const finetuneHandle = await model.finetune(opts)
  model._addonOutputCallback(null, 'Output', { op: 'finetune', status: 'COMPLETED' }, null)
  const finetuneResult = await finetuneHandle.await()
  t.alike(finetuneResult, { op: 'finetune', status: 'COMPLETED' })
  t.is(model._hasActiveResponse, false, 'busy state must be clear after finetune')

  model._addonOutputCallback(null, 'Output', { TPS: 0, tokens: 0 }, null)

  await assertInferenceSucceeds(t, model, 'Hi there')
})

test('inference succeeds after a PAUSED finetune on the same model instance', async (t) => {
  const model = createModelWithMockAddon()
  const opts = baseFinetuneOpts({ validation: { type: 'split' } })
  model.addon.finetune.callsFake(() => true)

  const finetuneHandle = await model.finetune(opts)
  model._addonOutputCallback(null, 'Output', { op: 'finetune', status: 'PAUSED' }, null)
  const finetuneResult = await finetuneHandle.await()
  t.alike(finetuneResult, { op: 'finetune', status: 'PAUSED' })
  t.is(model._hasActiveResponse, false, 'busy state must clear after paused finetune')

  model._addonOutputCallback(null, 'Output', { TPS: 0, tokens: 0 }, null)

  await assertInferenceSucceeds(t, model, 'output')
})

test('inference succeeds after a failed finetune on the same model instance', async (t) => {
  const model = createModelWithMockAddon()
  const opts = baseFinetuneOpts({ validation: { type: 'split' } })
  model.addon.finetune.callsFake(() => {
    setImmediate(() => {
      model._addonOutputCallback(null, 'SomeError', null, 'Training failed: OOM')
    })
    return true
  })

  const finetuneHandle = await model.finetune(opts)
  await t.exception(() => finetuneHandle.await(), /OOM/)
  t.is(model._hasActiveResponse, false, 'busy state must clear after failed finetune')

  await assertInferenceSucceeds(t, model, 'output')
})

test('finetune() clears busy state on error and allows next finetune', async (t) => {
  const model = createModelWithMockAddon()
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
  const model = createModelWithMockAddon()
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
  const model = createModelWithMockAddon()
  model.addon = null
  await t.execution(async () => { await model.pause() })
})

test('pause() calls addon.cancel to trigger checkpoint save', async (t) => {
  const model = createModelWithMockAddon()
  model.addon.cancel.callsFake(() => Promise.resolve())
  await model.pause()
  t.ok(model.addon.cancel.called)
})

test('cancel() calls addon.cancel and clears pause checkpoints', async (t) => {
  const model = createModelWithMockAddon()
  model._checkpointSaveDir = '/tmp/test-checkpoints'
  model.addon.cancel.callsFake(() => Promise.resolve())

  let clearCalled = false
  model._clearPauseCheckpoints = () => { clearCalled = true }

  await model.cancel()
  t.ok(model.addon.cancel.called, 'addon.cancel must be called')
  t.ok(clearCalled, '_clearPauseCheckpoints must be called after addon.cancel')
})

test('cancel() is no-op when addon not initialized', async (t) => {
  const model = createModelWithMockAddon()
  model.addon = null
  await t.execution(async () => { await model.cancel() })
})

test('cancel() does not throw when no checkpointSaveDir configured', async (t) => {
  const model = createModelWithMockAddon()
  model.addon.cancel.callsFake(() => Promise.resolve())
  await t.execution(async () => { await model.cancel() })
  t.ok(model.addon.cancel.called)
})

test('finetune() resolves with PAUSED when paused', async (t) => {
  const opts = baseFinetuneOpts({ validation: { type: 'none' } })
  const model = createModelWithMockAddon()
  model.addon.finetune.callsFake(completeFinetuneWith(model, 'PAUSED'))

  const handle = await model.finetune(opts)
  const result = await handle.await()
  t.alike(result, { op: 'finetune', status: 'PAUSED' })
})

test('finetune() rejects handle.await() on runtime error (like inference)', async (t) => {
  const opts = baseFinetuneOpts({ validation: { type: 'none' } })
  const model = createModelWithMockAddon()
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

test('_skipNextRuntimeStats swallows TPS stats that follow a finetune terminal result', async (t) => {
  const model = createModelWithMockAddon()
  const opts = baseFinetuneOpts({ validation: { type: 'split' } })
  model.addon.finetune.callsFake(() => true)

  const handle = await model.finetune(opts)
  t.is(model._addonEventState.skipNextRuntimeStats, false, 'flag starts false before finetune terminal arrives')

  model._addonOutputCallback(null, 'Output', { op: 'finetune', status: 'COMPLETED' }, null)
  t.is(model._addonEventState.skipNextRuntimeStats, true, 'flag must be set after finetune terminal result')

  const result = await handle.await()
  t.alike(result, { op: 'finetune', status: 'COMPLETED' })

  model._addonOutputCallback(null, 'Output', { TPS: 0, tokens: 0, time_ms: 100 }, null)
  t.is(model._addonEventState.skipNextRuntimeStats, false, 'flag must reset after TPS stats are consumed')
})

test('TPS stats without prior finetune are forwarded as normal JobEnded', async (t) => {
  const model = createModelWithMockAddon()
  model.addon.runJob.callsFake(() => true)

  const response = await model._runInternal([{ role: 'user', content: 'Hello' }])
  t.is(model._addonEventState.skipNextRuntimeStats, false, 'flag should be false without finetune')

  model._addonOutputCallback(null, 'Output', 'world', null)
  model._addonOutputCallback(null, 'Output', { TPS: 42.5, tokens: 10, time_ms: 235 }, null)

  const output = await response.await()
  t.ok(Array.isArray(output), 'inference response should resolve with output array')
  t.ok(output.includes('world'), 'output should contain the emitted token')
  t.is(model._addonEventState.skipNextRuntimeStats, false, 'flag should remain false')
  t.is(model._hasActiveResponse, false, 'busy state should be cleared')
})

test('_skipNextRuntimeStats prevents finetune TPS from ending a subsequent inference job', async (t) => {
  const model = createModelWithMockAddon()
  const opts = baseFinetuneOpts({ validation: { type: 'split' } })
  model.addon.finetune.callsFake(() => true)

  const finetuneHandle = await model.finetune(opts)
  model._addonOutputCallback(null, 'Output', { op: 'finetune', status: 'COMPLETED' }, null)
  await finetuneHandle.await()
  t.is(model._addonEventState.skipNextRuntimeStats, true, 'skip flag should be armed after finetune')

  model.addon.runJob.callsFake(() => true)
  const inferResponse = await model._runInternal([{ role: 'user', content: 'Hello' }])

  model._addonOutputCallback(null, 'Output', { TPS: 0, tokens: 0 }, null)
  t.is(model._addonEventState.skipNextRuntimeStats, false, 'flag should reset after consuming stale TPS')
  t.is(inferResponse.getStatus(), 'running', 'inference must still be running after stale TPS was swallowed')

  model._addonOutputCallback(null, 'Output', 'answer', null)
  model._addonOutputCallback(null, 'Output', { TPS: 50.0, tokens: 5 }, null)

  const output = await inferResponse.await()
  t.ok(Array.isArray(output), 'inference should resolve with output array')
  t.ok(output.includes('answer'), 'output should contain the inference token')
  t.is(model._hasActiveResponse, false, 'busy state should clear after inference ends')
})

test('finetune progress events emit stats on handle when opts.stats is enabled', async (t) => {
  const finetuneOpts = baseFinetuneOpts({ validation: { type: 'split' } })
  const model = createModelWithMockAddon({ stats: true })
  model.addon.finetune.callsFake(() => true)

  const handle = await model.finetune(finetuneOpts)
  const received = []
  handle.on('stats', (stats) => { received.push(stats) })

  const progress1 = { loss: 2.5, accuracy: 0.3, global_steps: 10, current_epoch: 0, current_batch: 5, total_batches: 20 }
  const progress2 = { loss: 1.8, accuracy: 0.55, global_steps: 20, current_epoch: 0, current_batch: 10, total_batches: 20 }
  model._addonOutputCallback(null, 'Output', { type: 'finetune_progress', stats: progress1 }, null)
  model._addonOutputCallback(null, 'Output', { type: 'finetune_progress', stats: progress2 }, null)

  t.is(received.length, 2, 'should receive two progress stats events')
  t.alike(received[0], progress1)
  t.alike(received[1], progress2)

  model._addonOutputCallback(null, 'Output', { op: 'finetune', status: 'COMPLETED' }, null)
  await handle.await()
})

test('finetune progress events are suppressed when opts.stats is not enabled', async (t) => {
  const finetuneOpts = baseFinetuneOpts({ validation: { type: 'split' } })
  const model = createModelWithMockAddon()
  model.addon.finetune.callsFake(() => true)

  const handle = await model.finetune(finetuneOpts)
  const received = []
  handle.on('stats', (stats) => { received.push(stats) })

  model._addonOutputCallback(null, 'Output', {
    type: 'finetune_progress',
    stats: { loss: 2.5, accuracy: 0.3, global_steps: 10, current_epoch: 0, current_batch: 5, total_batches: 20 }
  }, null)

  t.is(received.length, 0, 'should not emit stats when opts.stats is disabled')

  model._addonOutputCallback(null, 'Output', { op: 'finetune', status: 'COMPLETED' }, null)
  await handle.await()
})

test('finetune() returns terminal stats when provided', async (t) => {
  const opts = baseFinetuneOpts({ validation: { type: 'split' } })
  const model = createModelWithMockAddon()
  const stats = {
    train_loss: 1.25,
    train_loss_uncertainty: 0.05,
    val_loss: 1.1,
    val_loss_uncertainty: 0.08,
    train_accuracy: 0.78,
    train_accuracy_uncertainty: 0.03,
    val_accuracy: 0.74,
    val_accuracy_uncertainty: 0.04,
    learning_rate: 0.00001,
    global_steps: 320,
    epochs_completed: 2
  }
  model.addon.finetune.callsFake(completeFinetuneWith(model, 'COMPLETED', stats))

  const handle = await model.finetune(opts)
  const result = await handle.await()
  t.alike(result, { op: 'finetune', status: 'COMPLETED', stats })
})
