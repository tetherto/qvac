'use strict'

const path = require('bare-path')
const test = require('brittle')
const LlmLlamacpp = require('../../index.js')
const { ensureModel } = require('./utils')

const MODEL = {
  name: 'Qwen3-0.6B-Q8_0.gguf',
  url: 'https://huggingface.co/unsloth/Qwen3-0.6B-GGUF/resolve/main/Qwen3-0.6B-Q8_0.gguf'
}

async function modelPath() {
  const [name, dir] = await ensureModel({
    modelName: MODEL.name,
    downloadUrl: MODEL.url
  })
  return path.join(dir, name)
}

// The figures depend on what the runner has free, so the assertions are the
// relationships that hold on any machine.
test('a projection is internally consistent', { timeout: 600_000 }, async (t) => {
  const fit = LlmLlamacpp.assessFit({ modelPath: await modelPath() })

  t.ok(fit.status === 'fits' || fit.status === 'does-not-fit', 'a verdict, not an error')
  t.ok(fit.devices.length > 0, 'at least the host row')
  t.is(fit.devices.at(-1).name, 'host', 'the host row is last')

  const sum = (rows) =>
    rows.reduce((total, row) => total + row.modelBytes + row.contextBytes + row.computeBytes, 0)
  t.is(fit.hostBytes, sum(fit.devices.slice(-1)), 'hostBytes is the host row')
  t.is(fit.deviceBytes, sum(fit.devices.slice(0, -1)), 'deviceBytes is every other row')
})

test('a fitting projection resolves a usable context', { timeout: 600_000 }, async (t) => {
  const fit = LlmLlamacpp.assessFit({ modelPath: await modelPath() })

  t.comment(`status=${fit.status} ctxSize=${fit.ctxSize} gpuLayers=${fit.gpuLayers}`)
  if (fit.status !== 'fits') {
    t.pass('the runner cannot hold this model; the placement assertions do not apply')
    return
  }
  t.ok(fit.ctxSize > 0, 'a context was resolved')
  t.ok(fit.ctxSize <= fit.trainCtxSize, 'never above the trained context')
  t.ok(fit.gpuLayers >= 0, 'a layer count, not llama’s unset default')
})

test('a pinned layer count survives into the projection', { timeout: 600_000 }, async (t) => {
  const fit = LlmLlamacpp.assessFit({
    modelPath: await modelPath(),
    params: { 'gpu-layers': '0' }
  })

  t.is(fit.gpuLayers, 0, 'the fitter rewrites defaults, not a value the load pinned')
})

test('a host-only placement offloads nothing', { timeout: 600_000 }, async (t) => {
  const fit = LlmLlamacpp.assessFit({
    modelPath: await modelPath(),
    params: { device: 'none' }
  })

  t.comment(`status=${fit.status} gpuLayers=${fit.gpuLayers}`)
  if (fit.status === 'error') {
    t.pass('this runner could not project the model')
    return
  }
  t.is(fit.gpuLayers, 0, 'no device in the placement, so no layer is offloaded')
  t.is(fit.devices.at(-1).name, 'host', 'the host row is the only row')
  t.is(fit.devices.length, 1, 'no device rows')
})

test('a full offload counts the output layer', { timeout: 600_000 }, async (t) => {
  const fit = LlmLlamacpp.assessFit({ modelPath: await modelPath() })

  if (fit.status !== 'fits' || fit.devices.length <= 1) {
    t.pass('this runner placed nothing on a device')
    return
  }
  // llama resolves an unset layer count to every layer plus the output layer.
  const placed = fit.devices.slice(0, -1).filter((row) => row.modelBytes > 0)
  t.ok(placed.length > 0, 'a device holds weights')
  t.ok(fit.gpuLayers > 1, 'more than the output layer alone')
})

test('the context floor is honoured', { timeout: 600_000 }, async (t) => {
  const fit = LlmLlamacpp.assessFit({
    modelPath: await modelPath(),
    minCtxSize: 4096
  })

  if (fit.status !== 'fits') {
    t.pass('the runner cannot hold this model at the floor')
    return
  }
  t.ok(fit.ctxSize >= 4096, 'not reduced below the floor')
})

test('a model that cannot be read is an outcome, not a throw', (t) => {
  const fit = LlmLlamacpp.assessFit({ modelPath: '/nonexistent/model.gguf' })

  t.is(fit.status, 'error')
  t.is(fit.reason, 'model-unreadable')
  t.alike(fit.devices, [])
})

test('an option that would end the process is refused', { timeout: 600_000 }, async (t) => {
  const fit = LlmLlamacpp.assessFit({
    modelPath: await modelPath(),
    params: { 'list-devices': '' }
  })

  t.is(fit.status, 'error')
  t.is(fit.reason, 'unsupported-config')
})

test('a boolean value llama does not define is refused', { timeout: 600_000 }, async (t) => {
  const fit = LlmLlamacpp.assessFit({
    modelPath: await modelPath(),
    params: { 'no-kv-offload': 'garbage' }
  })

  t.is(fit.status, 'error')
  t.is(fit.reason, 'unsupported-config')
})

test('contradictory spellings of one option are refused', { timeout: 600_000 }, async (t) => {
  const fit = LlmLlamacpp.assessFit({
    modelPath: await modelPath(),
    params: { 'kv-offload': 'on', 'no-kv-offload': 'on' }
  })

  t.is(fit.status, 'error')
  t.is(fit.reason, 'unsupported-config')
})

test('a context floor that is not a count is refused', { timeout: 600_000 }, async (t) => {
  const fit = LlmLlamacpp.assessFit({
    modelPath: await modelPath(),
    minCtxSize: -1
  })

  t.is(fit.status, 'error')
  t.is(fit.reason, 'unsupported-config')
})
