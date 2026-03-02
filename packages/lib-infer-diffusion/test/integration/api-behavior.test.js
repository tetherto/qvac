'use strict'

const test = require('brittle')
const FilesystemDL = require('@qvac/dl-filesystem')
const ImgStableDiffusion = require('../../index.js')
const { ensureFlux2Models, collectImages } = require('./utils')

const SAFE_PROMPT = 'a small red cube on a white table, studio lighting, simple'

async function setupModel (t) {
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
    { threads: 4 }
  )

  await model.load()

  t.teardown(async () => {
    await model.unload().catch(() => {})
    await loader.close().catch(() => {})
  })

  return { model }
}

test('idle | run: produces image with valid PNG', { timeout: 600_000 }, async (t) => {
  const { model } = await setupModel(t)

  const response = await model.run({
    prompt: SAFE_PROMPT,
    steps: 5,
    width: 256,
    height: 256,
    seed: 42
  })

  t.ok(response, 'run() returns a response')
  t.ok(typeof response.onUpdate === 'function', 'response has onUpdate')
  t.ok(typeof response.await === 'function', 'response has await')

  const { images } = await collectImages(response)

  t.ok(images.length > 0, 'received at least one image')

  const png = images[0]
  t.ok(
    png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4E && png[3] === 0x47,
    'output starts with PNG magic bytes (\\x89PNG)'
  )
  t.ok(png.length > 100, `PNG has reasonable size (${png.length} bytes)`)
})

test('idle | cancel: no-op', { timeout: 600_000 }, async (t) => {
  const { model } = await setupModel(t)
  await model.cancel()
  t.pass('cancel when idle does not throw')
})

test('run | cancel: stops generation', { timeout: 600_000 }, async (t) => {
  const { model } = await setupModel(t)

  const response = await model.run({
    prompt: SAFE_PROMPT,
    steps: 50,
    width: 512,
    height: 512,
    seed: 1
  })

  await model.cancel()

  try {
    await response.await()
  } catch (err) {
    if (!/cancel|aborted|stopp?ed|unloaded/i.test(err?.message || '')) throw err
  }

  t.pass('cancel during run resolves and stops job')
})

test('progress ticks arrive during generation', { timeout: 600_000 }, async (t) => {
  const { model } = await setupModel(t)

  const response = await model.run({
    prompt: SAFE_PROMPT,
    steps: 10,
    width: 256,
    height: 256,
    seed: 7
  })

  const { ticks, images } = await collectImages(response)

  t.ok(ticks.length > 0, `received ${ticks.length} progress tick(s)`)
  t.ok(ticks[0].step >= 0, 'first tick has step >= 0')
  t.ok(ticks[0].total > 0, 'first tick has a total')
  t.ok(images.length > 0, 'image arrives after ticks')
})

test('stats contain generation_time', { timeout: 600_000 }, async (t) => {
  const { model } = await setupModel(t)

  const response = await model.run({
    prompt: SAFE_PROMPT,
    steps: 5,
    width: 256,
    height: 256,
    seed: 1
  })

  await collectImages(response)

  t.ok(response.stats, 'response has stats')
  t.ok('generation_time' in response.stats, 'stats contains generation_time')
})

setImmediate(() => {
  setTimeout(() => {}, 500)
})
