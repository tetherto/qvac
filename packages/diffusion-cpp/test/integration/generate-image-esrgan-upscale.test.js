'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const os = require('bare-os')
const proc = require('bare-process')
const test = require('brittle')
const binding = require('../../binding')
const ImgStableDiffusion = require('../../index')
const { EsrganUpscaler } = require('../../index')
const { readImageDimensions } = require('../../addon')
const {
  ensureModel,
  GeneratedImageSaver,
  detectPlatform,
  setupJsLogger,
  isPng
} = require('./utils')
const { recordPerformance } = require('./_perf-helper')

const platform = detectPlatform()
const isDarwinX64 = os.platform() === 'darwin' && os.arch() === 'x64'
const isLinuxArm64 = os.platform() === 'linux' && os.arch() === 'arm64'
const isMobile = os.platform() === 'ios' || os.platform() === 'android'
const isWindows = os.platform() === 'win32'
const noGpu = proc.env && proc.env.NO_GPU === 'true'
const useCpu = isDarwinX64 || isLinuxArm64 || noGpu
const skip = isMobile || noGpu

const BASE_TIMEOUT = 600000
const testTimeout = isWindows ? BASE_TIMEOUT * 2 : BASE_TIMEOUT
const CANCEL_SETTLE_TIMEOUT = isWindows ? 240000 : 120000
const STANDALONE_CANCEL_DELAY = 250
const CANCEL_ERROR_RE = /cancel|aborted|stopp?ed/i

const SD21_MODEL = {
  name: 'stable-diffusion-v2-1-Q4_0.gguf',
  url: 'https://huggingface.co/gpustack/stable-diffusion-v2-1-GGUF/resolve/main/stable-diffusion-v2-1-Q4_0.gguf'
}

const ESRGAN_MODEL = {
  name: 'RealESRGAN_x4plus_anime_6B.pth',
  // Real-ESRGAN: https://github.com/xinntao/Real-ESRGAN
  // The .pth model is downloaded on demand for tests; it is not bundled.
  url: 'https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.2.4/RealESRGAN_x4plus_anime_6B.pth'
}

const SOURCE_WIDTH = 64
const SOURCE_HEIGHT = 64

const BASE_PARAMS = {
  prompt: 'a red fox',
  steps: 1,
  width: SOURCE_WIDTH,
  height: SOURCE_HEIGHT,
  cfg_scale: 7.5,
  seed: 42
}

const LONG_PARAMS = {
  ...BASE_PARAMS,
  steps: 20,
  seed: 43
}

const TINY_PNG_16X16 = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x10, 0x00, 0x00, 0x00, 0x10,
  0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x91, 0x68,
  0x36, 0x00, 0x00, 0x01, 0xb8, 0x49, 0x44, 0x41,
  0x54, 0x78, 0x9c, 0x0d, 0xcd, 0x41, 0x01, 0x00,
  0x21, 0x08, 0x04, 0x40, 0x23, 0x10, 0xc1, 0xe7,
  0x3e, 0x89, 0x60, 0x04, 0x22, 0x10, 0x81, 0x08,
  0x46, 0x20, 0x82, 0x11, 0x8c, 0x60, 0x04, 0x03,
  0xec, 0x83, 0x08, 0x46, 0xb8, 0x9b, 0x02, 0xd3,
  0x5a, 0x83, 0x34, 0xf6, 0x06, 0x6d, 0x1c, 0x0d,
  0xd6, 0xe8, 0x0d, 0xd1, 0x38, 0x1b, 0xb2, 0x71,
  0x35, 0xec, 0xc6, 0xd3, 0x70, 0x1b, 0xab, 0xe1,
  0x35, 0xb6, 0x26, 0x14, 0x41, 0x17, 0xaa, 0x60,
  0x08, 0x4d, 0xe0, 0xc2, 0x10, 0x4c, 0x61, 0x0a,
  0x96, 0x70, 0x0b, 0x8e, 0xf0, 0x0a, 0x4a, 0xf8,
  0x04, 0xad, 0x75, 0x48, 0x67, 0xef, 0xd0, 0xce,
  0xd1, 0x61, 0x9d, 0xde, 0x11, 0x9d, 0xb3, 0x23,
  0x3b, 0x57, 0xc7, 0xee, 0x3c, 0x1d, 0xb7, 0xb3,
  0x3a, 0x5e, 0xff, 0x07, 0xa5, 0x28, 0xba, 0x52,
  0x15, 0x43, 0x69, 0x0a, 0x57, 0x86, 0x62, 0x2a,
  0x53, 0xb1, 0x94, 0x5b, 0x71, 0x94, 0x57, 0x51,
  0xca, 0xa7, 0xff, 0x30, 0x20, 0x83, 0x7d, 0x40,
  0x07, 0xc7, 0x80, 0x0d, 0xfa, 0x40, 0x0c, 0xce,
  0x81, 0x1c, 0x5c, 0x03, 0x7b, 0xf0, 0x0c, 0xdc,
  0xc1, 0x1a, 0x78, 0xe3, 0x1f, 0x8c, 0x62, 0xe8,
  0x46, 0x35, 0x0c, 0xa3, 0x19, 0xdc, 0x18, 0x86,
  0x69, 0x4c, 0xc3, 0x32, 0x6e, 0xc3, 0x31, 0x5e,
  0x43, 0x19, 0x9f, 0xfd, 0x83, 0x43, 0x9c, 0xdd,
  0xa1, 0xce, 0xe1, 0x30, 0xa7, 0x3b, 0xc2, 0x39,
  0x1d, 0xe9, 0x5c, 0x8e, 0xed, 0x3c, 0x8e, 0xeb,
  0x2c, 0xc7, 0xf3, 0x7f, 0x08, 0x4a, 0xa0, 0x07,
  0x35, 0x30, 0x82, 0x16, 0xf0, 0x60, 0x04, 0x66,
  0x30, 0x03, 0x2b, 0xb8, 0x03, 0x27, 0x78, 0x03,
  0x15, 0x7c, 0xf1, 0x0f, 0x13, 0x32, 0xd9, 0x27,
  0x74, 0x72, 0x4c, 0xd8, 0xa4, 0x4f, 0xc4, 0xe4,
  0x9c, 0xc8, 0xc9, 0x35, 0xb1, 0x27, 0xcf, 0xc4,
  0x9d, 0xac, 0x89, 0x37, 0xff, 0x21, 0x29, 0x89,
  0x9e, 0xd4, 0xc4, 0x48, 0x5a, 0xc2, 0x93, 0x91,
  0x98, 0xc9, 0x4c, 0xac, 0xe4, 0x4e, 0x9c, 0xe4,
  0x4d, 0x54, 0xf2, 0xe5, 0x3f, 0x2c, 0xc8, 0x62,
  0x5f, 0xd0, 0xc5, 0xb1, 0x60, 0x8b, 0xbe, 0x10,
  0x8b, 0x73, 0x21, 0x17, 0xd7, 0xc2, 0x5e, 0x3c,
  0x0b, 0x77, 0xb1, 0x16, 0xde, 0xfa, 0x87, 0x4d,
  0xd9, 0xe8, 0x9b, 0xba, 0x31, 0x36, 0x6d, 0xc3,
  0x37, 0x63, 0x63, 0x6e, 0xe6, 0xc6, 0xda, 0xdc,
  0x1b, 0x67, 0xf3, 0x6e, 0xd4, 0xe6, 0xdb, 0xff,
  0x70, 0x20, 0x87, 0xfd, 0x40, 0x0f, 0xc7, 0x81,
  0x1d, 0xfa, 0x41, 0x1c, 0xce, 0x83, 0x3c, 0x5c,
  0x07, 0xfb, 0xf0, 0x1c, 0xdc, 0xc3, 0x3a, 0x78,
  0xe7, 0x1f, 0x2e, 0xe5, 0xa2, 0x5f, 0xea, 0xc5,
  0xb8, 0xb4, 0x0b, 0xbf, 0x8c, 0x8b, 0x79, 0x99,
  0x17, 0xeb, 0x72, 0x5f, 0x9c, 0xcb, 0x7b, 0x51,
  0x97, 0xef, 0xfe, 0x43, 0x41, 0x8a, 0xbd, 0xa0,
  0xc5, 0x51, 0xb0, 0xa2, 0x17, 0xa2, 0x38, 0x0b,
  0x59, 0x5c, 0x85, 0x5d, 0x3c, 0x85, 0x5b, 0xac,
  0xc2, 0xab, 0x7f, 0x78, 0x94, 0x87, 0xfe, 0xa8,
  0x0f, 0xe3, 0xd1, 0x1e, 0xfc, 0x31, 0x1e, 0xe6,
  0x63, 0x3e, 0xac, 0xc7, 0xfd, 0x70, 0x1e, 0xef,
  0x43, 0x3d, 0xbe, 0x87, 0x0f, 0x96, 0x2f, 0x72,
  0x10, 0xbf, 0x64, 0x8b, 0x82, 0x00, 0x00, 0x00,
  0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60,
  0x82
])

function expectedSize (sourceSize, repeats) {
  return sourceSize * Math.pow(4, repeats)
}

function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function assertPngDimensions (t, image, width, height, label) {
  t.ok(image instanceof Uint8Array, `${label}: output is a Uint8Array`)
  t.ok(image.length > 0, `${label}: output is non-empty`)
  t.ok(isPng(image), `${label}: output has valid PNG magic bytes`)

  const dims = readImageDimensions(image)
  t.ok(dims, `${label}: PNG dimensions are readable`)
  t.is(dims.width, width, `${label}: output width`)
  t.is(dims.height, height, `${label}: output height`)
}

async function collectImages (response) {
  const images = []
  await response.onUpdate(data => {
    if (data instanceof Uint8Array) {
      images.push(data)
    }
  }).await()
  return images
}

async function expectCancelRejection (t, promise, label) {
  let timeout
  const result = await Promise.race([
    promise.then(
      () => ({ status: 'resolved' }),
      err => ({ status: 'rejected', err })
    ),
    new Promise(resolve => {
      timeout = setTimeout(
        () => resolve({ status: 'timeout' }),
        CANCEL_SETTLE_TIMEOUT
      )
    })
  ])
  clearTimeout(timeout)

  if (result.status === 'timeout') {
    t.fail(`${label}: did not settle within ${CANCEL_SETTLE_TIMEOUT}ms`)
    return
  }
  if (result.status === 'resolved') {
    t.fail(`${label}: completed successfully instead of cancelling`)
    return
  }

  t.ok(
    CANCEL_ERROR_RE.test(result.err?.message || ''),
    `${label}: rejected with a cancel error`
  )
}

async function ensureEsrganModelPath () {
  const [esrganName, modelDir] = await ensureModel({
    modelName: ESRGAN_MODEL.name,
    downloadUrl: ESRGAN_MODEL.url
  })
  return { esrganPath: path.join(modelDir, esrganName), modelDir }
}

async function ensureSdAndEsrganPaths () {
  const [modelName, modelDir] = await ensureModel({
    modelName: SD21_MODEL.name,
    downloadUrl: SD21_MODEL.url
  })
  const { esrganPath } = await ensureEsrganModelPath()
  return {
    modelDir,
    modelPath: path.join(modelDir, modelName),
    esrganPath
  }
}

function createModel (modelPath, esrganPath) {
  return new ImgStableDiffusion({
    files: {
      model: modelPath,
      esrgan: esrganPath
    },
    config: {
      device: useCpu ? 'cpu' : 'gpu',
      threads: 4,
      prediction: 'v',
      upscaler_tile_size: 128,
      verbosity: 2
    },
    logger: console,
    opts: { stats: true }
  })
}

function createUpscaler (esrganPath) {
  return new EsrganUpscaler({
    files: {
      esrgan: esrganPath
    },
    config: {
      upscaler_tile_size: 128,
      verbosity: 2
    },
    logger: console,
    opts: { stats: true }
  })
}

function saveImage (modelDir, filename, image) {
  const imageSaver = new GeneratedImageSaver(modelDir)
  imageSaver.save(filename, image)
}

test('ESRGAN post-generation upscale — emits expected PNG dimensions', { timeout: testTimeout, skip }, async t => {
  setupJsLogger(binding)

  const [modelName, modelDir] = await ensureModel({
    modelName: SD21_MODEL.name,
    downloadUrl: SD21_MODEL.url
  })
  const { esrganPath } = await ensureEsrganModelPath()

  console.log('\n' + '='.repeat(60))
  console.log('SD2.1 POST-GENERATION ESRGAN UPSCALE — INTEGRATION TEST')
  console.log('='.repeat(60))
  console.log(` Platform  : ${platform}`)
  console.log(` Model     : ${modelName}`)
  console.log(` ESRGAN    : ${path.basename(esrganPath)}`)
  console.log(` Models dir: ${modelDir}`)

  const modelPath = path.join(modelDir, modelName)
  t.ok(fs.existsSync(modelPath), 'SD model file exists on disk')
  t.ok(fs.existsSync(esrganPath), 'ESRGAN model file exists on disk')

  const model = new ImgStableDiffusion({
    files: {
      model: modelPath,
      esrgan: esrganPath
    },
    config: {
      device: useCpu ? 'cpu' : 'gpu',
      threads: 4,
      prediction: 'v',
      upscaler_tile_size: 128,
      verbosity: 2
    },
    logger: console,
    opts: { stats: true }
  })

  try {
    await model.load()

    for (const runCase of [
      { label: 'upscale true', upscale: true, repeats: 1 },
      { label: 'upscale repeats 2', upscale: { repeats: 2 }, repeats: 2 }
    ]) {
      const response = await model.run({
        ...BASE_PARAMS,
        upscale: runCase.upscale
      })
      const images = await collectImages(response)

      t.is(images.length, 1, `${runCase.label}: received exactly one image`)
      assertPngDimensions(
        t,
        images[0],
        expectedSize(SOURCE_WIDTH, runCase.repeats),
        expectedSize(SOURCE_HEIGHT, runCase.repeats),
        runCase.label
      )
      saveImage(
        modelDir,
        `generate-image--sd2-esrgan-${runCase.repeats}x-repeat.png`,
        images[0]
      )

      t.comment(recordPerformance(
        '[ESRGAN 4x post-gen upscale repeats=' + runCase.repeats + '] [' + (useCpu ? 'CPU' : 'GPU') + ']',
        response.stats,
        { scenario: 'upscale', model: 'RealESRGAN_x4plus_anime_6B' }
      ))
    }
  } finally {
    await model.unload().catch(() => {})
    try {
      binding.releaseLogger()
    } catch (_) {}
  }
})

test('ESRGAN standalone upscale — emits expected PNG dimensions', { timeout: testTimeout, skip }, async t => {
  setupJsLogger(binding)

  const { esrganPath, modelDir } = await ensureEsrganModelPath()
  t.ok(fs.existsSync(esrganPath), 'ESRGAN model file exists on disk')

  const inputDims = readImageDimensions(TINY_PNG_16X16)
  t.alike(inputDims, { width: 16, height: 16 }, 'fixture is a 16x16 PNG')

  const upscaler = new EsrganUpscaler({
    files: {
      esrgan: esrganPath
    },
    config: {
      upscaler_tile_size: 128,
      verbosity: 2
    },
    logger: console,
    opts: { stats: true }
  })

  try {
    await upscaler.load()

    for (const runCase of [
      { label: 'standalone repeats 1', repeats: 1 },
      { label: 'standalone repeats 2', repeats: 2 }
    ]) {
      const response = await upscaler.upscale(TINY_PNG_16X16, {
        repeats: runCase.repeats
      })
      const images = await collectImages(response)

      t.is(images.length, 1, `${runCase.label}: received exactly one image`)
      assertPngDimensions(
        t,
        images[0],
        expectedSize(16, runCase.repeats),
        expectedSize(16, runCase.repeats),
        runCase.label
      )
      saveImage(
        modelDir,
        `generate-image--standalone-esrgan-${runCase.repeats}x-repeat.png`,
        images[0]
      )

      t.comment(recordPerformance(
        '[ESRGAN 4x standalone upscale repeats=' + runCase.repeats + '] [' + (useCpu ? 'CPU' : 'GPU') + ']',
        response.stats,
        { scenario: 'upscale', model: 'RealESRGAN_x4plus_anime_6B' }
      ))
    }
  } finally {
    await upscaler.unload().catch(() => {})
    try {
      binding.releaseLogger()
    } catch (_) {}
  }
})

test('ESRGAN standalone upscale — cancel rejects between repeat passes', { timeout: testTimeout, skip }, async t => {
  setupJsLogger(binding)

  const { esrganPath } = await ensureEsrganModelPath()
  t.ok(fs.existsSync(esrganPath), 'ESRGAN model file exists on disk')

  const upscaler = new EsrganUpscaler({
    files: {
      esrgan: esrganPath
    },
    config: {
      upscaler_tile_size: 128,
      verbosity: 2
    },
    logger: console,
    opts: { stats: true }
  })

  try {
    await upscaler.load()

    const images = []
    const response = await upscaler.upscale(TINY_PNG_16X16, { repeats: 3 })
    const chain = response.onUpdate(data => {
      if (data instanceof Uint8Array) {
        images.push(data)
      }
    }).await()

    // Standalone upscale does not emit progress ticks. Use enough repeats to
    // keep the job alive, then cancel shortly after acceptance so cancellation
    // is observed at the next ESRGAN repeat boundary.
    await sleep(STANDALONE_CANCEL_DELAY)
    const cancelStarted = Date.now()
    const cancelPromise = upscaler.cancel()

    await expectCancelRejection(t, chain, 'standalone cancel')
    await cancelPromise

    t.ok(
      Date.now() - cancelStarted < CANCEL_SETTLE_TIMEOUT,
      'standalone cancel settled within timeout'
    )
    t.is(images.length, 0, 'standalone cancel emitted no PNG output')
  } finally {
    await upscaler.unload().catch(() => {})
    try {
      binding.releaseLogger()
    } catch (_) {}
  }
})

test('ESRGAN post-generation upscale — cancel rejects without emitted image', { timeout: testTimeout, skip }, async t => {
  setupJsLogger(binding)

  const [modelName, modelDir] = await ensureModel({
    modelName: SD21_MODEL.name,
    downloadUrl: SD21_MODEL.url
  })
  const { esrganPath } = await ensureEsrganModelPath()

  const modelPath = path.join(modelDir, modelName)
  t.ok(fs.existsSync(modelPath), 'SD model file exists on disk')
  t.ok(fs.existsSync(esrganPath), 'ESRGAN model file exists on disk')

  const model = new ImgStableDiffusion({
    files: {
      model: modelPath,
      esrgan: esrganPath
    },
    config: {
      device: useCpu ? 'cpu' : 'gpu',
      threads: 4,
      prediction: 'v',
      upscaler_tile_size: 128,
      verbosity: 2
    },
    logger: console,
    opts: { stats: true }
  })

  try {
    await model.load()

    const response = await model.run({
      ...BASE_PARAMS,
      upscale: { repeats: 2 }
    })

    const images = []
    let cancelFired = false
    const chain = response.onUpdate(async data => {
      if (data instanceof Uint8Array) {
        images.push(data)
        return
      }
      if (!cancelFired && typeof data === 'string') {
        cancelFired = true
        await model.cancel()
      }
    }).await()

    await expectCancelRejection(t, chain, 'post-generation cancel')
    t.ok(cancelFired, 'post-generation cancel fired after first progress tick')
    t.is(images.length, 0, 'post-generation cancel emitted no PNG output')
  } finally {
    await model.unload().catch(() => {})
    try {
      binding.releaseLogger()
    } catch (_) {}
  }
})

test('ESRGAN standalone upscaler and diffusion model can coexist', { timeout: testTimeout, skip }, async t => {
  setupJsLogger(binding)

  const [modelName, modelDir] = await ensureModel({
    modelName: SD21_MODEL.name,
    downloadUrl: SD21_MODEL.url
  })
  const { esrganPath } = await ensureEsrganModelPath()

  const modelPath = path.join(modelDir, modelName)
  t.ok(fs.existsSync(modelPath), 'SD model file exists on disk')
  t.ok(fs.existsSync(esrganPath), 'ESRGAN model file exists on disk')

  const model = new ImgStableDiffusion({
    files: {
      model: modelPath,
      esrgan: esrganPath
    },
    config: {
      device: useCpu ? 'cpu' : 'gpu',
      threads: 4,
      prediction: 'v',
      upscaler_tile_size: 128,
      verbosity: 2
    },
    logger: console,
    opts: { stats: true }
  })

  const upscaler = new EsrganUpscaler({
    files: {
      esrgan: esrganPath
    },
    config: {
      upscaler_tile_size: 128,
      verbosity: 2
    },
    logger: console,
    opts: { stats: true }
  })

  try {
    await Promise.all([
      model.load(),
      upscaler.load()
    ])

    const [generationImages, standaloneImages] = await Promise.all([
      model.run(BASE_PARAMS).then(collectImages),
      upscaler.upscale(TINY_PNG_16X16, { repeats: 1 }).then(collectImages)
    ])

    t.is(generationImages.length, 1, 'coexistence generation: received exactly one image')
    assertPngDimensions(
      t,
      generationImages[0],
      SOURCE_WIDTH,
      SOURCE_HEIGHT,
      'coexistence generation'
    )
    saveImage(
      modelDir,
      'generate-image--coexistence-sd2.png',
      generationImages[0]
    )

    t.is(standaloneImages.length, 1, 'coexistence standalone: received exactly one image')
    assertPngDimensions(
      t,
      standaloneImages[0],
      expectedSize(16, 1),
      expectedSize(16, 1),
      'coexistence standalone'
    )
    saveImage(
      modelDir,
      'generate-image--coexistence-standalone-esrgan.png',
      standaloneImages[0]
    )
  } finally {
    await Promise.all([
      model.unload().catch(() => {}),
      upscaler.unload().catch(() => {})
    ])
    try {
      binding.releaseLogger()
    } catch (_) {}
  }
})

test('ESRGAN coexistence — canceling one instance does not affect the other', { timeout: testTimeout, skip }, async t => {
  setupJsLogger(binding)

  const { modelDir, modelPath, esrganPath } = await ensureSdAndEsrganPaths()
  t.ok(fs.existsSync(modelPath), 'SD model file exists on disk')
  t.ok(fs.existsSync(esrganPath), 'ESRGAN model file exists on disk')

  const model = createModel(modelPath, esrganPath)
  const upscaler = createUpscaler(esrganPath)

  try {
    await Promise.all([
      model.load(),
      upscaler.load()
    ])

    const [modelResponse, upscalerResponse] = await Promise.all([
      model.run(LONG_PARAMS),
      upscaler.upscale(TINY_PNG_16X16, { repeats: 3 })
    ])

    const modelImages = []
    let modelCancelFired = false
    const modelChain = modelResponse.onUpdate(async data => {
      if (data instanceof Uint8Array) {
        modelImages.push(data)
        return
      }
      if (!modelCancelFired && typeof data === 'string') {
        modelCancelFired = true
        await model.cancel()
      }
    }).await()
    const upscalerImagesPromise = collectImages(upscalerResponse)

    const [, upscalerImages] = await Promise.all([
      expectCancelRejection(t, modelChain, 'coexistence model cancel'),
      upscalerImagesPromise
    ])

    t.ok(modelCancelFired, 'model cancel fired after progress tick')
    t.is(modelImages.length, 0, 'model cancel emitted no PNG output')
    t.is(upscalerImages.length, 1, 'upscaler completed while model was cancelled')
    assertPngDimensions(
      t,
      upscalerImages[0],
      expectedSize(16, 3),
      expectedSize(16, 3),
      'coexistence model cancel: standalone output'
    )
    saveImage(
      modelDir,
      'generate-image--coexistence-model-cancel-standalone.png',
      upscalerImages[0]
    )

    const [modelResponse2, upscalerResponse2] = await Promise.all([
      model.run(LONG_PARAMS),
      upscaler.upscale(TINY_PNG_16X16, { repeats: 3 })
    ])
    const modelImages2Promise = collectImages(modelResponse2)
    const upscalerImages2 = []
    const upscalerChain = upscalerResponse2.onUpdate(data => {
      if (data instanceof Uint8Array) {
        upscalerImages2.push(data)
      }
    }).await()

    const cancelPromise = upscaler.cancel()
    await Promise.all([
      expectCancelRejection(t, upscalerChain, 'coexistence upscaler cancel'),
      cancelPromise
    ])
    const modelImages2 = await modelImages2Promise

    t.is(upscalerImages2.length, 0, 'upscaler cancel emitted no PNG output')
    t.is(modelImages2.length, 1, 'model completed while upscaler was cancelled')
    assertPngDimensions(
      t,
      modelImages2[0],
      SOURCE_WIDTH,
      SOURCE_HEIGHT,
      'coexistence upscaler cancel: model output'
    )
    saveImage(
      modelDir,
      'generate-image--coexistence-upscaler-cancel-sd2.png',
      modelImages2[0]
    )
  } finally {
    await Promise.all([
      model.unload().catch(() => {}),
      upscaler.unload().catch(() => {})
    ])
    try {
      binding.releaseLogger()
    } catch (_) {}
  }
})

test('ESRGAN coexistence — unloading idle peer does not affect running peer', { timeout: testTimeout, skip }, async t => {
  setupJsLogger(binding)

  const { modelDir, modelPath, esrganPath } = await ensureSdAndEsrganPaths()
  t.ok(fs.existsSync(modelPath), 'SD model file exists on disk')
  t.ok(fs.existsSync(esrganPath), 'ESRGAN model file exists on disk')

  const model = createModel(modelPath, esrganPath)
  const upscaler = createUpscaler(esrganPath)

  try {
    await Promise.all([
      model.load(),
      upscaler.load()
    ])

    const modelResponse = await model.run(LONG_PARAMS)
    const modelImages = []
    let upscalerUnloadPromise = null
    const modelChain = modelResponse.onUpdate(data => {
      if (data instanceof Uint8Array) {
        modelImages.push(data)
        return
      }
      if (!upscalerUnloadPromise && typeof data === 'string') {
        upscalerUnloadPromise = upscaler.unload()
      }
    }).await()
    await modelChain
    await upscalerUnloadPromise

    t.ok(upscalerUnloadPromise, 'upscaler unload started after model progress')
    t.is(modelImages.length, 1, 'model completed while upscaler was unloaded')
    assertPngDimensions(
      t,
      modelImages[0],
      SOURCE_WIDTH,
      SOURCE_HEIGHT,
      'coexistence unload upscaler: model output'
    )
    saveImage(
      modelDir,
      'generate-image--coexistence-unload-upscaler-sd2.png',
      modelImages[0]
    )

    await upscaler.load()
    const reloadedUpscalerImages = await upscaler
      .upscale(TINY_PNG_16X16, { repeats: 1 })
      .then(collectImages)
    t.is(reloadedUpscalerImages.length, 1, 'upscaler can reload after unload')
    assertPngDimensions(
      t,
      reloadedUpscalerImages[0],
      expectedSize(16, 1),
      expectedSize(16, 1),
      'coexistence reload upscaler'
    )

    const upscalerResponse = await upscaler.upscale(TINY_PNG_16X16, {
      repeats: 3
    })
    const upscalerImagesPromise = collectImages(upscalerResponse)
    await sleep(STANDALONE_CANCEL_DELAY)
    await model.unload()
    const upscalerImages = await upscalerImagesPromise

    t.is(upscalerImages.length, 1, 'upscaler completed while model was unloaded')
    assertPngDimensions(
      t,
      upscalerImages[0],
      expectedSize(16, 3),
      expectedSize(16, 3),
      'coexistence unload model: standalone output'
    )
    saveImage(
      modelDir,
      'generate-image--coexistence-unload-model-standalone.png',
      upscalerImages[0]
    )

    await model.load()
    const reloadedModelImages = await model.run(BASE_PARAMS).then(collectImages)
    t.is(reloadedModelImages.length, 1, 'model can reload after unload')
    assertPngDimensions(
      t,
      reloadedModelImages[0],
      SOURCE_WIDTH,
      SOURCE_HEIGHT,
      'coexistence reload model'
    )
  } finally {
    await Promise.all([
      model.unload().catch(() => {}),
      upscaler.unload().catch(() => {})
    ])
    try {
      binding.releaseLogger()
    } catch (_) {}
  }
})

test('ESRGAN coexistence — same-tick load/unload lifecycle remains reusable', { timeout: testTimeout, skip }, async t => {
  setupJsLogger(binding)

  const { modelPath, esrganPath } = await ensureSdAndEsrganPaths()
  t.ok(fs.existsSync(modelPath), 'SD model file exists on disk')
  t.ok(fs.existsSync(esrganPath), 'ESRGAN model file exists on disk')

  const model = createModel(modelPath, esrganPath)
  const upscaler = createUpscaler(esrganPath)

  try {
    await model.load()

    // activate* currently runs synchronously inside the native binding. Firing
    // these operations in the same JS tick is the stable overlap this API can
    // express without moving load to a worker thread or mocking native load.
    await Promise.all([
      upscaler.load(),
      model.unload()
    ])

    const upscalerImages = await upscaler
      .upscale(TINY_PNG_16X16, { repeats: 1 })
      .then(collectImages)
    t.is(upscalerImages.length, 1, 'upscaler works after peer unload during load')
    assertPngDimensions(
      t,
      upscalerImages[0],
      expectedSize(16, 1),
      expectedSize(16, 1),
      'coexistence lifecycle upscaler output'
    )

    await Promise.all([
      model.load(),
      upscaler.unload()
    ])

    const modelImages = await model.run(BASE_PARAMS).then(collectImages)
    t.is(modelImages.length, 1, 'model works after peer unload during load')
    assertPngDimensions(
      t,
      modelImages[0],
      SOURCE_WIDTH,
      SOURCE_HEIGHT,
      'coexistence lifecycle model output'
    )

    await upscaler.load()
    const reloadedUpscalerImages = await upscaler
      .upscale(TINY_PNG_16X16, { repeats: 1 })
      .then(collectImages)
    t.is(reloadedUpscalerImages.length, 1, 'upscaler reloads after lifecycle overlap')
  } finally {
    await Promise.all([
      model.unload().catch(() => {}),
      upscaler.unload().catch(() => {})
    ])
    try {
      binding.releaseLogger()
    } catch (_) {}
  }
})
