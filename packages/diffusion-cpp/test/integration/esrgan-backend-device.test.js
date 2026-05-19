'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const os = require('bare-os')
const proc = require('bare-process')
const b4a = require('b4a')
const test = require('brittle')
const binding = require('../../binding')
const { EsrganUpscaler } = require('../../index')
const { ensureModel, setupJsLogger } = require('./utils')

const noGpu = proc.env && proc.env.NO_GPU === 'true'
const isAndroid = os.platform() === 'android'

const ESRGAN_MODEL = {
  name: 'RealESRGAN_x4plus_anime_6B.pth',
  url: 'https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.2.4/RealESRGAN_x4plus_anime_6B.pth'
}

// Valid 16×16 RGB PNG — backendDevice assertions only; keep inputs tiny for
// slow CPU runners (e.g. linux-arm64 integration).
const TINY_PNG_16X16_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAABuElEQVR4nA3NQQEAIQgEQCMQwec+iWAEIhCBCEYgghGMYAQD7IMIRribAtNagzT2Bm0cDdboDdE4G7JxNezG03Abq+E1tiYUQReqYAhN4MIQTGEKlnALjvAKSvgErXVIZ+/QztFhnd4RnbMjO1fH7jwdt7M6Xv8HpSi6UhVDaQpXhmIqU7GUW3GUV1HKp/8wIIN9QAfHgA36QAzOgRxcA3vwDNzBGnjjH4xi6EY1DKMZ3BiGaUzDMm7DMV5DGZ/9g0Oc3aHO4TCnO8I5Helcju08jussx/N/CEqgBzUwghbwYARmMAMruAMneAMVfPEPEzLZJ3RyTNikT8TknMjJNbEnz8SdrIk3/yEpiZ7UxEhawpORmMlMrOROnORNVPLlPyzIYl/QxbFgi74Qi3MhF9fCXjwLd7EW3vqHTdnom7oxNm3DN2NjbubG2twbZ/Nu1Obb/3Agh/1AD8eBHfpBHM6DPFwH+/Ac3MM6eOcfLuWiX+rFuLQLv4yLeZkX63JfnMt7UZfv/kNBir2gxVGwoheiOAtZXIVdPIVbrMKrf3iUh/6oD+PRHvwxHuZjPqzH/XAe70M9vocPli9yEL9ki4IAAAAASUVORK5CYII='

function tinyPng16x16 () {
  return b4a.from(TINY_PNG_16X16_B64, 'base64')
}

const JOB_TIMEOUT_MS = 120000
const BACKENDS_DIR = path.join(__dirname, '../../prebuilds')

function queryExpectedBackendDevice (configDevice) {
  if (typeof binding.getExpectedEsrganBackendDevice !== 'function') {
    throw new Error(
      'binding.getExpectedEsrganBackendDevice is required for backend policy tests'
    )
  }
  return binding.getExpectedEsrganBackendDevice(configDevice, BACKENDS_DIR)
}

function logBackendPolicy (configDevice, expected, actual) {
  console.log(
    '[esrgan-backend-device] platform=' +
      os.platform() +
      ' config.device=' +
      configDevice +
      ' expected backendDevice=' +
      expected +
      (actual != null ? ' actual=' + actual : '')
  )
}

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
    const expected = queryExpectedBackendDevice('cpu')
    t.is(expected, 'cpu', 'native policy always maps config cpu -> cpu')
    logBackendPolicy('cpu', expected)

    const { esrganPath } = await ensureEsrganModelPath()
    t.ok(fs.existsSync(esrganPath), 'ESRGAN weights exist')

    const upscaler = new EsrganUpscaler({
      files: { esrgan: esrganPath },
      config: {
        device: 'cpu',
        upscaler_tile_size: 64,
        backendsDir: BACKENDS_DIR
      },
      opts: { stats: true },
      logger: console
    })

    try {
      await upscaler.load()
      const response = await upscaler.upscale(tinyPng16x16(), { repeats: 1 })
      await response.onUpdate(() => {}).await()
      logBackendPolicy('cpu', expected, response.stats.backendDevice)
      t.is(
        response.stats.backendDevice,
        expected,
        'native CPU path maps to stats'
      )
    } finally {
      await upscaler.unload().catch(() => {})
      try {
        binding.releaseLogger()
      } catch (_) {}
    }
  }
)

test(
  'ESRGAN standalone — config.device gpu reports policy-aligned backendDevice in RuntimeStats',
  { timeout: JOB_TIMEOUT_MS, skip: noGpu },
  async t => {
    setupJsLogger(binding)
    const expected = queryExpectedBackendDevice('gpu')
    t.ok(
      expected === 'cpu' || expected === 'gpu',
      'native policy returns cpu or gpu for config gpu'
    )
    logBackendPolicy('gpu', expected)

    const { esrganPath } = await ensureEsrganModelPath()
    t.ok(fs.existsSync(esrganPath), 'ESRGAN weights exist')

    const upscaler = new EsrganUpscaler({
      files: { esrgan: esrganPath },
      config: {
        device: 'gpu',
        upscaler_tile_size: 64,
        backendsDir: BACKENDS_DIR
      },
      opts: { stats: true },
      logger: console
    })

    try {
      await upscaler.load()
      const response = await upscaler.upscale(tinyPng16x16(), { repeats: 1 })
      await response.onUpdate(() => {}).await()
      const actual = response.stats.backendDevice
      logBackendPolicy('gpu', expected, actual)

      t.is(
        actual,
        expected,
        expected === 'cpu'
          ? 'Adreno 600/700 policy: config gpu may run on CPU backend'
          : 'GPU policy: expect accelerated backend (OpenCL on Adreno 800+, Vulkan elsewhere)'
      )
    } finally {
      await upscaler.unload().catch(() => {})
      try {
        binding.releaseLogger()
      } catch (_) {}
      if (isAndroid) {
        console.log(
          '[esrgan-backend-device] Android run complete; check native logs for OpenCL/GPU init'
        )
      }
    }
  }
)
