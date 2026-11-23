'use strict'

const path = require('bare-path')
const process = require('bare-process')
const fs = require('bare-fs')

async function main() {
  const args = process.argv.slice(2)
  if (args.length === 1 && args[0] === '--help') {
    console.log(
      'Usage: bare examples/generate-image-fibo2-edit-turbo.js reference.png [reference2.png ...]'
    )
    console.log('Provide one to four ordered reference images. Uses four steps and CFG 1.')
    console.log(
      'Optional: FIBO_MODELS_DIR, FIBO_PROMPT, FIBO_OUTPUT, FIBO_BACKEND, FIBO_WIDTH, FIBO_HEIGHT, FIBO_SEED.'
    )
    return
  }
  if (args.length < 1 || args.length > 4 || args.some((file) => file.startsWith('--'))) {
    throw new Error('Fibo Edit Turbo requires one to four reference image paths; use --help')
  }
  const width = Number(process.env.FIBO_WIDTH || 512)
  const height = Number(process.env.FIBO_HEIGHT || 512)
  if (![width, height].every((value) => Number.isInteger(value) && value > 0 && value % 16 === 0)) {
    throw new Error('Fibo width and height must be positive multiples of 16')
  }
  const seed = Number(process.env.FIBO_SEED || 42)
  if (!Number.isSafeInteger(seed) || seed < 0) {
    throw new Error('FIBO_SEED must be a nonnegative safe integer')
  }
  const dir = path.resolve(
    process.env.FIBO_MODELS_DIR || path.join(__dirname, '../models/fibo2-edit-turbo')
  )
  const files = {
    model: path.join(dir, 'fibo2_edit_turbo-q4_0.gguf'),
    llm: path.join(dir, 'Qwen3VL-4B-Instruct-Q4_K_M.gguf'),
    llmVision: path.join(dir, 'mmproj-Qwen3VL-4B-Instruct-F16.gguf'),
    vae: path.join(dir, 'vae/flux2-vae.safetensors')
  }
  for (const file of Object.values(files)) {
    if (!fs.existsSync(file)) {
      throw new Error(
        `Missing model file: ${file}. Run scripts/download-model-fibo2-edit-turbo.sh first.`
      )
    }
  }
  const refs = args.map((file) => fs.readFileSync(path.resolve(file)))
  const output = path.resolve(
    process.env.FIBO_OUTPUT || path.join(__dirname, '../output/fibo2-edit-turbo.png')
  )
  const ImgStableDiffusion = require('../index')
  const model = new ImgStableDiffusion({
    files,
    config: {
      ...(process.env.FIBO_BACKEND
        ? {
            backend: process.env.FIBO_BACKEND,
            params_backend: process.env.FIBO_BACKEND
          }
        : {}),
      threads: 8,
      diffusion_fa: true
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
      prompt:
        process.env.FIBO_PROMPT ||
        'Change the jacket to dark burgundy. Preserve the face, hair, pose, background and lighting.',
      width,
      height,
      seed,
      steps: 4,
      cfg_scale: 1,
      sampling_method: 'euler',
      scheduler: 'flux',
      ...(refs.length === 1 ? { init_image: refs[0] } : { init_images: refs })
    })
    const images = []
    await response
      .onUpdate((data) => {
        if (data instanceof Uint8Array) images.push(data)
      })
      .await()
    if (images.length !== 1) throw new Error(`Expected one PNG, got ${images.length}`)
    fs.mkdirSync(path.dirname(output), { recursive: true })
    fs.writeFileSync(output, images[0])
    console.log(
      JSON.stringify({
        event: 'generated',
        output,
        references: refs.length,
        width,
        height,
        seed,
        elapsedMs: Date.now() - start
      })
    )
  } finally {
    await model.unload()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
