'use strict'

const test = require('brittle')
const FilesystemDL = require('@qvac/dl-filesystem')
const ImgStableDiffusion = require('../../index.js')
const { ensureFlux2Models, collectImages } = require('./utils')

const SAFE_PROMPT = 'a small red cube on a white table, studio lighting, simple'

function createModel (models, loader) {
  return new ImgStableDiffusion(
    {
      loader,
      logger: console,
      diskPath: models.modelsDir,
      modelName: models.modelName,
      llmModel: models.llmModel,
      vaeModel: models.vaeModel
    },
    { threads: 4 }
  )
}

test('load and unload end-to-end', { timeout: 600_000 }, async (t) => {
  const models = ensureFlux2Models()
  const loader = new FilesystemDL({ dirPath: models.modelsDir })

  const model = createModel(models, loader)

  try {
    await model.load()
    t.pass('model loaded successfully')
  } finally {
    await model.unload()
    await loader.close()
    t.pass('model unloaded successfully')
  }
})

test('unload is idempotent', { timeout: 600_000 }, async (t) => {
  const models = ensureFlux2Models()
  const loader = new FilesystemDL({ dirPath: models.modelsDir })

  const model = createModel(models, loader)

  try {
    await model.load()

    await model.unload()
    t.pass('first unload succeeded')

    await model.unload()
    t.pass('second unload succeeded (idempotent)')
  } finally {
    await loader.close()
  }
})

test('load, generate, unload cycle', { timeout: 600_000 }, async (t) => {
  const models = ensureFlux2Models()
  const loader = new FilesystemDL({ dirPath: models.modelsDir })

  const model = createModel(models, loader)

  try {
    await model.load()
    t.pass('loaded')

    const response = await model.run({
      prompt: SAFE_PROMPT,
      steps: 5,
      width: 256,
      height: 256,
      seed: 100
    })

    const { images } = await collectImages(response)
    t.ok(images.length > 0, 'generation produced an image')

    await model.unload()
    t.pass('unloaded after generation')
  } finally {
    await loader.close().catch(() => {})
  }
})

setImmediate(() => {
  setTimeout(() => {}, 500)
})
