'use strict'

const os = require('bare-os')
const path = require('bare-path')
const test = require('brittle')
const EmbedLlamacpp = require('../../index.js')
const { ensureModel, getModelConfigs } = require('./utils')

const platform = os.platform()
const isMobile = platform === 'ios' || platform === 'android'

const MODEL_NAME = getModelConfigs()[0]?.modelName ?? 'embeddinggemma-300M-Q8_0.gguf'

// Every load names a device, so every projection of one does too.
const GPU = { device: 'gpu' }

async function modelPath() {
  const [name, dir] = await ensureModel({ modelName: MODEL_NAME })
  return path.join(dir, name)
}

function assess(modelPath, config = {}, rest = {}) {
  return EmbedLlamacpp.assessFit({ modelPath, config: { ...GPU, ...config }, ...rest })
}

// The figures depend on what the runner has free, so the assertions are the
// relationships that hold on any machine.
test('a projection is internally consistent', { timeout: 600_000 }, async (t) => {
  const fit = assess(await modelPath())

  t.ok(fit.status === 'fits' || fit.status === 'does-not-fit', 'a verdict, not an error')
  t.ok(fit.devices.length > 0, 'at least the host row')
  t.is(fit.devices.at(-1).name, 'host', 'the host row is last')

  const sum = (rows) =>
    rows.reduce((total, row) => total + row.modelBytes + row.contextBytes + row.computeBytes, 0)
  t.is(fit.hostBytes, sum(fit.devices.slice(-1)), 'hostBytes is the host row')
  t.is(fit.deviceBytes, sum(fit.devices.slice(0, -1)), 'deviceBytes is every other row')
})

test('the context is pinned to the trained context', { timeout: 600_000 }, async (t) => {
  const fit = assess(await modelPath())

  t.comment(`status=${fit.status} ctxSize=${fit.ctxSize} trainCtxSize=${fit.trainCtxSize}`)
  if (fit.status !== 'fits') {
    t.pass('the runner cannot hold this model; the placement assertions do not apply')
    return
  }
  // An embedding load runs at the trained context, so the projection may not
  // report a reduced one.
  t.is(fit.ctxSize, fit.trainCtxSize, 'never reduced below what the load will use')
  t.ok(fit.gpuLayers >= 0, 'a layer count, not llama’s unset default')
})

test('an oversized context is capped at the trained context', { timeout: 600_000 }, async (t) => {
  const fit = assess(await modelPath(), { 'ctx-size': '1000000' })

  if (fit.status === 'error') {
    t.pass('this runner could not project the model')
    return
  }
  t.is(fit.ctxSize, fit.trainCtxSize, 'capped, as the load caps it')
})

test('a pinned layer count survives into the projection', { timeout: 600_000 }, async (t) => {
  const fit = assess(await modelPath(), { 'gpu-layers': '0' })

  t.is(fit.gpuLayers, 0, 'the fitter rewrites defaults, not a value the load pinned')
})

test('a model that cannot be read is an outcome, not a throw', (t) => {
  const fit = assess('/nonexistent/model.gguf')

  t.is(fit.status, 'error')
  t.is(fit.reason, 'model-unreadable')
  t.alike(fit.devices, [])
})

// A setting the engine accepts is a setting the projection accepts.
const EVERY_SETTING = {
  'gpu-layers': '8',
  'batch-size': '256',
  'main-gpu': 'dedicated',
  'split-mode': 'layer',
  'tensor-split': '1',
  'flash-attn': 'auto'
}

const MOBILE_REFUSED = ['main-gpu', 'split-mode', 'tensor-split']

test('every setting a load carries reaches the fitter', { timeout: 600_000 }, async (t) => {
  const file = await modelPath()

  for (const [key, value] of Object.entries(EVERY_SETTING)) {
    const fit = assess(file, { [key]: value })

    if (isMobile && MOBILE_REFUSED.includes(key)) {
      t.is(fit.reason, 'unsupported-config', `${key} is refused on mobile`)
    } else {
      t.not(fit.reason, 'unsupported-config', `${key} is a shape the engine accepts`)
    }
  }
})

test('a context floor that is not a count is refused', { timeout: 600_000 }, async (t) => {
  const fit = assess(await modelPath(), {}, { minCtxSize: -1 })

  t.is(fit.status, 'error')
  t.is(fit.reason, 'unsupported-config')
})

test(
  'a load the engine cannot parse is an outcome, not a throw',
  { timeout: 600_000 },
  async (t) => {
    const fit = assess(await modelPath(), { 'gpu-layers': 'not-a-number' })

    t.is(fit.status, 'error')
    t.is(fit.reason, 'unsupported-config')
  }
)

test('a cpu load is refused', { timeout: 600_000 }, async (t) => {
  const fit = assess(await modelPath(), { device: 'cpu' })

  t.is(fit.status, 'error')
  t.is(fit.reason, 'unsupported-config')
})
