'use strict'

// Multi-job event routing: _addonOutputCallback(...jobId) → _handleAddonOutputEvent
// must direct each tagged event to the QvacResponse registered under that jobId
// in _jobSinks, keep concurrent jobs isolated, and let untagged events fall
// through to the legacy _job handler. This is the JS side of continuous
// batching and had no unit coverage.

const test = require('brittle')
const LlmLlamacpp = require('../../index.js')

function createStub(defaultImpl = () => {}) {
  let impl = defaultImpl
  const fn = function (...args) {
    fn.called = true
    fn.lastArgs = args
    return impl.apply(this, args)
  }
  fn.callsFake = (newImpl) => {
    impl = newImpl || (() => {})
    return fn
  }
  return fn
}

// parallel: 4 puts the model on the tagged multi-job path (_maxConcurrency > 1),
// so routing goes solely through _jobSinks and never the legacy _job fallback.
function createModel() {
  const model = new LlmLlamacpp({
    files: { model: ['/tmp/test.gguf'] },
    config: { device: 'cpu', ctx_size: '256', parallel: '4' },
    logger: { info() {}, warn() {}, error() {}, debug() {} }
  })
  model.addon = { runJob: createStub(), activeJobs: () => 0 }
  return model
}

// A TPS-shaped payload is what the addon emits to end an inference job;
// mapAddonEvent turns it into a JobEnded event for that job.
function endJob(model, jobId) {
  model._addonOutputCallback(null, 'Output', { TPS: 1, tokens: 1 }, null, jobId)
}

test('two concurrent jobs receive only their own output', async (t) => {
  const model = createModel()
  let nextId = 1
  model.addon.runJob.callsFake(() => ({ accepted: true, id: nextId++ }))

  const r1 = await model._runInternal([{ role: 'user', content: 'a' }])
  const r2 = await model._runInternal([{ role: 'user', content: 'b' }])

  // Tokens interleave across the two jobs.
  model._addonOutputCallback(null, 'Output', 'AAA', null, 1)
  model._addonOutputCallback(null, 'Output', 'BBB', null, 2)
  endJob(model, 1)
  endJob(model, 2)

  const out1 = await r1.await()
  const out2 = await r2.await()

  t.ok(out1.includes('AAA'), 'job 1 gets its own token')
  t.absent(out1.includes('BBB'), 'job 1 must not see job 2 output')
  t.ok(out2.includes('BBB'), 'job 2 gets its own token')
  t.absent(out2.includes('AAA'), 'job 2 must not see job 1 output')
})

test('an Error routes only to the targeted job; peers are untouched', (t) => {
  const model = createModel()
  const calls1 = []
  const calls2 = []
  const spy = (log) => ({
    updateOutput(d) {
      log.push(['out', d])
    },
    updateStats() {},
    ended() {
      log.push(['ended'])
    },
    failed(e) {
      log.push(['failed', e])
    }
  })
  model._jobSinks.set(1, spy(calls1))
  model._jobSinks.set(2, spy(calls2))

  const err = new Error('boom')
  model._handleAddonOutputEvent('Error', null, err, 2)

  t.alike(calls2, [['failed', err]], 'targeted job sink receives the failure')
  t.alike(calls1, [], 'peer job sink is untouched')
})

test('two concurrent batch groups route chunks, results and stats independently', async (t) => {
  const model = new LlmLlamacpp({
    files: { model: ['/tmp/test.gguf'] },
    config: { device: 'cpu', ctx_size: '256', parallel: '4' },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    opts: { stats: true }
  })
  let nextId = 11
  const runJob = createStub()
  runJob.callsFake((items) => ({
    accepted: true,
    ids: items.map((item) => item.id),
    id: nextId++
  }))
  model.addon = { runJob, activeJobs: () => 0 }

  const prompt = [{ role: 'user', content: 'x' }]
  const groupA = await model._runBatchInternal([
    { id: 'a1', prompt },
    { id: 'a2', prompt }
  ])
  const groupB = await model._runBatchInternal([
    { id: 'b1', prompt },
    { id: 'b2', prompt }
  ])

  const chunksA = []
  const chunksB = []
  groupA.onUpdate((chunk) => chunksA.push(chunk))
  groupB.onUpdate((chunk) => chunksB.push(chunk))

  // Streaming chunks are untagged; routed by their per-prompt string id.
  model._handleAddonOutputEvent('BatchOutput', { id: 'a1', output: 'AAA' }, null, undefined)
  model._handleAddonOutputEvent('BatchOutput', { id: 'b2', output: 'BBB' }, null, undefined)

  // Terminal events are tagged with the group's native job id.
  model._handleAddonOutputEvent('BatchResult', ['outA1', 'outA2'], null, 11)
  model._handleAddonOutputEvent('JobEnded', { TPS: 5, generatedTokens: 7 }, null, 11)
  model._handleAddonOutputEvent('BatchResult', ['outB1', 'outB2'], null, 12)
  model._handleAddonOutputEvent('JobEnded', { TPS: 9, generatedTokens: 3 }, null, 12)

  const resultsA = await groupA.await()
  const resultsB = await groupB.await()

  t.alike(chunksA, [{ id: 'a1', chunk: 'AAA' }], 'group A streams only its own chunk')
  t.alike(chunksB, [{ id: 'b2', chunk: 'BBB' }], 'group B streams only its own chunk')
  t.alike(
    resultsA,
    [
      { id: 'a1', output: 'outA1' },
      { id: 'a2', output: 'outA2' }
    ],
    'group A resolves its own results'
  )
  t.alike(
    resultsB,
    [
      { id: 'b1', output: 'outB1' },
      { id: 'b2', output: 'outB2' }
    ],
    'group B resolves its own results'
  )
  t.is(groupA.stats.TPS, 5, 'group A carries its own per-group stats')
  t.is(groupB.stats.TPS, 9, 'group B carries its own per-group stats')
})

test('a tagged batch Error fails only its group; the peer group still completes', async (t) => {
  const model = new LlmLlamacpp({
    files: { model: ['/tmp/test.gguf'] },
    config: { device: 'cpu', ctx_size: '256', parallel: '4' },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    opts: { stats: true }
  })
  let nextId = 21
  const runJob = createStub()
  runJob.callsFake((items) => ({
    accepted: true,
    ids: items.map((item) => item.id),
    id: nextId++
  }))
  model.addon = { runJob, activeJobs: () => 0 }

  const prompt = [{ role: 'user', content: 'x' }]
  const groupA = await model._runBatchInternal([{ id: 'ea', prompt }])
  const groupB = await model._runBatchInternal([{ id: 'eb', prompt }])

  model._handleAddonOutputEvent('Error', null, new Error('boom'), 21)
  model._handleAddonOutputEvent('BatchResult', ['fine'], null, 22)
  model._handleAddonOutputEvent('JobEnded', { TPS: 1 }, null, 22)

  await t.exception(() => groupA.await(), /boom/, 'failed group rejects with its own error')
  t.alike(
    await groupB.await(),
    [{ id: 'eb', output: 'fine' }],
    'peer group is untouched and completes'
  )
})

test('untagged events fall through to _job, not to any per-job sink', (t) => {
  const model = createModel()
  const calls = []
  model._jobSinks.set(1, {
    updateOutput(d) {
      calls.push(d)
    },
    updateStats() {},
    ended() {},
    failed() {}
  })
  let jobOutput = null
  model._job = {
    output(d) {
      jobOutput = d
    },
    active: null
  }

  // jobId undefined => untagged.
  model._handleAddonOutputEvent('Output', 'untagged', null, undefined)

  t.is(jobOutput, 'untagged', 'untagged output goes to the legacy _job handler')
  t.alike(calls, [], 'no per-job sink receives an untagged event')
})
