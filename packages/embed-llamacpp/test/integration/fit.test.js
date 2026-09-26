'use strict'

const path = require('bare-path')
const test = require('brittle')
const EmbedLlamacpp = require('../../index.js')
const { ensureModel, getModelConfigs } = require('./utils')

const MODEL_NAME = getModelConfigs()[0]?.modelName ?? 'embeddinggemma-300M-Q8_0.gguf'

async function modelPath() {
  const [name, dir] = await ensureModel({ modelName: MODEL_NAME })
  return path.join(dir, name)
}

// The figures depend on what the runner has free, so the assertions are the
// relationships that hold on any machine.
test('a projection is internally consistent', { timeout: 600_000 }, async (t) => {
  const fit = EmbedLlamacpp.assessFit({ modelPath: await modelPath() })

  t.ok(fit.status === 'fits' || fit.status === 'does-not-fit', 'a verdict, not an error')
  t.ok(fit.devices.length > 0, 'at least the host row')
  t.is(fit.devices.at(-1).name, 'host', 'the host row is last')

  const sum = (rows) =>
    rows.reduce((total, row) => total + row.modelBytes + row.contextBytes + row.computeBytes, 0)
  t.is(fit.hostBytes, sum(fit.devices.slice(-1)), 'hostBytes is the host row')
  t.is(fit.deviceBytes, sum(fit.devices.slice(0, -1)), 'deviceBytes is every other row')
})

test('the context is pinned to the trained context', { timeout: 600_000 }, async (t) => {
  const fit = EmbedLlamacpp.assessFit({ modelPath: await modelPath() })

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
  const fit = EmbedLlamacpp.assessFit({
    modelPath: await modelPath(),
    params: { 'ctx-size': '1000000' }
  })

  if (fit.status === 'error') {
    t.pass('the runner could not read the model')
    return
  }
  t.ok(fit.ctxSize <= fit.trainCtxSize, 'capped, as the load caps it')
})

test('a pinned layer count survives into the projection', { timeout: 600_000 }, async (t) => {
  const fit = EmbedLlamacpp.assessFit({
    modelPath: await modelPath(),
    params: { 'gpu-layers': '0' }
  })

  t.is(fit.gpuLayers, 0, 'the fitter rewrites defaults, not a value the load pinned')
})

test('a host-only placement offloads nothing', { timeout: 600_000 }, async (t) => {
  const fit = EmbedLlamacpp.assessFit({
    modelPath: await modelPath(),
    params: { device: 'none' }
  })

  t.comment(`status=${fit.status} gpuLayers=${fit.gpuLayers}`)
  if (fit.status === 'error') {
    t.pass('this runner could not project the model')
    return
  }
  t.is(fit.gpuLayers, 0, 'no device in the placement, so no layer is offloaded')
  t.is(fit.devices.length, 1, 'the host row is the only row')
})

test('a model that cannot be read is an outcome, not a throw', (t) => {
  const fit = EmbedLlamacpp.assessFit({ modelPath: '/nonexistent/model.gguf' })

  t.is(fit.status, 'error')
  t.is(fit.reason, 'model-unreadable')
  t.alike(fit.devices, [])
})

test('an option that would end the process is refused', { timeout: 600_000 }, async (t) => {
  const fit = EmbedLlamacpp.assessFit({
    modelPath: await modelPath(),
    params: { 'list-devices': '' }
  })

  t.is(fit.status, 'error')
  t.is(fit.reason, 'unsupported-config')
})

test('a boolean value llama does not define is refused', { timeout: 600_000 }, async (t) => {
  const fit = EmbedLlamacpp.assessFit({
    modelPath: await modelPath(),
    params: { 'no-kv-offload': 'garbage' }
  })

  t.is(fit.status, 'error')
  t.is(fit.reason, 'unsupported-config')
})

test('a context floor that is not a count is refused', { timeout: 600_000 }, async (t) => {
  const fit = EmbedLlamacpp.assessFit({
    modelPath: await modelPath(),
    minCtxSize: -1
  })

  t.is(fit.status, 'error')
  t.is(fit.reason, 'unsupported-config')
})
