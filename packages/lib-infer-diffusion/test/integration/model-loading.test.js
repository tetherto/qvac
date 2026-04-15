'use strict'

const test = require('brittle')
const os = require('bare-os')
const proc = require('bare-process')

const ImgStableDiffusion = require('../../index.js')
const { ensureModel } = require('./utils')

const platform = os.platform()
const arch = os.arch()
const isDarwinX64 = platform === 'darwin' && arch === 'x64'
const isLinuxArm64 = platform === 'linux' && arch === 'arm64'
const noGpu = proc.env && proc.env.NO_GPU === 'true'
const useCpu = isDarwinX64 || isLinuxArm64 || noGpu
const isWindows = platform === 'win32'

// Windows Vulkan backend is slower, increase timeout
const BASE_TIMEOUT = 600_000
const testTimeout = isWindows ? BASE_TIMEOUT * 2 : BASE_TIMEOUT

const DEFAULT_MODEL = {
  name: 'stable-diffusion-v2-1-Q8_0.gguf',
  url: 'https://huggingface.co/gpustack/stable-diffusion-v2-1-GGUF/resolve/main/stable-diffusion-v2-1-Q8_0.gguf'
}

test('model loading - load and unload', { timeout: testTimeout }, async t => {
  const [downloadedModelName, modelDir] = await ensureModel({
    modelName: DEFAULT_MODEL.name,
    downloadUrl: DEFAULT_MODEL.url
  })

  const config = {
    threads: '4',
    device: useCpu ? 'cpu' : 'gpu',
    prediction: 'v'
  }

  const addon = new ImgStableDiffusion({
    modelName: downloadedModelName,
    diskPath: modelDir,
    logger: console
  }, config)

  await addon.load()
  t.pass('model loaded successfully')

  await addon.unload()
  t.pass('model unloaded successfully')

  await addon.unload().catch(() => {})
  t.pass('second unload is idempotent')
})

// Keep event loop alive briefly to let pending async operations complete
// This prevents C++ destructors from running while async cleanup is still happening
// which can cause segfaults (exit code 139)
setImmediate(() => {
  setTimeout(() => {}, 500)
})
