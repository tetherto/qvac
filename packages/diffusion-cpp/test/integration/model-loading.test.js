'use strict'

const path = require('bare-path')
const os = require('bare-os')
const proc = require('bare-process')

const ImgStableDiffusion = require('../../index.js')
const { ensureModel, safeTest } = require('./utils.js')

const platform = os.platform()
const arch = os.arch()
const isDarwinX64 = platform === 'darwin' && arch === 'x64'
const isLinuxArm64 = platform === 'linux' && arch === 'arm64'
const noGpu = proc.env && proc.env.NO_GPU === 'true'
const useCpu = isDarwinX64 || isLinuxArm64 || noGpu
const isWindows = platform === 'win32'
const isMobile = platform === 'android' || platform === 'ios'

// Windows Vulkan and mobile GPU backends are much slower; increase timeout so a
// slow load/generation (or a retried large-model download) doesn't fail the test.
const BASE_TIMEOUT = 600_000
const testTimeout = (isWindows || isMobile) ? BASE_TIMEOUT * 2 : BASE_TIMEOUT

const DEFAULT_MODEL = {
  name: 'stable-diffusion-v2-1-Q8_0.gguf',
  url: 'https://huggingface.co/gpustack/stable-diffusion-v2-1-GGUF/resolve/main/stable-diffusion-v2-1-Q8_0.gguf'
}

safeTest('model loading - load and unload', { timeout: testTimeout }, async t => {
  let addon = null
  try {
    const [downloadedModelName, modelDir] = await ensureModel({
      modelName: DEFAULT_MODEL.name,
      downloadUrl: DEFAULT_MODEL.url
    })

    const config = {
      threads: '4',
      device: useCpu ? 'cpu' : 'gpu',
      prediction: 'v',
      diffusion_fa: true
    }

    addon = new ImgStableDiffusion({
      files: {
        model: path.join(modelDir, downloadedModelName)
      },
      config: {
        ...config,
        verbosity: 2
      },
      logger: console,
      opts: { stats: true }
    })

    await addon.load()
    t.pass('model loaded successfully')

    await addon.unload()
    t.pass('model unloaded successfully')

    await addon.unload().catch(() => {})
    t.pass('second unload is idempotent')
  } finally {
    if (addon) await addon.unload().catch(() => {})
  }
})

// Keep event loop alive briefly to let pending async operations complete
// This prevents C++ destructors from running while async cleanup is still happening
// which can cause segfaults (exit code 139)
setImmediate(() => {
  setTimeout(() => {}, 500)
})
