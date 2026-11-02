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

const isVerdict = (fit) => fit.status === 'fits' || fit.status === 'does-not-fit'
const totalUsed = (fit) => fit.devices.reduce((total, row) => total + row.usedBytes, 0)

// The figures depend on what the runner has free, so the assertions are the
// relationships that hold on any machine.
test('a projection lists every device it uses, the host last', { timeout: 600_000 }, async (t) => {
  const fit = await assess(await modelPath())

  t.ok(isVerdict(fit), 'a verdict')
  t.ok(fit.devices.length > 0, 'at least the host row')
  t.is(fit.devices.at(-1).name, 'CPU', 'the host row is last')
  t.is(fit.devices.at(-1).unified, true, 'the host row is unified')
  t.ok(fit.stats.ctxSize > 0, 'the resolved context')
  t.ok(
    Number.isInteger(fit.stats.gpuLayers) && fit.stats.gpuLayers >= 0,
    'the resolved layer count'
  )
  for (const row of fit.devices) {
    t.ok(row.id.length > 0, `${row.name} has an id`)
    t.ok(row.usedBytes >= 0, `${row.name} has a usage`)
    t.ok(row.freeBytes <= row.totalBytes, `${row.name} has free within total`)
  }
  const ids = fit.devices.map((row) => row.id)
  t.is(new Set(ids).size, ids.length, 'one row per device')
})

// An embedding load runs at the trained context: unset, it is pinned there,
// and larger, it is capped there. Both project the same memory.
test('the context is pinned to the trained context', { timeout: 600_000 }, async (t) => {
  const file = await modelPath()
  const pinned = await assess(file, { 'gpu-layers': '0' })
  const oversized = await assess(file, { 'gpu-layers': '0', 'ctx-size': '1000000' })

  t.ok(isVerdict(pinned))
  t.is(oversized.stats.ctxSize, pinned.stats.ctxSize, 'the context is the trained one')
  t.is(
    totalUsed(oversized),
    totalUsed(pinned),
    'an oversized context is capped as the load caps it'
  )
})

test('a pinned layer count survives into the projection', { timeout: 600_000 }, async (t) => {
  const pinned = await assess(await modelPath(), { 'gpu-layers': '0' })

  t.ok(isVerdict(pinned))
  t.is(pinned.stats.gpuLayers, 0, 'the fitter keeps the layer count the load pinned')
})

test('a model that cannot be read rejects', async (t) => {
  await t.exception(assess('/nonexistent/model.gguf'), /\/nonexistent\/model\.gguf/)
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
      await t.exception(fit, `${key} is refused on mobile`)
    } else {
      t.ok(isVerdict(await fit), `${key} is a shape the engine accepts`)
    }
  }
})

test('a context floor that is not a count rejects', { timeout: 600_000 }, async (t) => {
  await t.exception(assess(await modelPath(), {}, { minCtxSize: -1 }), /minCtxSize/)
})

test('a load the engine cannot parse rejects', { timeout: 600_000 }, async (t) => {
  await t.exception(assess(await modelPath(), { 'gpu-layers': 'not-a-number' }))
})

test('a cpu load is unknown', { timeout: 600_000 }, async (t) => {
  const fit = await assess(await modelPath(), { device: 'cpu' })

  t.is(fit.status, 'unknown')
  t.alike(fit.devices, [])
  t.alike(fit.stats, {})
})

// The fitter does not count a projector, so a multimodal load would be
// projected as if it were text only.
test('a multimodal load is unknown', { timeout: 600_000 }, async (t) => {
  const model = await modelPath()

  const withProjector = await assess(model, {}, { projectionModel: '/models/mmproj.gguf' })
  t.is(withProjector.status, 'unknown', 'a projection model is unknown')
  t.alike(withProjector.devices, [])

  await t.exception(
    assess(model, { 'image-max-tokens': '280' }),
    /files\.projectionModel/,
    'projector options need a projection model, as the load does'
  )
  await t.exception(
    assess(model, { 'image-max-tokens': 'many' }),
    /image-max-tokens/,
    'an invalid projector option names the key'
  )
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
    t.ok(isVerdict(fit), 'a real native projection completed')
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
  const [a, b, c] = await Promise.allSettled([first, second, missing])
  t.is(a.status, 'fulfilled')
  t.is(b.status, 'fulfilled')
  t.ok(
    totalUsed(b.value) > totalUsed(a.value),
    'each call owns the config it was given, so the larger context costs more'
  )
  t.is(c.status, 'rejected', 'a rejection does not strand queued callers')
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
    t.ok(isVerdict(result), 'unloading the model did not invalidate the fit backend')
    t.ok(result.devices.length > 0, 'the copied device rows survive backend release')
  } finally {
    await model.unload().catch(() => {})
  }
})
