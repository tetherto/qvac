'use strict'

const os = require('bare-os')
const path = require('bare-path')
const test = require('brittle')
const LlmLlamacpp = require('../../index.js')
const { ensureModel } = require('./utils')

const platform = os.platform()
const isMobile = platform === 'ios' || platform === 'android'
const isAndroid = platform === 'android'

const MODEL = {
  name: 'Qwen3-0.6B-Q8_0.gguf',
  url: 'https://huggingface.co/unsloth/Qwen3-0.6B-GGUF/resolve/main/Qwen3-0.6B-Q8_0.gguf'
}

// Every load names a device, so every projection of one does too.
const GPU = { device: 'gpu' }

async function modelPath() {
  const [name, dir] = await ensureModel({
    modelName: MODEL.name,
    downloadUrl: MODEL.url
  })
  return path.join(dir, name)
}

function assess(modelPath, config = {}, rest = {}) {
  return LlmLlamacpp.assessFit({ modelPath, config: { ...GPU, ...config }, ...rest })
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

test('a fitting projection resolves a usable context', { timeout: 600_000 }, async (t) => {
  const fit = assess(await modelPath())

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
  const fit = assess(await modelPath(), { 'gpu-layers': '0' })

  t.is(fit.gpuLayers, 0, 'the fitter rewrites defaults, not a value the load pinned')
})

test('a pinned context survives into the projection', { timeout: 600_000 }, async (t) => {
  const fit = assess(await modelPath(), { 'ctx-size': '4096' })

  t.is(fit.ctxSize, 4096, 'the fitter reports the context the load asked for')
})

test('a full offload counts the output layer', { timeout: 600_000 }, async (t) => {
  const fit = assess(await modelPath())

  // A device row is listed even when its free memory holds no layer.
  if (fit.status !== 'fits' || fit.gpuLayers === 0) {
    t.pass('this runner placed nothing on a device')
    return
  }
  // llama resolves an unset layer count to every layer plus the output layer.
  const placed = fit.devices.slice(0, -1).filter((row) => row.modelBytes > 0)
  t.ok(placed.length > 0, 'a device holds weights')
  t.ok(fit.gpuLayers > 1, 'more than the output layer alone')
})

test('the context floor is honoured', { timeout: 600_000 }, async (t) => {
  const fit = assess(await modelPath(), {}, { minCtxSize: 4096 })

  if (fit.status !== 'fits') {
    t.pass('the runner cannot hold this model at the floor')
    return
  }
  t.ok(fit.ctxSize >= 4096, 'not reduced below the floor')
})

test('a model that cannot be read is an outcome, not a throw', (t) => {
  const fit = assess('/nonexistent/model.gguf')

  t.is(fit.status, 'error')
  t.is(fit.reason, 'model-unreadable')
  t.alike(fit.devices, [])
})

// A setting the engine accepts is a setting the projection accepts.
const EVERY_SETTING = {
  'ctx-size': '4096',
  'gpu-layers': '8',
  load_mode: 'mmap',
  parallel: '2',
  'batch-size': '256',
  'ubatch-size': '128',
  'cache-type-k': 'q8_0',
  'cache-type-v': 'q8_0',
  'main-gpu': 'dedicated',
  'split-mode': 'layer',
  'tensor-split': '1',
  'flash-attn': 'auto',
  'cpu-moe': '',
  'n-cpu-moe': '1',
  'n-cpu-ffn': '1',
  'override-tensor': 'ffn_.*=CPU',
  'prefetch-weights': 'auto',
  'fit-ctx': '2048'
}

const MOBILE_REFUSED = ['main-gpu', 'split-mode', 'tensor-split']

const ANDROID_GPU_DEPENDENT = ['cache-type-k', 'cache-type-v']

test('every setting a load carries reaches the fitter', { timeout: 600_000 }, async (t) => {
  const file = await modelPath()

  for (const [key, value] of Object.entries(EVERY_SETTING)) {
    if (isAndroid && ANDROID_GPU_DEPENDENT.includes(key)) {
      t.comment(`Skipping ${key}: depends on the GPU vendor on Android`)
      continue
    }

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
    const fit = assess(await modelPath(), { 'ctx-size': 'not-a-number' })

    t.is(fit.status, 'error')
    t.is(fit.reason, 'unsupported-config')
  }
)

test('a cpu load is refused', { timeout: 600_000 }, async (t) => {
  const fit = assess(await modelPath(), { device: 'cpu' })

  t.is(fit.status, 'error')
  t.is(fit.reason, 'unsupported-config')
})

// A margin is free memory the projection may not place into, so one as large
// as the device leaves no room to offload. Each projection reads free memory
// again, and another job on a shared GPU moves it between calls, so the
// margin is sized from the device's total, which free never exceeds.
test('the stricter of the two margins binds', { timeout: 600_000 }, async (t) => {
  const file = await modelPath()
  const base = assess(file)

  if (base.status !== 'fits' || base.gpuLayers === 0) {
    t.pass('this runner offloads nothing, so no margin can reduce the placement')
    return
  }

  // A margin applies to every device, so the largest one sets it.
  const all = Math.max(
    ...base.devices.filter((device) => device.name !== 'host').map((device) => device.totalBytes)
  )
  const allMib = `${Math.ceil(all / (1024 * 1024))}`

  t.is(assess(file, {}, { marginBytes: all }).gpuLayers, 0, 'the caller margin binds')
  t.is(assess(file, { 'fit-target': allMib }).gpuLayers, 0, 'the load target binds')
  t.is(
    assess(file, { 'fit-target': allMib }, { marginBytes: 0 }).gpuLayers,
    0,
    'a slack caller margin does not loosen the load target'
  )
})
