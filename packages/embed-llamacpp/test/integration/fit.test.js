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
  const fit = await assess(await modelPath())

  t.ok(fit.status === 'fits' || fit.status === 'does-not-fit', 'a verdict, not an error')
  t.ok(fit.devices.length > 0, 'at least the host row')
  t.is(fit.devices.at(-1).name, 'host', 'the host row is last')

  const sum = (rows) =>
    rows.reduce((total, row) => total + row.modelBytes + row.contextBytes + row.computeBytes, 0)
  t.is(fit.hostBytes, sum(fit.devices.slice(-1)), 'hostBytes is the host row')
  t.is(fit.deviceBytes, sum(fit.devices.slice(0, -1)), 'deviceBytes is every other row')
})

test('the context is pinned to the trained context', { timeout: 600_000 }, async (t) => {
  const fit = await assess(await modelPath())

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
  const fit = await assess(await modelPath(), { 'ctx-size': '1000000' })

  if (fit.status === 'error') {
    t.pass('this runner could not project the model')
    return
  }
  t.is(fit.ctxSize, fit.trainCtxSize, 'capped, as the load caps it')
})

test('a pinned layer count survives into the projection', { timeout: 600_000 }, async (t) => {
  const fit = await assess(await modelPath(), { 'gpu-layers': '0' })

  t.is(fit.gpuLayers, 0, 'the fitter rewrites defaults, not a value the load pinned')
})

test('a model that cannot be read is an outcome, not a throw', async (t) => {
  const fit = await assess('/nonexistent/model.gguf')

  t.is(fit.status, 'error')
  t.is(fit.reason, 'model-unreadable')
  t.ok(fit.message.includes('/nonexistent/model.gguf'), 'the message names the file')
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
    const fit = await assess(file, { [key]: value })

    if (isMobile && MOBILE_REFUSED.includes(key)) {
      t.is(fit.reason, 'unsupported-config', `${key} is refused on mobile`)
    } else {
      t.not(fit.reason, 'unsupported-config', `${key} is a shape the engine accepts`)
    }
  }
})

test('a context floor that is not a count is refused', { timeout: 600_000 }, async (t) => {
  const fit = await assess(await modelPath(), {}, { minCtxSize: -1 })

  t.is(fit.status, 'error')
  t.is(fit.reason, 'unsupported-config')
  t.ok(fit.message.includes('minCtxSize'), 'the message names the field')
})

test(
  'a load the engine cannot parse is an outcome, not a throw',
  { timeout: 600_000 },
  async (t) => {
    const fit = await assess(await modelPath(), { 'gpu-layers': 'not-a-number' })

    t.is(fit.status, 'error')
    t.is(fit.reason, 'unsupported-config')
    t.ok(fit.message.length > 0, `a message is given: ${fit.message}`)
  }
)

test('a cpu load is refused', { timeout: 600_000 }, async (t) => {
  const fit = await assess(await modelPath(), { device: 'cpu' })

  t.is(fit.status, 'error')
  t.is(fit.reason, 'unsupported-config')
  t.ok(fit.message.startsWith('device:'), 'the message names the key')
})

// The fitter does not count a projector, so a multimodal load would be
// projected as if it were text only.
test('a multimodal load is refused', { timeout: 600_000 }, async (t) => {
  const model = await modelPath()

  const withProjector = await assess(model, {}, { projectionModel: '/models/mmproj.gguf' })
  t.is(withProjector.status, 'error')
  t.is(withProjector.reason, 'unsupported-config', 'a projection model is refused')
  t.ok(withProjector.message.startsWith('projectionModel:'), 'the message names the field')

  const withOptions = await assess(model, { 'image-max-tokens': '280' })
  t.is(withOptions.status, 'error')
  t.is(withOptions.reason, 'unsupported-config', 'projector options are refused')
  t.ok(withOptions.message.includes('files.projectionModel'), 'the message says what they need')

  const invalid = await assess(model, { 'image-max-tokens': 'many' })
  t.is(invalid.reason, 'unsupported-config', 'an invalid projector option is refused')
  t.ok(invalid.message.includes('image-max-tokens'), 'the message names the key')
})

test('fitting keeps the event loop responsive', { timeout: 600_000 }, async (t) => {
  const file = await modelPath()
  let pending = true
  let ticks = 0
  const timer = setInterval(() => {
    if (pending) ticks++
  }, 1)
  try {
    const fit = await assess(file)
    pending = false
    t.not(fit.status, 'error', 'a real native projection completed')
    t.absent(fit.message, 'a verdict carries no message')
    t.ok(ticks > 0, 'timers ran before fitting settled')
    t.comment(`${ticks} timer ticks before completion`)
  } finally {
    pending = false
    clearInterval(timer)
  }
})

test('queued fits retain independent requests and all settle', { timeout: 600_000 }, async (t) => {
  const request = {
    modelPath: await modelPath(),
    config: { ...GPU, 'gpu-layers': '0', 'ctx-size': '512' }
  }
  const first = EmbedLlamacpp.assessFit(request)
  request.config['ctx-size'] = '1024'
  const second = EmbedLlamacpp.assessFit(request)
  const missing = EmbedLlamacpp.assessFit({ modelPath: '/nonexistent/model.gguf' })
  const [a, b, c] = await Promise.all([first, second, missing])
  t.not(a.status, 'error')
  t.not(b.status, 'error')
  t.is(a.ctxSize, 512, 'the first call owns its original config')
  t.is(b.ctxSize, 1024, 'the second call owns its changed config')
  t.is(c.reason, 'model-unreadable', 'an error outcome does not strand queued callers')
})

test('a broken request rejects', async (t) => {
  const promise = EmbedLlamacpp.assessFit({})
  t.ok(promise instanceof Promise)
  await t.exception.all(promise)
})

test('a fit retains the backend while a loaded model unloads', { timeout: 600_000 }, async (t) => {
  const file = await modelPath()
  const model = new EmbedLlamacpp({
    files: { model: [file] },
    config: { device: 'cpu', gpu_layers: '0', ctx_size: '512' }
  })
  try {
    await model.load()
    const fit = assess(file)
    await model.unload()
    const result = await fit
    t.not(result.status, 'error', 'unloading the model did not invalidate the fit backend')
    t.ok(result.devices.length > 0, 'the copied device breakdown survives backend release')
  } finally {
    await model.unload().catch(() => {})
  }
})
