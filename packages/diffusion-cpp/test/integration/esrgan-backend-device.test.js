'use strict'

// GPU strict assertion: set QVAC_INTEGRATION_UPSCALER_GPU=1 on runners with a
// working Vulkan (or other ggml GPU) backend for ESRGAN; otherwise the gpu
// case only checks backendDevice is 'cpu' or 'gpu'.

const fs = require('bare-fs')
const path = require('bare-path')
const proc = require('bare-process')
const test = require('brittle')
const binding = require('../../binding')
const { EsrganUpscaler } = require('../../index')
const { ensureModel, setupJsLogger } = require('./utils')

const ESRGAN_MODEL = {
  name: 'RealESRGAN_x4plus_anime_6B.pth',
  url: 'https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.2.4/RealESRGAN_x4plus_anime_6B.pth'
}

const INPUT_JPEG = new Uint8Array(
  fs.readFileSync(
    path.join(__dirname, '..', '..', 'assets', 'von-neumann.jpg')
  )
)

const JOB_TIMEOUT_MS = 300000

async function ensureEsrganModelPath () {
  const [esrganName, modelDir] = await ensureModel({
    modelName: ESRGAN_MODEL.name,
    downloadUrl: ESRGAN_MODEL.url
  })
  return { esrganPath: path.join(modelDir, esrganName), modelDir }
}

test(
  'ESRGAN standalone — config.device cpu reports backendDevice cpu in RuntimeStats',
  { timeout: JOB_TIMEOUT_MS },
  async t => {
    setupJsLogger(binding)
    const { esrganPath } = await ensureEsrganModelPath()
    t.ok(fs.existsSync(esrganPath), 'ESRGAN weights exist')

    const upscaler = new EsrganUpscaler({
      files: { esrgan: esrganPath },
      config: {
        device: 'cpu',
        upscaler_tile_size: 128
      },
      opts: { stats: true },
      logger: console
    })

    try {
      await upscaler.load()
      const response = await upscaler.upscale(INPUT_JPEG, { repeats: 1 })
      await response.onUpdate(() => {}).await()
      t.is(response.stats.backendDevice, 'cpu', 'native CPU path maps to stats')
    } finally {
      await upscaler.unload().catch(() => {})
      try {
        binding.releaseLogger()
      } catch (_) {}
    }
  }
)

test(
  'ESRGAN standalone — config.device gpu surfaces backendDevice in RuntimeStats',
  { timeout: JOB_TIMEOUT_MS },
  async t => {
    setupJsLogger(binding)
    const { esrganPath } = await ensureEsrganModelPath()
    t.ok(fs.existsSync(esrganPath), 'ESRGAN weights exist')

    const upscaler = new EsrganUpscaler({
      files: { esrgan: esrganPath },
      config: {
        device: 'gpu',
        upscaler_tile_size: 128
      },
      opts: { stats: true },
      logger: console
    })

    try {
      await upscaler.load()
      const response = await upscaler.upscale(INPUT_JPEG, { repeats: 1 })
      await response.onUpdate(() => {}).await()
      const dev = response.stats.backendDevice
      t.ok(
        dev === 'cpu' || dev === 'gpu',
        'backendDevice is cpu or gpu after gpu preference'
      )
      if (proc.env.QVAC_INTEGRATION_UPSCALER_GPU === '1') {
        t.is(
          dev,
          'gpu',
          'QVAC_INTEGRATION_UPSCALER_GPU=1 expects a live GPU upscaler backend'
        )
      }
    } finally {
      await upscaler.unload().catch(() => {})
      try {
        binding.releaseLogger()
      } catch (_) {}
    }
  }
)
