'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const process = require('bare-process')
const ImgStableDiffusion = require('../index')

async function main() {
  const modelsDir = path.resolve(
    process.env.FLUX3_MODELS_DIR || path.join(__dirname, '../models/flux3')
  )
  const output = path.resolve(process.env.FLUX3_OUTPUT || 'flux3.png')
  const references = process.argv.slice(2)
  if (references.length > 10) throw new Error('FLUX.3 supports at most 10 reference images')
  const width = Number(process.env.FLUX3_WIDTH || 512)
  const height = Number(process.env.FLUX3_HEIGHT || 512)
  const seed = Number(process.env.FLUX3_SEED || 42)
  if (![width, height].every((n) => Number.isSafeInteger(n) && n > 0 && n % 32 === 0)) {
    throw new Error('FLUX3_WIDTH and FLUX3_HEIGHT must be positive multiples of 32')
  }
  if (!Number.isSafeInteger(seed) || seed < 0) {
    throw new Error('FLUX3_SEED must be a nonnegative safe integer')
  }
  const files = {
    model: path.join(modelsDir, 'flux3-image-klein-Q8_0.gguf'),
    llm: path.join(modelsDir, 'Qwen3VL-4B-Instruct-Q4_K_M.gguf'),
    vae: path.join(modelsDir, 'flux3-vae.safetensors')
  }
  for (const file of Object.values(files)) {
    if (!fs.existsSync(file)) throw new Error(`Missing FLUX.3 asset: ${file}`)
  }
  const initImages = references.map((file) => fs.readFileSync(path.resolve(file)))
  const model = new ImgStableDiffusion({
    files,
    config: {
      prediction: 'auto',
      diffusion_fa: true,
      ...(process.env.FLUX3_BACKEND ? { backend: process.env.FLUX3_BACKEND } : {})
    },
    logger: console
  })
  try {
    await model.load()
    let png
    const response = await model.run({
      prompt:
        process.env.FLUX3_PROMPT ||
        (references.length
          ? 'Place the subject in a lush garden, preserving its appearance.'
          : 'A lovely cat holding a sign that says FLUX3'),
      width,
      height,
      seed,
      steps: 16,
      cfg_scale: 1,
      sampling_method: 'euler',
      scheduler: 'discrete',
      ...(initImages.length ? { init_images: initImages } : {})
    })
    await response
      .onUpdate((data) => {
        if (data instanceof Uint8Array) png = data
      })
      .await()
    if (!png) throw new Error('FLUX.3 completed without a PNG')
    fs.mkdirSync(path.dirname(output), { recursive: true })
    fs.writeFileSync(output, png)
    console.log(`Saved ${output}`)
  } finally {
    await model.unload()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
