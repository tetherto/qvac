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

const isVerdict = (fit) => fit.status === 'fits' || fit.status === 'does-not-fit'
const sumUsed = (rows) => rows.reduce((total, row) => total + row.usedBytes, 0)
// Every row but the trailing host row.
const deviceUsed = (fit) => sumUsed(fit.devices.slice(0, -1))
const totalUsed = (fit) => sumUsed(fit.devices)

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

test('a pinned layer count survives into the projection', { timeout: 600_000 }, async (t) => {
  const pinned = await assess(await modelPath(), { 'gpu-layers': '0' })

  t.ok(isVerdict(pinned))
  t.is(pinned.stats.gpuLayers, 0, 'the fitter keeps the layer count the load pinned')
})

test('a pinned context survives into the projection', { timeout: 600_000 }, async (t) => {
  const file = await modelPath()
  const small = await assess(file, { 'gpu-layers': '0', 'ctx-size': '4096' })
  const large = await assess(file, { 'gpu-layers': '0', 'ctx-size': '8192' })

  t.is(small.stats.ctxSize, 4096, 'the fitter keeps the context the load pinned')
  t.ok(totalUsed(large) > totalUsed(small), 'the larger context the load asked for costs more')
})

test('a model that cannot be read rejects', async (t) => {
  await t.exception(assess('/nonexistent/model.gguf'))
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
      await t.exception(fit, `${key} is refused on mobile`)
    } else {
      t.ok(isVerdict(await fit), `${key} is a shape the engine accepts`)
    }
  }
})

test('a context floor that is not a count rejects', { timeout: 600_000 }, async (t) => {
  await t.exception(assess(await modelPath(), {}, { minCtxSize: -1 }))
})

test('a load the engine cannot parse rejects', { timeout: 600_000 }, async (t) => {
  await t.exception(assess(await modelPath(), { 'ctx-size': 'not-a-number' }))
})

test('a cpu load is unknown', { timeout: 600_000 }, async (t) => {
  const fit = await assess(await modelPath(), { device: 'cpu' })

  t.is(fit.status, 'unknown')
  t.alike(fit.devices, [])
  t.alike(fit.stats, {})
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

test(
  'the MTP draft context is counted in the projection',
  { timeout: 600_000, skip: isMobile },
  async (t) => {
    const file = await localModel(MTP_MODEL)
    const plain = await assess(file, PINNED)
    const mtp = await assess(file, { ...PINNED, 'spec-type': 'draft-mtp' })

    t.ok(isVerdict(mtp), 'a verdict')
    t.ok(
      totalUsed(mtp) > totalUsed(plain),
      `the draft context's memory is in the figures (${totalUsed(mtp)} > ${totalUsed(plain)})`
    )
    // The MTP layers add a few percent to the target; counting the shared
    // weights again would double them.
    t.ok(
      totalUsed(mtp) < 1.5 * totalUsed(plain),
      `the shared weights count once (${totalUsed(mtp)} < 1.5 × ${totalUsed(plain)})`
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

    t.ok(isVerdict(mtp), 'a verdict')
    t.ok(
      totalUsed(mtp) > totalUsed(plain),
      `the head is in the figures (${totalUsed(mtp)} > ${totalUsed(plain)})`
    )
  }
)

test(
  'an external head without MTP layers rejects',
  { timeout: 600_000, skip: isMobile },
  async (t) => {
    const file = await localModel(NO_MTP_MODEL)
    await t.exception(
      assess(file, { 'spec-type': 'draft-mtp', 'spec-draft-model': file }),
      'the load fails the same way'
    )
  }
)

test(
  'an external head for another model rejects',
  { timeout: 600_000, skip: isMobile },
  async (t) => {
    // Qwen3's vocabulary differs from the Qwen3.5 head's.
    await t.exception(
      assess(await modelPath(), {
        'spec-type': 'draft-mtp',
        'spec-draft-model': await localModel(MTP_MODEL)
      }),
      'the load fails the same way'
    )
  }
)

test('draft-mtp on a model without MTP layers rejects', { timeout: 600_000 }, async (t) => {
  // Qwen3 has no MTP layers, so the load cannot create the MTP context.
  await t.exception(
    assess(await modelPath(), { 'spec-type': 'draft-mtp' }),
    'the load fails the same way'
  )
})

test('an invalid speculative config rejects', { timeout: 600_000 }, async (t) => {
  await t.exception(
    assess(await modelPath(), {
      'spec-type': 'none',
      'spec-draft-model': path.join(os.tmpdir(), 'draft.gguf')
    }),
    'a draft model needs a speculative type'
  )
})

test('a draft model that is not a file rejects', { timeout: 600_000 }, async (t) => {
  await t.exception(
    assess(await modelPath(), {
      'spec-type': 'draft-dflash',
      'spec-draft-model': os.tmpdir()
    }),
    'the load requires a regular file too'
  )
})

// A margin is free memory the projection may not place into, so one as large
// as the device leaves no room to offload, and the placement matches a load
// that pins no layers. Each projection reads free memory again, and another
// job on a shared GPU moves it between calls, so the margin is sized from the
// device's total, which free never exceeds.
test('the stricter of the two margins binds', { timeout: 600_000 }, async (t) => {
  const file = await modelPath()
  const base = await assess(file)
  const noOffload = await assess(file, { 'gpu-layers': '0' })

  if (base.status !== 'fits' || deviceUsed(base) === deviceUsed(noOffload)) {
    t.pass('this runner offloads nothing, so no margin can reduce the placement')
    return
  }

  // A margin applies to every device, so the largest one sets it.
  const all = Math.max(...base.devices.slice(0, -1).map((device) => device.totalBytes))
  const allMib = `${Math.ceil(all / (1024 * 1024))}`
  const placed = deviceUsed(noOffload)

  t.is(deviceUsed(await assess(file, {}, { marginBytes: all })), placed, 'the caller margin binds')
  t.is(deviceUsed(await assess(file, { 'fit-target': allMib })), placed, 'the load target binds')
  t.is(
    deviceUsed(await assess(file, { 'fit-target': allMib }, { marginBytes: 0 })),
    placed,
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
    t.ok(isVerdict(fit), 'a real native projection completed')
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
    t.ok(isVerdict(first), 'the pinned projection is measured')
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
    t.ok(isVerdict(result), 'unloading the model did not invalidate the fit backend')
    t.ok(result.devices.length > 0, 'the copied device rows survive backend release')
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

const usedMib = (fit) =>
  fit.devices.map((row) => `${row.name}=${(row.usedBytes / 1048576).toFixed(2)}`).join(' ')

for (const name of INPUT_PATH_MODELS) {
  test(
    `the projection grows with the ubatch [${name}]`,
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
        t.ok(isVerdict(fit), `ubatch ${ubatch} is measured`)
        t.comment(`projection ${name} ctx=4096 ubatch=${ubatch} MiB: ${usedMib(fit)}`)
      }
      t.ok(totalUsed(small) > 0, 'memory is projected')
      t.ok(totalUsed(large) >= totalUsed(small), 'a larger ubatch never needs less memory')
    }
  )
}
