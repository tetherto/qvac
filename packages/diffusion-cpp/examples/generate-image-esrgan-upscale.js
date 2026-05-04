'use strict'

const path = require('bare-path')
const process = require('bare-process')
const fs = require('bare-fs')
const ImgStableDiffusion = require('../index')

// ---------------------------------------------------------------------------
// Model files
//
// SD2.1 all-in-one GGUF:
//   ./scripts/download-model-sd2.sh
//
// ESRGAN model:
//   Place RealESRGAN_x4plus_anime_6B.pth in packages/diffusion-cpp/models.
//   It is the stable-diffusion.cpp recommended ESRGAN sample model.
// ---------------------------------------------------------------------------
const MODELS_DIR = path.resolve(__dirname, '../models')
const OUTPUT_DIR = path.resolve(__dirname, '../output')

const MODEL_NAME = 'stable-diffusion-v2-1-Q8_0.gguf'
const ESRGAN_MODEL_NAME = 'RealESRGAN_x4plus_anime_6B.pth'

const PROMPT = [
  'an illustrated red fox portrait, clean line art,',
  'soft watercolor background, detailed fur, crisp eyes'
].join(' ')

const NEGATIVE_PROMPT = 'blurry, low quality, watermark, text'

const STEPS = 5
const WIDTH = 128
const HEIGHT = 128
const CFG = 7.5
const SEED = 42

const BASE_PARAMS = {
  prompt: PROMPT,
  negative_prompt: NEGATIVE_PROMPT,
  steps: STEPS,
  width: WIDTH,
  height: HEIGHT,
  cfg_scale: CFG,
  seed: SEED
}

function onProgress (data, images) {
  if (data instanceof Uint8Array) {
    images.push(data)
    return
  }

  if (typeof data !== 'string') return

  try {
    const tick = JSON.parse(data)
    if ('step' in tick && 'total' in tick) {
      const pct = Math.round((tick.step / tick.total) * 100)
      const bar = '#'.repeat(Math.floor(pct / 5)).padEnd(20, '.')
      process.stdout.write(`\r  [${bar}] ${tick.step}/${tick.total} steps`)
    }
  } catch (_) {}
}

async function runUpscale (model, label, upscale, filenameSuffix) {
  console.log(`Starting ${label}...`)

  const images = []
  const tGen = Date.now()
  const response = await model.run({
    ...BASE_PARAMS,
    upscale
  })

  await response
    .onUpdate(data => onProgress(data, images))
    .await()

  process.stdout.write('\n')
  console.log(`Generated in ${((Date.now() - tGen) / 1000).toFixed(1)}s`)
  console.log(`Got ${images.length} image(s)`)

  for (let i = 0; i < images.length; i++) {
    const outPath = path.join(OUTPUT_DIR, `sd2_esrgan_${filenameSuffix}_seed${SEED}_${i}.png`)
    fs.writeFileSync(outPath, images[i])
    console.log(`Saved: ${outPath}`)
  }

  console.log()
}

async function main () {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true })

  console.log('Stable Diffusion 2.1 - ESRGAN post-generation upscale')
  console.log('=======================================================')
  console.log('Model  :', MODEL_NAME)
  console.log('ESRGAN :', ESRGAN_MODEL_NAME)
  console.log('Prompt :', PROMPT)
  console.log('Steps  :', STEPS)
  console.log('Source :', `${WIDTH}x${HEIGHT}`)
  console.log('CFG    :', CFG)
  console.log('Seed   :', SEED)
  console.log()
  console.log('The source size is intentionally small because each ESRGAN repeat multiplies output dimensions.')
  console.log()

  const model = new ImgStableDiffusion({
    files: {
      model: path.join(MODELS_DIR, MODEL_NAME),
      esrgan: path.join(MODELS_DIR, ESRGAN_MODEL_NAME)
    },
    config: {
      threads: 8,
      prediction: 'v',
      upscaler_tile_size: 128
    },
    logger: console
  })

  try {
    console.log('Loading model weights...')
    const tLoad = Date.now()
    await model.load()
    console.log(`Loaded in ${((Date.now() - tLoad) / 1000).toFixed(1)}s\n`)

    await runUpscale(model, 'ESRGAN x4 upscale', true, 'x4')
    await runUpscale(model, 'ESRGAN two-pass x16 upscale', { repeats: 2 }, 'x16')
  } finally {
    console.log('Unloading model...')
    await model.unload()
    console.log('Done.')
  }
}

main().catch(err => {
  console.error('Fatal:', err.message || err)
  process.exit(1)
})
