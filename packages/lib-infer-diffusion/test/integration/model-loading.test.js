'use strict'

const test = require('brittle')
const FilesystemDL = require('@qvac/dl-filesystem')

const ImgStableDiffusion = require('../../index.js')
const { ensureModel } = require('./utils')

const MODEL_URL = process.env.SD_TEST_MODEL_URL

test('model loading - load and unload', { timeout: 600_000, skip: !MODEL_URL }, async t => {
  const modelName = MODEL_URL.split('/').pop()
  const [downloadedModelName, modelDir] = await ensureModel({
    modelName,
    downloadUrl: MODEL_URL
  })

  const loader = new FilesystemDL({ dirPath: modelDir })
  const config = {
    threads: '4',
    device: 'cpu'
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
setImmediate(() => {
  setTimeout(() => {}, 500)
})
