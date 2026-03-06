'use strict'

const test = require('brittle')
const FilesystemDL = require('@qvac/dl-filesystem')
const os = require('bare-os')

const ImgStableDiffusion = require('../../index.js')
const { ensureModel } = require('./utils')

const platform = os.platform()
const arch = os.arch()
const isDarwinX64 = platform === 'darwin' && arch === 'x64'
const isLinuxArm64 = platform === 'linux' && arch === 'arm64'
const useCpu = isDarwinX64 || isLinuxArm64

const DEFAULT_MODEL = {
  name: 'stable-diffusion-v2-1-Q8_0.gguf',
  url: 'https://huggingface.co/gpustack/stable-diffusion-v2-1-GGUF/resolve/main/stable-diffusion-v2-1-Q8_0.gguf'
}

test('model loading - load and unload', { timeout: 600_000 }, async t => {
  const [downloadedModelName, modelDir] = await ensureModel({
    modelName: DEFAULT_MODEL.name,
    downloadUrl: DEFAULT_MODEL.url
  })

  const loader = new FilesystemDL({ dirPath: modelDir })
  const config = {
    threads: '4',
    device: useCpu ? 'cpu' : 'gpu',
    prediction: 'v'
  }

  const addon = new ImgStableDiffusion({
    loader,
    modelName: downloadedModelName,
    diskPath: modelDir,
    logger: console
  }, config)

  try {
    await addon.load()
    t.pass('model loaded successfully')

    await addon.unload()
    t.pass('model unloaded successfully')

    await addon.unload().catch(() => {})
    t.pass('second unload is idempotent')
  } finally {
    await loader.close().catch(() => {})
  }
})

// Keep event loop alive briefly to let pending async operations complete
// This prevents C++ destructors from running while async cleanup is still happening
// which can cause segfaults (exit code 139)
setImmediate(() => {
  setTimeout(() => {}, 500)
})
