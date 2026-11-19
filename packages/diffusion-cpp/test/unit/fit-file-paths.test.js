'use strict'

const test = require('brittle')

const { toFilePaths } = require('../../file-paths.js')

const LTX_FILES = {
  model: '/models/ltx-video.gguf',
  t5Xxl: '/models/t5xxl.gguf',
  vae: '/models/ltx-vae.gguf',
  audioVae: '/models/ltx-audio-vae.gguf',
  embeddingsConnectors: '/models/ltx-connectors.gguf'
}

test('a video file set keeps its companion files', (t) => {
  const paths = toFilePaths(LTX_FILES)

  t.is(paths.audioVaePath, LTX_FILES.audioVae)
  t.is(paths.embeddingsConnectorsPath, LTX_FILES.embeddingsConnectors)
})

test('an absent companion file is an empty path', (t) => {
  const paths = toFilePaths({ model: '/models/sd.gguf' })

  t.is(paths.audioVaePath, '')
  t.is(paths.embeddingsConnectorsPath, '')
  t.is(paths.clipVisionPath, '')
})

test('Qwen vision projector is distinct from CLIP vision for load and fit', async (t) => {
  const files = {
    model: '/models/qwen-image-21.gguf',
    llm: '/models/qwen3vl.gguf',
    llmVision: '/models/mmproj.gguf',
    clipVision: '/models/clip-vision.gguf',
    vae: '/models/qwen-image-21-vae.safetensors'
  }
  const paths = toFilePaths(files)
  t.is(paths.path, '')
  t.is(paths.diffusionModelPath, files.model)
  t.is(paths.llmVisionPath, files.llmVision)
  t.is(paths.clipVisionPath, files.clipVision)
  t.is(toFilePaths({ model: '/models/sd.gguf' }).llmVisionPath, '')
  const { assertFilePaths } = require('../../file-paths.js')
  await t.exception.all(
    () => assertFilePaths({ ...files, llmVision: 'relative.gguf' }),
    /files.llmVision/
  )
  await t.exception.all(() => assertFilePaths({ ...files, llmVision: '' }), /files.llmVision/)
})

test('MOSS tokenizer is mapped and validated for load and fit', async (t) => {
  const { assertFilePaths } = require('../../file-paths.js')
  const files = {
    model: '/models/moss_image_sft_bf16.safetensors',
    llm: '/models/Qwen3.5-9B-Q4_K_M.gguf',
    vae: '/models/flux2-vae_small.safetensors',
    tokenizer: '/models/tokenizer.json'
  }
  assertFilePaths(files)
  const paths = toFilePaths(files)
  t.is(paths.path, '')
  t.is(paths.diffusionModelPath, files.model)
  t.is(paths.tokenizerPath, files.tokenizer)
  t.is(toFilePaths({ model: '/models/sd.gguf' }).tokenizerPath, '')
  for (const tokenizer of ['', 'relative/tokenizer.json']) {
    await t.exception.all(() => assertFilePaths({ ...files, tokenizer }), /files.tokenizer/)
  }
})

test('Core ML sidecars and tiny autoencoder paths are mapped and validated', async (t) => {
  const { assertFilePaths } = require('../../file-paths.js')
  const files = {
    model: '/models/sd.gguf',
    taesd: '/models/taesd.safetensors',
    coremlUnet: '/models/unet.mlmodelc',
    coremlTaeDecoder: '/models/decoder.mlmodelc'
  }
  assertFilePaths(files)
  const paths = toFilePaths(files)
  t.is(paths.path, files.model, 'sidecars preserve the all-in-one model layout')
  for (const key of ['taesd', 'coremlUnet', 'coremlTaeDecoder']) {
    t.is(paths[`${key}Path`], files[key])
    t.is(toFilePaths({ model: files.model })[`${key}Path`], '')
    for (const invalid of ['', 'relative.mlmodelc', null, 42]) {
      await t.exception.all(() => assertFilePaths({ ...files, [key]: invalid }), {
        message: new RegExp(`files\\.${key}`)
      })
    }
  }
})

test('image load forwards Core ML sidecars and ggml tiny weights to the addon', async (t) => {
  const ImgStableDiffusion = require('../../index')
  const files = {
    model: '/models/sd.gguf',
    taesd: '/models/taesd.safetensors',
    coremlUnet: '/models/unet.mlmodelc',
    coremlTaeDecoder: '/models/decoder.mlmodelc'
  }
  const model = new ImgStableDiffusion({ files, logger: null })
  let captured
  model._createAddon = (params) => {
    captured = params
    return { activate: () => Promise.resolve(), unload: () => Promise.resolve() }
  }
  try {
    await model.load()
    t.is(captured.path, files.model)
    t.is(captured.taesdPath, files.taesd)
    t.is(captured.coremlUnetPath, files.coremlUnet)
    t.is(captured.coremlTaeDecoderPath, files.coremlTaeDecoder)
  } finally {
    await model.unload()
  }
})
