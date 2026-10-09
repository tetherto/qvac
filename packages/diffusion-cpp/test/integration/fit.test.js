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

test('standalone ESRGAN projects a CPU load from headers without weights', (t) => {
  const esrgan = esrganHeader(t)
  const fit = assessFit({
    mode: 'upscale',
    files: { esrgan },
    config: { device: 'cpu', upscaler_tile_size: 16 },
    workload: { width: 128, height: 96, upscaleRepeats: 2 }
  })
  t.is(fit.status, 'fits')
  t.is(fit.changed, false)
  t.ok(fit.report.includes('upscaler'))
  t.ok(fit.report.includes('host memory'))
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
    const fit = assessFit({ mode: 'upscale', files: { esrgan }, workload })
    t.is(fit.status, 'error')
    t.is(fit.reason, 'unsupported-config')
  }
  const unreadable = assessFit({
    mode: 'upscale',
    files: { esrgan: '/missing/esrgan.safetensors' }
  })
  t.is(unreadable.reason, 'model-unreadable')
})

test('standalone ESRGAN sizes full-image RAM even when tiles stay small', (t) => {
  const esrgan = esrganHeader(t)
  const request = {
    mode: 'upscale',
    files: { esrgan },
    config: { device: 'cpu', upscaler_tile_size: 16, max_image_pixels: 268435456 }
  }
  const small = assessFit({ ...request, workload: { width: 128, height: 96 } })
  const large = assessFit({ ...request, workload: { width: 4096, height: 4096 } })
  t.is(small.status, 'fits')
  const repeated = assessFit({
    ...request,
    workload: { width: 1024, height: 1024, upscaleRepeats: 2 }
  })
  function hostMiB(fit) {
    const match = fit.report.match(/host memory:.*projected use (\d+) MiB/)
    t.ok(match, 'host memory projection is reported')
    return match ? Number(match[1]) : 0
  }
  t.ok(hostMiB(large) >= 4080, 'the full image buffers need 4080 MiB despite small tiles')
  t.ok(hostMiB(repeated) >= 4083, 'repeated scaling includes intermediate and final images')
  t.ok(hostMiB(large) > hostMiB(small))
})

test('ESRGAN fit enforces the runtime output limits', (t) => {
  const esrgan = esrganHeader(t)
  for (const workload of [
    { width: 1024, height: 1024, upscaleRepeats: 2 },
    { width: 4097, height: 1 }
  ]) {
    const fit = assessFit({ mode: 'upscale', files: { esrgan }, workload })
    t.is(fit.reason, 'unsupported-config')
  }
  const fit = assessFit({
    mode: 'upscale',
    files: { esrgan },
    config: { max_image_pixels: 1000 },
    workload: { width: 16, height: 16 }
  })
  t.is(fit.reason, 'unsupported-config', 'a configured pixel limit also applies to fit')
  for (const scale of [1, 2, 4]) {
    const scaled = assessFit({
      mode: 'upscale',
      files: { esrgan: esrganHeader(t, scale) },
      config: { device: 'cpu', max_image_pixels: 1000 },
      workload: { width: 16, height: 16 }
    })
    t.is(scaled.reason, scale === 1 ? 'fits' : 'unsupported-config', `${scale}x checkpoint limits`)
  }
})

test('an unreadable model returns an error outcome', (t) => {
  const fit = assessFit({ files: { model: '/nonexistent/model.gguf' } })

  t.is(fit.status, 'error')
  t.is(fit.reason, 'model-unreadable')
  t.is(fit.changed, false)
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
    const fit = assessFit({ mode: 'world', files, workload: { walkSteps } })
    t.is(fit.status, 'error')
    t.is(fit.reason, 'unsupported-config')
  }
  const fit = assessFit({ mode: 'world', files, config: { backend: 'cpu' } })
  t.is(fit.reason, 'model-unreadable')
  for (const config of [
    { backend: 'gpux' },
    { paramsBackend: 'decoder=cpu' },
    { paramsBackend: 'diffusion=gpux' },
    { maxVram: 'gpux=4' }
  ]) {
    const invalid = assessFit({ mode: 'world', files, config })
    t.is(invalid.status, 'error')
    t.is(invalid.reason, 'unsupported-config')
  }
})

test('a file that is not a model is unreadable too', (t) => {
  const fit = assessFit({ files: { model: tempFile(t, 'model.gguf', Buffer.alloc(512, 7)) } })

  t.is(fit.status, 'error')
  t.is(fit.reason, 'model-unreadable')
})

// A load refuses a relative path up front; the fit would otherwise hand it to
// the engine and get back an opaque error.
test('a relative path is refused rather than projected', (t) => {
  try {
    assessFit({ files: { model: 'model.gguf' } })
    t.fail('a relative path should not reach the engine')
  } catch (err) {
    t.ok(err instanceof TypeError)
    t.ok(err.message.includes('must be an absolute path'))
  }
})

test('a pinned placement is refused', (t) => {
  const model = tempFile(t, 'model.gguf', Buffer.alloc(512, 7))

  const pinned = assessFit({ files: { model }, config: { device: 'gpu', 'main-gpu': 0 } })
  t.is(pinned.reason, 'unsupported-config', 'a main-gpu pin the engine cannot validate')

  const cpu = assessFit({ files: { model }, config: { device: 'cpu' } })
  t.is(cpu.reason, 'unsupported-config', 'a cpu device the engine plans as a GPU load')
})

test('a workload number the engine cannot represent is refused', (t) => {
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
    const fit = assessFit({ files: { model }, workload })
    t.is(fit.reason, 'unsupported-config', name)
    t.is(fit.status, 'error', `${name} is an outcome, not a throw`)
  }
})

safeTest('a real model projects a verdict', { timeout: 600_000, skip }, async (t) => {
  const model = await ensureModelPath({ modelName: MODEL_NAME })

  const fit = assessFit({ files: { model } })

  t.comment(`status=${fit.status} reason=${fit.reason} changed=${fit.changed}`)
  t.ok(fit.status === 'fits' || fit.status === 'does-not-fit', 'a verdict, not an error')
  t.is(fit.reason, fit.status, 'a verdict reports itself as its reason')
  t.ok(fit.report.length > 0, 'the engine reported its placement')
})

safeTest(
  'generation fit includes its retained ESRGAN model',
  { timeout: 600_000, skip },
  async (t) => {
    const model = await ensureModelPath({ modelName: MODEL_NAME })
    const esrgan = esrganHeader(t)
    const fit = assessFit({ files: { model, esrgan }, workload: { width: 512, height: 512 } })
    t.ok(fit.status === 'fits' || fit.status === 'does-not-fit')
    t.ok(fit.report.includes('upscaler'), 'combined measurement includes ESRGAN')
    t.ok(fit.report.includes('host memory'), 'combined measurement includes upscaler image buffers')
    const tooLarge = assessFit({
      files: { model, esrgan },
      workload: { width: 1024, height: 1024, upscaleRepeats: 2 }
    })
    t.is(tooLarge.reason, 'unsupported-config', 'combined fit enforces the same output limits')
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
    for (const videoFrames of [1, 5]) {
      const request = { files, workload: { width: 256, height: 256, videoFrames, vaeTiling: true } }
      const base = assessFit(request)
      t.ok(base.status === 'fits' || base.status === 'does-not-fit', 'valid video projection')
      const unused = assessFit({
        ...request,
        files: { ...files, esrgan: '/missing/unused-esrgan.safetensors' }
      })
      t.is(unused.status, base.status)
      t.is(unused.reason, base.reason)
      t.is(unused.report, base.report, 'unused image upscaler does not affect video memory')
    }
  }
)

safeTest('the workload sizes the projection', { timeout: 600_000, skip }, async (t) => {
  const model = await ensureModelPath({ modelName: MODEL_NAME })

  const small = assessFit({ files: { model }, workload: { width: 512, height: 512 } })
  const large = assessFit({ files: { model }, workload: { width: 8192, height: 8192 } })

  t.comment(`small=${small.status} large=${large.status}`)
  if (small.status !== 'fits') {
    t.pass('this runner cannot hold the model at all')
    return
  }
  t.is(large.status, 'does-not-fit', 'a 16x wider decode is not the same projection')
})
