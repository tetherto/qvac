'use strict'

const fs = require('bare-fs')
const os = require('bare-os')
const path = require('bare-path')
const proc = require('bare-process')
const test = require('brittle')

const { assessFit } = require('../../index.js')
const { ensureModelPath, safeTest } = require('./utils')

const MODEL_NAME = 'stable-diffusion-v2-1-Q8_0.gguf'

const isMobile = os.platform() === 'ios' || os.platform() === 'android'
const skip = isMobile || (proc.env && proc.env.NO_GPU === 'true')

function tempFile(t, name, contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-fit-'))
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }))
  const filePath = path.join(dir, name)
  fs.writeFileSync(filePath, contents)
  return filePath
}

function esrganHeader(t, scale = 4) {
  const header = {}
  let offset = 0
  function convolution(name, input, output) {
    for (const [suffix, shape, dtype] of [
      ['weight', [output, input, 3, 3], 'F16'],
      ['bias', [output], 'F32']
    ]) {
      const bytes = shape.reduce((size, dim) => size * dim, dtype === 'F16' ? 2 : 4)
      header[`${name}.${suffix}`] = { dtype, shape, data_offsets: [offset, offset + bytes] }
      offset += bytes
    }
  }
  convolution('conv_first', 3, 64)
  for (let block = 1; block <= 3; block++) {
    for (let layer = 1; layer <= 5; layer++) {
      convolution(`body.0.rdb${block}.conv${layer}`, 64 + (layer - 1) * 32, layer === 5 ? 64 : 32)
    }
  }
  for (const name of [
    'conv_body',
    ...(scale >= 2 ? ['conv_up1'] : []),
    ...(scale === 4 ? ['conv_up2'] : []),
    'conv_hr'
  ]) {
    convolution(name, 64, 64)
  }
  convolution('conv_last', 64, 3)
  const json = Buffer.from(JSON.stringify(header))
  const length = Buffer.alloc(8)
  length.writeBigUInt64LE(BigInt(json.length))
  return tempFile(t, 'esrgan.fit.safetensors', Buffer.concat([length, json]))
}

const MiB = 1024 * 1024

function hostRow(fit) {
  return fit.devices[fit.devices.length - 1]
}

test('standalone ESRGAN projects a CPU load from headers without weights', async (t) => {
  const esrgan = esrganHeader(t)
  const fit = await assessFit({
    mode: 'upscale',
    files: { esrgan },
    config: { device: 'cpu', upscaler_tile_size: 16 },
    workload: { width: 128, height: 96, upscaleRepeats: 2 }
  })
  t.is(fit.status, 'fits')
  t.alike(fit.stats, {})
  t.is(fit.devices.length, 1, 'a CPU load is one host row')
  const host = hostRow(fit)
  t.ok(host.unified, 'the host row is host memory')
  t.ok(host.id.length > 0 && host.name.length > 0)
  t.ok(host.usedBytes > 0, 'the weights and image buffers are charged')
  t.ok(host.freeBytes > 0 && host.totalBytes >= host.freeBytes)
})

test('standalone ESRGAN validates paths and workload numbers', async (t) => {
  await t.exception.all(
    () => assessFit({ mode: 'upscale', files: { esrgan: 'relative.safetensors' } }),
    {
      name: 'TypeError',
      message: 'files.esrgan must be an absolute path (got: relative.safetensors)'
    }
  )
  await t.exception.all(() => assessFit({ mode: 'upscale', files: {} }), {
    name: 'TypeError',
    message: 'files.esrgan must be an absolute path string'
  })
  await t.exception.all(() => assessFit({ mode: 'esrgan', files: {} }), {
    name: 'TypeError',
    message: 'unsupported fit mode: esrgan'
  })
  const esrgan = esrganHeader(t)
  for (const workload of [{ upscaleRepeats: 0 }, { upscaleRepeats: 1.5 }, { width: Infinity }]) {
    await t.exception.all(assessFit({ mode: 'upscale', files: { esrgan }, workload }), {
      message: /workload\.\w+ is out of range/
    })
  }
  await t.exception.all(
    assessFit({ mode: 'upscale', files: { esrgan: '/missing/esrgan.safetensors' } }),
    { message: /cannot read the model/ }
  )
})

test('standalone ESRGAN sizes full-image RAM even when tiles stay small', async (t) => {
  const esrgan = esrganHeader(t)
  const request = {
    mode: 'upscale',
    files: { esrgan },
    config: { device: 'cpu', upscaler_tile_size: 16, max_image_pixels: 268435456 }
  }
  const small = await assessFit({ ...request, workload: { width: 128, height: 96 } })
  const large = await assessFit({ ...request, workload: { width: 4096, height: 4096 } })
  t.is(small.status, 'fits')
  const repeated = await assessFit({
    ...request,
    workload: { width: 1024, height: 1024, upscaleRepeats: 2 }
  })
  const hostMiB = (fit) => hostRow(fit).usedBytes / MiB
  t.ok(hostMiB(large) >= 4080, 'the full image buffers need 4080 MiB despite small tiles')
  t.ok(hostMiB(repeated) >= 4083, 'repeated scaling includes intermediate and final images')
  t.ok(hostMiB(large) > hostMiB(small))
})

test('ESRGAN fit enforces the runtime output limits', async (t) => {
  const esrgan = esrganHeader(t)
  const overLimit = { message: /exceeds the pixel limit/ }
  for (const workload of [
    { width: 1024, height: 1024, upscaleRepeats: 2 },
    { width: 4097, height: 1 }
  ]) {
    await t.exception.all(assessFit({ mode: 'upscale', files: { esrgan }, workload }), overLimit)
  }
  await t.exception.all(
    assessFit({
      mode: 'upscale',
      files: { esrgan },
      config: { max_image_pixels: 1000 },
      workload: { width: 16, height: 16 }
    }),
    overLimit,
    'a configured pixel limit also applies to fit'
  )
  for (const scale of [1, 2, 4]) {
    const scaled = assessFit({
      mode: 'upscale',
      files: { esrgan: esrganHeader(t, scale) },
      config: { device: 'cpu', max_image_pixels: 1000 },
      workload: { width: 16, height: 16 }
    })
    if (scale === 1) {
      t.is((await scaled).status, 'fits', '1x checkpoint stays within the limit')
    } else {
      await t.exception.all(scaled, overLimit, `${scale}x checkpoint exceeds the limit`)
    }
  }
})

test('an unreadable model rejects', async (t) => {
  await t.exception.all(assessFit({ files: { model: '/nonexistent/model.gguf' } }), {
    message: /cannot read the model/
  })
})

test('world fit validates its companion paths and session length', async (t) => {
  const files = {
    model: '/missing/abot.gguf',
    taehv: '/missing/taehv.gguf',
    scene: '/missing/scene.safetensors'
  }
  for (const key of ['taehv', 'scene']) {
    await t.exception.all(
      () => assessFit({ mode: 'world', files: { ...files, [key]: 'relative.file' } }),
      TypeError
    )
  }
  for (const walkSteps of [0, -1, 1.5, Infinity, 1000001]) {
    await t.exception.all(assessFit({ mode: 'world', files, workload: { walkSteps } }), {
      message: /workload\.walkSteps is out of range/
    })
  }
  await t.exception.all(assessFit({ mode: 'world', files, config: { backend: 'cpu' } }), {
    message: /cannot read the model/
  })
  for (const config of [
    { backend: 'gpux' },
    { paramsBackend: 'decoder=cpu' },
    { paramsBackend: 'diffusion=gpux' },
    { maxVram: 'gpux=4' }
  ]) {
    const unplanned = await assessFit({ mode: 'world', files, config })
    t.is(unplanned.status, 'unknown', `${JSON.stringify(config)} is not a placement to plan`)
    t.alike(unplanned.devices, [])
  }
})

test('a file that is not a model rejects too', async (t) => {
  const model = tempFile(t, 'model.gguf', Buffer.alloc(512, 7))
  await t.exception.all(assessFit({ files: { model } }), { message: /cannot read the model/ })
})

test('a broken request rejects', async (t) => {
  const relative = assessFit({ files: { model: 'model.gguf' } })
  t.ok(relative instanceof Promise)
  await t.exception.all(relative, TypeError)
  await t.exception.all(assessFit({ files: { model: 'model.gguf' } }), {
    message: /must be an absolute path/
  })

  const model = tempFile(t, 'model.gguf', Buffer.alloc(512, 7))
  const badConfig = assessFit({ files: { model }, config: { rng: 'not-an-rng' } })
  t.ok(badConfig instanceof Promise)
  await t.exception.all(badConfig, { message: /rng must be/ })
})

test('concurrent fits keep independent requests and all settle', async (t) => {
  const esrgan = esrganHeader(t)
  const request = {
    mode: 'upscale',
    files: { esrgan },
    config: { device: 'cpu', upscaler_tile_size: 16, max_image_pixels: 268435456 },
    workload: { width: 128, height: 96 }
  }
  const small = assessFit(request)
  request.workload = { width: 4096, height: 4096 }
  const large = assessFit(request)
  const missing = assessFit({ mode: 'upscale', files: { esrgan: '/missing/esrgan.safetensors' } })
  const refused = assessFit({ ...request, workload: { upscaleRepeats: 0 } })

  const [a, b, c, d] = await Promise.allSettled([small, large, missing, refused])
  t.is(a.value.status, 'fits')
  t.ok(
    hostRow(b.value).usedBytes > hostRow(a.value).usedBytes,
    'each call owns the workload it was given'
  )
  t.is(c.status, 'rejected', 'a rejection does not strand the other calls')
  t.is(d.status, 'rejected', 'a refused workload settles alongside the rest')
})

test('a pinned placement is unknown', async (t) => {
  const model = tempFile(t, 'model.gguf', Buffer.alloc(512, 7))

  const pinned = await assessFit({ files: { model }, config: { device: 'gpu', 'main-gpu': 0 } })
  t.is(pinned.status, 'unknown', 'a main-gpu pin the engine cannot plan from')
  t.alike(pinned.devices, [])

  const cpu = await assessFit({ files: { model }, config: { device: 'cpu' } })
  t.is(cpu.status, 'unknown', 'a cpu device the engine plans as a GPU load')
})

test('a workload number the engine cannot represent rejects', async (t) => {
  const model = tempFile(t, 'model.gguf', Buffer.alloc(512, 7))
  const cases = [
    ['NaN', { width: NaN }],
    ['infinity', { height: Infinity }],
    ['above int range', { width: 2147483648 }],
    ['fractional', { height: 512.5 }],
    ['zero frames', { videoFrames: 0 }],
    ['negative tile', { vaeTileSizeX: -1 }],
    ['overlap out of range', { vaeTileOverlap: 1.5 }]
  ]

  for (const [name, workload] of cases) {
    await t.exception.all(
      assessFit({ files: { model }, workload }),
      { message: /is out of range/ },
      name
    )
  }
})

safeTest('a real model projects a verdict', { timeout: 600_000, skip }, async (t) => {
  const model = await ensureModelPath({ modelName: MODEL_NAME })

  const fit = await assessFit({ files: { model } })

  t.comment(JSON.stringify(fit))
  t.ok(fit.status === 'fits' || fit.status === 'does-not-fit', 'a verdict')
  t.ok(fit.devices.length >= 1, 'the placement is reported per device')
  t.ok(hostRow(fit).unified, 'the host row is last')
  for (const row of fit.devices) {
    t.ok(row.id.length > 0 && row.name.length > 0, `${row.name} is identified`)
    t.ok(Number.isSafeInteger(row.usedBytes) && row.usedBytes >= 0, `${row.name} has a use`)
    t.ok(row.freeBytes > 0, `${row.name} has free memory`)
  }
  t.ok(
    fit.devices.some((row) => row.usedBytes > 0),
    'the weights are charged to some device'
  )
})

safeTest('fitting keeps the event loop responsive', { timeout: 600_000, skip }, async (t) => {
  const model = await ensureModelPath({ modelName: MODEL_NAME })
  let pending = true
  let ticks = 0
  const timer = setInterval(() => {
    if (pending) ticks++
  }, 1)
  try {
    const fit = await assessFit({ files: { model } })
    pending = false
    t.ok(
      fit.status === 'fits' || fit.status === 'does-not-fit',
      'a real native projection completed'
    )
    t.ok(ticks > 0, 'timers ran before fitting settled')
    t.comment(`${ticks} timer ticks before completion`)
  } finally {
    pending = false
    clearInterval(timer)
  }
})

safeTest(
  'generation fit includes its retained ESRGAN model',
  { timeout: 600_000, skip },
  async (t) => {
    const model = await ensureModelPath({ modelName: MODEL_NAME })
    const esrgan = esrganHeader(t)
    const workload = { width: 512, height: 512 }
    const plain = await assessFit({ files: { model }, workload })
    const fit = await assessFit({ files: { model, esrgan }, workload })
    t.ok(fit.status === 'fits' || fit.status === 'does-not-fit')
    t.ok(
      hostRow(fit).usedBytes > hostRow(plain).usedBytes,
      'the host row includes the upscaler image buffers'
    )
    await t.exception.all(
      assessFit({
        files: { model, esrgan },
        workload: { width: 1024, height: 1024, upscaleRepeats: 2 }
      }),
      { message: /exceeds the pixel limit/ },
      'combined fit enforces the same output limits'
    )
  }
)

safeTest(
  'video fit ignores the separate ESRGAN image upscaler',
  { timeout: 600_000, skip: skip || os.platform() === 'darwin' },
  async (t) => {
    const files = {
      model: await ensureModelPath({ modelName: 'wan2.1_t2v_1.3B_fp16.safetensors' }),
      vae: await ensureModelPath({ modelName: 'wan_2.1_vae.safetensors' }),
      t5Xxl: await ensureModelPath({ modelName: 'umt5_xxl_fp16.safetensors' })
    }
    // Native Windows runtimes can keep their own getenv snapshot. Supply the
    // fixed budgets at process creation, before the addon is loaded, rather
    // than changing the parent process environment between assessments.
    const { spawn } = require('bare-subprocess')
    for (const freeGiB of [32, 8]) {
      const outputPath = tempFile(t, 'fit-results.json', '')
      const child = spawn(
        proc.execPath,
        [path.join(__dirname, '_fit-upscaler-worker.js'), JSON.stringify(files), outputPath],
        {
          env: {
            ...proc.env,
            SD_FIT_DEBUG_DEVICES: `GPU0:${freeGiB}`,
            SD_FIT_DEBUG_HOST_MEMORY_GIB: '64'
          },
          stdio: ['ignore', 'inherit', 'pipe']
        }
      )
      let finished = false
      let stderr = ''
      t.teardown(() => {
        if (!finished) child.kill()
      })
      child.stderr.on('data', (data) => {
        stderr = (stderr + data.toString()).slice(-16384)
      })
      await new Promise((resolve, reject) => {
        child.once('error', reject)
        child.once('close', (code, signal) => {
          finished = true
          if (code === 0) resolve()
          else reject(new Error(`Fit worker failed (${signal || code}): ${stderr}`))
        })
      })
      const results = JSON.parse(fs.readFileSync(outputPath, 'utf8'))
      t.alike(
        results.map(({ videoFrames }) => videoFrames),
        [1, 5],
        'both video workloads ran'
      )
      for (const { base, unused } of results) {
        t.ok(base.status === 'fits' || base.status === 'does-not-fit', 'valid video projection')
        const gpu = base.devices.find((row) => row.name === 'GPU0')
        t.ok(gpu, 'planner uses the simulated GPU')
        t.is(gpu?.freeBytes, freeGiB * 1024 ** 3, 'planner uses the fixed GPU memory budget')
        t.is(unused.status, base.status)
        t.alike(
          unused.devices,
          base.devices,
          'unused image upscaler does not affect per-device memory'
        )
        t.alike(unused.stats, base.stats, 'unused image upscaler does not affect fit stats')
      }
    }
  }
)

safeTest('the workload sizes the projection', { timeout: 600_000, skip }, async (t) => {
  const model = await ensureModelPath({ modelName: MODEL_NAME })

  const small = await assessFit({ files: { model }, workload: { width: 512, height: 512 } })
  const large = await assessFit({ files: { model }, workload: { width: 8192, height: 8192 } })

  t.comment(`small=${small.status} large=${large.status}`)
  if (small.status !== 'fits') {
    t.pass('this runner cannot hold the model at all')
    return
  }
  t.is(large.status, 'does-not-fit', 'a 16x wider decode is not the same projection')
})
