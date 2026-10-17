'use strict'

const test = require('brittle')
const ImgStableDiffusion = require('../../index')
const files = {
  model: '/models/image.gguf',
  llm: '/models/encoder.gguf',
  llmVision: '/models/projector.gguf',
  vae: '/models/vae.safetensors'
}
const logger = { error() {}, warn() {}, info() {}, debug() {} }

test('image load passes the separate vision projector to the addon', async (t) => {
  const model = new ImgStableDiffusion({ files, logger })
  let captured
  model._createAddon = (params) => {
    captured = params
    return { activate: () => Promise.resolve(), unload: () => Promise.resolve() }
  }
  await model.load()
  t.is(captured.llmVisionPath, files.llmVision)
  t.is(captured.llmPath, files.llm)
  t.is(captured.diffusionModelPath, files.model)
  await model.unload()
})

for (const multiple of [false, true]) {
  test(`reference editing reaches native model detection (${multiple ? 'multiple' : 'single'})`, async (t) => {
    const model = new ImgStableDiffusion({ files, logger })
    const first = new Uint8Array([1, 2, 3])
    const second = new Uint8Array([4, 5, 6])
    let captured
    model.addon = {
      runJob: (params) => {
        captured = params
        return Promise.resolve(false)
      }
    }
    await t.exception.all(
      model.run({
        prompt: 'Place the teapot beside the vase.',
        width: 512,
        height: 512,
        ...(multiple ? { init_images: [first, second] } : { init_image: first })
      }),
      /a job is already set or being processed/
    )
    t.is(captured.mode, 'img2img')
    if (multiple) t.alike(captured.init_images, [first, second])
    else t.is(captured.init_image, first)
  })
}
