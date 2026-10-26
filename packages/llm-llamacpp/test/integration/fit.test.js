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
  const fit = await assess(await modelPath())

  t.ok(fit.status === 'fits' || fit.status === 'does-not-fit', 'a verdict, not an error')
  t.ok(fit.devices.length > 0, 'at least the host row')
  t.is(fit.devices.at(-1).name, 'host', 'the host row is last')

  const sum = (rows) =>
    rows.reduce((total, row) => total + row.modelBytes + row.contextBytes + row.computeBytes, 0)
  t.is(fit.hostBytes, sum(fit.devices.slice(-1)), 'hostBytes is the host row')
  t.is(fit.deviceBytes, sum(fit.devices.slice(0, -1)), 'deviceBytes is every other row')
})

test('a fitting projection resolves a usable context', { timeout: 600_000 }, async (t) => {
  const fit = await assess(await modelPath())

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
  const fit = await assess(await modelPath(), { 'gpu-layers': '0' })

  t.is(fit.gpuLayers, 0, 'the fitter rewrites defaults, not a value the load pinned')
})

test('a pinned context survives into the projection', { timeout: 600_000 }, async (t) => {
  const fit = await assess(await modelPath(), { 'ctx-size': '4096' })

  t.is(fit.ctxSize, 4096, 'the fitter reports the context the load asked for')
})

test('a full offload counts the output layer', { timeout: 600_000 }, async (t) => {
  const fit = await assess(await modelPath())

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
  const fit = await assess(await modelPath(), {}, { minCtxSize: 4096 })

  if (fit.status !== 'fits') {
    t.pass('the runner cannot hold this model at the floor')
    return
  }
  t.ok(fit.ctxSize >= 4096, 'not reduced below the floor')
})

test('a model that cannot be read is an outcome, not a throw', async (t) => {
  const fit = await assess('/nonexistent/model.gguf')

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
})

test(
  'a load the engine cannot parse is an outcome, not a throw',
  { timeout: 600_000 },
  async (t) => {
    const fit = await assess(await modelPath(), { 'ctx-size': 'not-a-number' })

    t.is(fit.status, 'error')
    t.is(fit.reason, 'unsupported-config')
  }
)

test('a cpu load is refused', { timeout: 600_000 }, async (t) => {
  const fit = await assess(await modelPath(), { device: 'cpu' })

  t.is(fit.status, 'error')
  t.is(fit.reason, 'unsupported-config')
})

// ggml-org's quant keeps the MTP layers; unsloth's strips them, so the
// ggml-org quant serves as its external head.
// prestage-ignore: Qwen3.5-0.8B-MTP-Q8_0.gguf — desktop-only; the test skips on mobile
const MTP_MODEL = 'Qwen3.5-0.8B-MTP-Q8_0.gguf'
const NO_MTP_MODEL = 'Qwen3.5-0.8B-Q8_0.gguf'

// A pinned context and placement keep two projections comparable.
const PINNED = { 'ctx-size': '4096', 'gpu-layers': '0' }

async function localModel(modelName) {
  const [name, dir] = await ensureModel({ modelName })
  return path.join(dir, name)
}

const totalOf = (fit, field) => fit.devices.reduce((total, row) => total + row[field], 0)

test(
  'the MTP draft context is counted in the projection',
  { timeout: 600_000, skip: isMobile },
  async (t) => {
    const file = await localModel(MTP_MODEL)
    const plain = await assess(file, PINNED)
    const mtp = await assess(file, { ...PINNED, 'spec-type': 'draft-mtp' })

    t.ok(mtp.status === 'fits' || mtp.status === 'does-not-fit', 'a verdict, not an error')
    const context = (fit) => totalOf(fit, 'contextBytes')
    t.ok(
      context(mtp) > context(plain),
      `the draft context's memory is in the figures (${context(mtp)} > ${context(plain)})`
    )
    // The MTP layers add a few percent to the target; counting the shared
    // weights again would double them.
    const weights = (fit) => totalOf(fit, 'modelBytes')
    t.ok(
      weights(mtp) < 1.5 * weights(plain),
      `the shared weights count once (${weights(mtp)} < 1.5 × ${weights(plain)})`
    )
  }
)

test(
  'an external MTP head is counted in the projection',
  { timeout: 600_000, skip: isMobile },
  async (t) => {
    const file = await localModel(NO_MTP_MODEL)
    const plain = await assess(file, PINNED)
    const mtp = await assess(file, {
      ...PINNED,
      'spec-type': 'draft-mtp',
      'spec-draft-model': await localModel(MTP_MODEL)
    })

    t.ok(mtp.status === 'fits' || mtp.status === 'does-not-fit', 'a verdict, not an error')
    for (const field of ['modelBytes', 'contextBytes']) {
      t.ok(
        totalOf(mtp, field) > totalOf(plain, field),
        `the head's ${field} are in the figures (${totalOf(mtp, field)} > ${totalOf(plain, field)})`
      )
    }
  }
)

test(
  'an external head without MTP layers is refused',
  { timeout: 600_000, skip: isMobile },
  async (t) => {
    const file = await localModel(NO_MTP_MODEL)
    const fit = await assess(file, { 'spec-type': 'draft-mtp', 'spec-draft-model': file })

    t.is(fit.status, 'error')
    t.is(fit.reason, 'unsupported-config', 'the load fails the same way')
  }
)

test(
  'an external head for another model is refused',
  { timeout: 600_000, skip: isMobile },
  async (t) => {
    // Qwen3's vocabulary differs from the Qwen3.5 head's.
    const fit = await assess(await modelPath(), {
      'spec-type': 'draft-mtp',
      'spec-draft-model': await localModel(MTP_MODEL)
    })

    t.is(fit.status, 'error')
    t.is(fit.reason, 'unsupported-config', 'the load fails the same way')
  }
)

test('draft-mtp on a model without MTP layers is refused', { timeout: 600_000 }, async (t) => {
  // Qwen3 has no MTP layers, so the load cannot create the MTP context.
  const fit = await assess(await modelPath(), { 'spec-type': 'draft-mtp' })

  t.is(fit.status, 'error')
  t.is(fit.reason, 'unsupported-config', 'the load fails the same way')
})

test('an invalid speculative config is refused', { timeout: 600_000 }, async (t) => {
  const fit = await assess(await modelPath(), {
    'spec-type': 'none',
    'spec-draft-model': path.join(os.tmpdir(), 'draft.gguf')
  })

  t.is(fit.status, 'error')
  t.is(fit.reason, 'unsupported-config', 'a draft model needs a speculative type')
})

test('a draft model that is not a file is unreadable', { timeout: 600_000 }, async (t) => {
  const fit = await assess(await modelPath(), {
    'spec-type': 'draft-dflash',
    'spec-draft-model': os.tmpdir()
  })

  t.is(fit.status, 'error')
  t.is(fit.reason, 'model-unreadable', 'the load requires a regular file too')
})

// A margin is free memory the projection may not place into, so one as large
// as the device leaves no room to offload. Each projection reads free memory
// again, and another job on a shared GPU moves it between calls, so the
// margin is sized from the device's total, which free never exceeds.
test('the stricter of the two margins binds', { timeout: 600_000 }, async (t) => {
  const file = await modelPath()
  const base = await assess(file)

  if (base.status !== 'fits' || base.gpuLayers === 0) {
    t.pass('this runner offloads nothing, so no margin can reduce the placement')
    return
  }

  // A margin applies to every device, so the largest one sets it.
  const all = Math.max(
    ...base.devices.filter((device) => device.name !== 'host').map((device) => device.totalBytes)
  )
  const allMib = `${Math.ceil(all / (1024 * 1024))}`

  t.is((await assess(file, {}, { marginBytes: all })).gpuLayers, 0, 'the caller margin binds')
  t.is((await assess(file, { 'fit-target': allMib })).gpuLayers, 0, 'the load target binds')
  t.is(
    (await assess(file, { 'fit-target': allMib }, { marginBytes: 0 })).gpuLayers,
    0,
    'a slack caller margin does not loosen the load target'
  )
})

test('fitting keeps the event loop and logger responsive', { timeout: 600_000 }, async (t) => {
  const file = await modelPath()
  const { setLogger, releaseLogger } = require('../../addonLogging.js')
  const model = new LlmLlamacpp({
    files: { model: [file] },
    config: { device: 'cpu', ctx_size: '1024', verbosity: '3' }
  })
  let pending = false
  let ticks = 0
  let logs = 0
  let timer
  setLogger((_priority, message) => {
    if (pending && message.includes('[Llama.cpp]')) logs++
  })
  try {
    // Enable native logging through the load config before measuring the fit.
    await model.load()
    await new Promise((resolve) => setImmediate(resolve))
    pending = true
    timer = setInterval(() => {
      if (pending) ticks++
    }, 1)
    const fit = await assess(file)
    pending = false
    t.not(fit.status, 'error', 'a real native projection completed')
    t.ok(ticks > 0, 'timers ran before fitting settled')
    t.ok(logs > 0, 'native logs drained before fitting settled')
    t.comment(`${ticks} timer ticks and ${logs} native logs before completion`)
  } finally {
    pending = false
    clearInterval(timer)
    try {
      await model.unload()
    } finally {
      releaseLogger()
    }
  }
})

test(
  'concurrent fits of a pinned request return the same projection',
  { timeout: 600_000 },
  async (t) => {
    const request = {
      modelPath: await modelPath(),
      config: { ...GPU, 'gpu-layers': '0', 'ctx-size': '4096' }
    }
    const [first, second] = await Promise.all([
      LlmLlamacpp.assessFit(request),
      LlmLlamacpp.assessFit(request)
    ])
    // Free memory is sampled independently by each call.
    const projection = (fit) => ({
      ...fit,
      devices: fit.devices.map(({ freeBytes, ...row }) => row)
    })
    t.not(first.status, 'error', 'the pinned projection is measured')
    t.alike(projection(second), projection(first), 'serialised fits do not disturb each other')
  }
)

test('queued fits retain independent requests and all settle', { timeout: 600_000 }, async (t) => {
  const request = {
    modelPath: await modelPath(),
    config: { ...GPU, 'gpu-layers': '0', 'ctx-size': '4096' }
  }
  const first = LlmLlamacpp.assessFit(request)
  request.config['ctx-size'] = '8192'
  const second = LlmLlamacpp.assessFit(request)
  const missing = assess('/nonexistent/model.gguf')
  const [a, b, c] = await Promise.all([first, second, missing])
  t.not(a.status, 'error')
  t.not(b.status, 'error')
  t.is(a.ctxSize, 4096, 'the first call owns its original config')
  t.is(b.ctxSize, 8192, 'the second call owns its changed config')
  t.is(c.reason, 'model-unreadable', 'an error outcome does not strand queued callers')
})

test('a broken request rejects', async (t) => {
  const promise = LlmLlamacpp.assessFit({})
  t.ok(promise instanceof Promise)
  await t.exception.all(promise)
})

test('a fit retains the backend while a loaded model unloads', { timeout: 600_000 }, async (t) => {
  const file = await modelPath()
  const model = new LlmLlamacpp({
    files: { model: [file] },
    config: { device: 'cpu', ctx_size: '1024' }
  })
  try {
    await model.load()
    const fit = assess(file)
    await model.unload()
    const result = await fit
    t.not(result.status, 'error', 'unloading the model did not invalidate the fit backend')
    t.ok(result.devices.length > 0, 'the copied device breakdown survives backend release')
  } finally {
    await model.unload()
  }
})

// qwen35 reserves an unused mixed token/embd input branch; gemma4 also scales
// token rows through a per-row input. The figures are logged for comparison
// across fabric versions; the assertions hold on any runner.
// prestage-ignore: Qwen3.5-0.8B-Q8_0.gguf — desktop-only, skipped on mobile
// prestage-ignore: google_gemma-4-E2B-it-Q4_K_M.gguf — desktop-only, skipped on mobile
const INPUT_PATH_MODELS = ['Qwen3.5-0.8B-Q8_0.gguf', 'google_gemma-4-E2B-it-Q4_K_M.gguf']

const computeBytes = (fit) => fit.devices.reduce((sum, row) => sum + row.computeBytes, 0)
const computeMib = (fit) =>
  fit.devices.map((row) => `${row.name}=${(row.computeBytes / 1048576).toFixed(2)}`).join(' ')

for (const name of INPUT_PATH_MODELS) {
  test(
    `the compute projection grows with the ubatch [${name}]`,
    { timeout: 600_000, skip: isMobile },
    async (t) => {
      const [file, dir] = await ensureModel({ modelName: name })
      const project = (ubatch) =>
        assess(path.join(dir, file), {
          'gpu-layers': '999',
          'ctx-size': '4096',
          'batch-size': '512',
          'ubatch-size': ubatch
        })

      const small = await project('128')
      const large = await project('512')
      for (const [ubatch, fit] of [
        ['128', small],
        ['512', large]
      ]) {
        t.not(fit.status, 'error', `ubatch ${ubatch} is measured`)
        t.comment(`compute-projection ${name} ctx=4096 ubatch=${ubatch} MiB: ${computeMib(fit)}`)
      }
      t.ok(computeBytes(small) > 0, 'a compute buffer is projected')
      t.ok(computeBytes(large) >= computeBytes(small), 'a larger ubatch never needs less compute')
    }
  )
}
