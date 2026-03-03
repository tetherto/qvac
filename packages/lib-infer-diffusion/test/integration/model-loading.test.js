'use strict'

const test = require('brittle')
const path = require('bare-path')
const fs = require('bare-fs')
const { ensureModelPath } = require('./utils')

const MODEL_URL = process.env.SD_TEST_MODEL_URL
const MODEL_NAME = process.env.SD_TEST_MODEL_NAME || 'sd-test-model.safetensors'

test('model loading - load and unload', async t => {
  if (!MODEL_URL) {
    t.pass('Skipped: SD_TEST_MODEL_URL not set')
    return
  }

  const modelPath = await ensureModelPath({
    modelName: MODEL_NAME,
    downloadUrl: MODEL_URL
  })

  t.ok(fs.existsSync(modelPath), 'model file exists')

  const ImgStableDiffusion = require('../../index')
  const FilesystemDL = require('@qvac/dl-filesystem')

  const modelDir = path.dirname(modelPath)
  const loader = new FilesystemDL({ dirPath: modelDir })

  const model = new ImgStableDiffusion(
    {
      loader,
      logger: console,
      diskPath: modelDir,
      modelName: path.basename(modelPath)
    },
    { threads: 4 }
  )

  await model.load()
  t.pass('model loaded successfully')

  await model.unload()
  await loader.close()
  t.pass('model unloaded successfully')
})
