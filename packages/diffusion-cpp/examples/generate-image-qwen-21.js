'use strict'

const path = require('bare-path')
const process = require('bare-process')
const fs = require('bare-fs')
const ImgStableDiffusion = require('../index')

async function main () {
  const dir = path.resolve(process.env.QWEN_MODELS_DIR || path.join(__dirname, '../models/qwen-image-21'))
  const output = path.resolve(process.env.QWEN_OUTPUT || path.join(__dirname, '../output/qwen-image-21.png'))
  const refs = process.argv.slice(2).map(file => fs.readFileSync(path.resolve(file)))
  const width = Number(process.env.QWEN_WIDTH || 512)
  const height = Number(process.env.QWEN_HEIGHT || 512)
  if (![width, height].every(value => Number.isInteger(value) && value > 0 && value % 32 === 0)) {
    throw new Error('Qwen-Image-2.1 width and height must be positive multiples of 32')
  }
  const model = new ImgStableDiffusion({
    files: {
      model: path.join(dir, 'qwen_image_2.1-Q4_K.gguf'),
      llm: path.join(dir, 'Qwen3VL-8B-Instruct-Q4_K_M.gguf'),
      vae: path.join(dir, 'qwen_image_2.1_vae_bf16.safetensors'),
      ...(refs.length ? { llmVision: path.join(dir, 'mmproj-Qwen3VL-8B-Instruct-F16.gguf') } : {})
    },
    config: {
      backend: process.env.QWEN_BACKEND || 'cuda0',
      params_backend: process.env.QWEN_BACKEND || 'cuda0',
      threads: 8,
      diffusion_fa: true,
      vae_conv_direct: false,
      vae_decode_only: refs.length === 0
    },
    opts: { stats: true },
    logger: console
  })
  try {
    const loadStart = Date.now()
    await model.load()
    console.log(JSON.stringify({ event: 'loaded', elapsedMs: Date.now() - loadStart }))
    const start = Date.now()
    const response = await model.run({
      prompt: process.env.QWEN_PROMPT || 'A red ceramic teapot on a wooden table, soft daylight, product photograph.',
      width,
      height,
      steps: Number(process.env.QWEN_STEPS || 30),
      seed: Number(process.env.QWEN_SEED || 42),
      cfg_scale: 6,
      sampling_method: 'euler',
      ...(refs.length === 1 ? { init_image: refs[0] } : refs.length > 1 ? { init_images: refs } : {})
    })
    const images = []
    await response.onUpdate(data => {
      if (data instanceof Uint8Array) images.push(data)
    }).await()
    if (images.length !== 1) throw new Error(`Expected one PNG, got ${images.length}`)
    fs.mkdirSync(path.dirname(output), { recursive: true })
    fs.writeFileSync(output, images[0])
    console.log(JSON.stringify({ event: 'generated', output, width, height, elapsedMs: Date.now() - start }))
  } finally {
    await model.unload()
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
