'use strict'

const test = require('brittle')
const FilesystemDL = require('@qvac/dl-filesystem')
const ImgStableDiffusion = require('../../index.js')
const { ensureFlux2Models, collectImages } = require('./utils')

const SAFE_PROMPT = 'a small blue sphere, plain white background, minimal'

async function setupModel (t, configOverrides = {}) {
  const models = ensureFlux2Models()
  const loader = new FilesystemDL({ dirPath: models.modelsDir })

  const model = new ImgStableDiffusion(
    {
      loader,
      logger: console,
      diskPath: models.modelsDir,
      modelName: models.modelName,
      llmModel: models.llmModel,
      vaeModel: models.vaeModel,
      opts: { stats: true }
    },
    { threads: 4, ...configOverrides }
  )

  await model.load()

  t.teardown(async () => {
    await model.unload().catch(() => {})
    await loader.close().catch(() => {})
  })

  return { model }
}

test('fixed seed accepted and produces an image', { timeout: 600_000 }, async (t) => {
  const { model } = await setupModel(t)

  const response = await model.run({
    prompt: SAFE_PROMPT,
    steps: 5,
    width: 256,
    height: 256,
    seed: 999
  })
  const { images } = await collectImages(response)

  t.ok(images.length >= 1, 'fixed seed run produced an image')
  t.ok(images[0].length > 100, 'image has reasonable byte size')
})

test('256x256 dimensions accepted', { timeout: 600_000 }, async (t) => {
  const { model } = await setupModel(t)

  const response = await model.run({
    prompt: SAFE_PROMPT,
    steps: 5,
    width: 256,
    height: 256,
    seed: 1
  })

  const { images } = await collectImages(response)
  t.ok(images.length > 0, '256x256 generation produced an image')
  t.ok(images[0].length > 100, 'image has reasonable byte size')
})

test('512x512 dimensions accepted', { timeout: 600_000 }, async (t) => {
  const { model } = await setupModel(t)

  const response = await model.run({
    prompt: SAFE_PROMPT,
    steps: 5,
    width: 512,
    height: 512,
    seed: 1
  })

  const { images } = await collectImages(response)
  t.ok(images.length > 0, '512x512 generation produced an image')
  t.ok(images[0].length > 100, 'image has reasonable byte size')
})

test('low step count (3) still produces an image', { timeout: 600_000 }, async (t) => {
  const { model } = await setupModel(t)

  const response = await model.run({
    prompt: SAFE_PROMPT,
    steps: 3,
    width: 256,
    height: 256,
    seed: 10
  })

  const { images } = await collectImages(response)
  t.ok(images.length > 0, '3-step generation produced an image')
})

test('guidance parameter accepted', { timeout: 600_000 }, async (t) => {
  const { model } = await setupModel(t)

  const response = await model.run({
    prompt: SAFE_PROMPT,
    steps: 5,
    width: 256,
    height: 256,
    guidance: 7.5,
    seed: 42
  })

  const { images } = await collectImages(response)
  t.ok(images.length > 0, 'generation with guidance=7.5 produced an image')
})

test('negative prompt accepted', { timeout: 600_000 }, async (t) => {
  const { model } = await setupModel(t)

  const response = await model.run({
    prompt: SAFE_PROMPT,
    negative_prompt: 'blurry, low quality',
    steps: 5,
    width: 256,
    height: 256,
    seed: 42
  })

  const { images } = await collectImages(response)
  t.ok(images.length > 0, 'generation with negative prompt produced an image')
})

setImmediate(() => {
  setTimeout(() => {}, 500)
})
