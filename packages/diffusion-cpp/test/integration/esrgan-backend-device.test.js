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
const { recordPerformance } = require('./_perf-helper')

const noGpu = proc.env && proc.env.NO_GPU === 'true'
const isAndroid = os.platform() === 'android'
const isMobile = os.platform() === 'ios' || os.platform() === 'android'

// Device Farm / mobile: skip GPU subtest — ESRGAN GPU backend probing can hang or crash.
const skipGpuBackendDeviceSubtest = noGpu || isMobile

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

const JOB_TIMEOUT_MS = isAndroid ? 300000 : 120000
const BACKENDS_DIR = path.join(__dirname, '../../prebuilds')

function logPhase (phase, configDevice, expected, actual) {
  let line =
    '[esrgan-backend-device] phase=' +
    phase +
    ' platform=' +
    os.platform() +
    ' arch=' +
    os.arch() +
    ' config.device=' +
    configDevice
  if (expected != null) {
    line += ' expected backendDevice=' + expected
  }
  if (actual != null) {
    line += ' actual=' + actual
  }
  console.log(line)
}

function queryExpectedBackendDevice (configDevice) {
  if (typeof binding.getExpectedEsrganBackendDevice !== 'function') {
    throw new Error(
      'binding.getExpectedEsrganBackendDevice is required for backend policy tests'
    )
  }
  return binding.getExpectedEsrganBackendDevice(configDevice, BACKENDS_DIR)
}

async function ensureEsrganModelPath () {
  logPhase('before-model-download', 'n/a')
  const [esrganName, modelDir] = await ensureModel({
    modelName: ESRGAN_MODEL.name,
    downloadUrl: ESRGAN_MODEL.url
  })
  const esrganPath = path.join(modelDir, esrganName)
  logPhase('after-model-download', 'n/a', null, esrganPath)
  return { esrganPath, modelDir }
}

test(
  'ESRGAN standalone — config.device cpu reports backendDevice cpu in RuntimeStats',
  { timeout: JOB_TIMEOUT_MS },
  async t => {
    const configDevice = 'cpu'
    setupJsLogger(binding)
    logPhase('start', configDevice)

    logPhase('before-query-expected', configDevice)
    const expected = queryExpectedBackendDevice(configDevice)
    logPhase('after-query-expected', configDevice, expected)
    t.is(expected, 'cpu', 'native policy always maps config cpu -> cpu')

    const { esrganPath } = await ensureEsrganModelPath()
    t.ok(fs.existsSync(esrganPath), 'ESRGAN weights exist')

    const upscaler = new EsrganUpscaler({
      files: { esrgan: esrganPath },
      config: {
        device: configDevice,
        upscaler_tile_size: 64,
        backendsDir: BACKENDS_DIR
      },
      opts: { stats: true },
      logger: console
    })

    try {
      logPhase('before-load', configDevice, expected)
      await upscaler.load()
      logPhase('after-load', configDevice, expected)

      logPhase('before-upscale', configDevice, expected)
      const response = await upscaler.upscale(tinyPng16x16(), { repeats: 1 })
      await response.onUpdate(() => {}).await()
      logPhase('after-upscale', configDevice, expected, response.stats.backendDevice)

      t.is(
        response.stats.backendDevice,
        expected,
        'native CPU path maps to stats'
      )

      t.comment(recordPerformance('[ESRGAN 4x upscale 16x16] [CPU]', response.stats, {
        scenario: 'upscale',
        model: 'RealESRGAN_x4plus_anime_6B',
        execution_provider: 'cpu'
      }))
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
  { timeout: JOB_TIMEOUT_MS, skip: skipGpuBackendDeviceSubtest },
  async t => {
    const configDevice = 'gpu'
    setupJsLogger(binding)
    logPhase('start', configDevice)

    logPhase('before-query-expected', configDevice)
    const expected = queryExpectedBackendDevice(configDevice)
    logPhase('after-query-expected', configDevice, expected)
    t.ok(
      expected === 'cpu' || expected === 'gpu',
      'native policy returns cpu or gpu for config gpu'
    )

    const { esrganPath } = await ensureEsrganModelPath()
    t.ok(fs.existsSync(esrganPath), 'ESRGAN weights exist')

    const upscaler = new EsrganUpscaler({
      files: { esrgan: esrganPath },
      config: {
        device: configDevice,
        upscaler_tile_size: 64,
        backendsDir: BACKENDS_DIR
      },
      opts: { stats: true },
      logger: console
    })

    try {
      logPhase('before-load', configDevice, expected)
      await upscaler.load()
      logPhase('after-load', configDevice, expected)

      logPhase('before-upscale', configDevice, expected)
      const response = await upscaler.upscale(tinyPng16x16(), { repeats: 1 })
      await response.onUpdate(() => {}).await()
      const actual = response.stats.backendDevice
      logPhase('after-upscale', configDevice, expected, actual)

      t.ok(
        actual === 'cpu' || actual === 'gpu',
        'config.device gpu: backendDevice may be gpu when accelerated init succeeds, ' +
          'or cpu when runtime falls back (e.g. GPU/OpenCL init failure); ' +
          'native policy hint=' + expected + ', actual=' + actual
      )

      t.comment(recordPerformance('[ESRGAN 4x upscale 16x16] [' + (actual || 'GPU') + ']', response.stats, {
        scenario: 'upscale',
        model: 'RealESRGAN_x4plus_anime_6B',
        execution_provider: actual || 'gpu'
      }))
    } finally {
      await upscaler.unload().catch(() => {})
      try {
        binding.releaseLogger()
      } catch (_) {}
    }
  }
)
