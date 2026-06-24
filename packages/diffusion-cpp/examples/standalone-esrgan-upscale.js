'use strict'

const path = require('bare-path')
const process = require('bare-process')
const fs = require('bare-fs')
const { EsrganUpscaler } = require('../index')
const { setLogger, releaseLogger } = require('../addonLogging')

// ---------------------------------------------------------------------------
// Standalone ESRGAN upscaler
//
// Upscales an existing PNG/JPEG image without loading any diffusion model.
// Useful for upscaling pre-existing assets (screenshots, photos, third-party
// generated images, etc.).
//
// ESRGAN model:
//   Place RealESRGAN_x4plus_anime_6B.pth in packages/diffusion-cpp/models.
//   Real-ESRGAN repo: https://github.com/xinntao/Real-ESRGAN
//   Model download: https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.2.4/RealESRGAN_x4plus_anime_6B.pth
//   The .pth model is not bundled with this package.
//
// Input image:
//   Defaults to assets/von-neumann.jpg (bundled with the package). Override
//   with INPUT_PATH env var to point at any PNG or JPEG file.
// ---------------------------------------------------------------------------
const MODELS_DIR = path.resolve(__dirname, '../models')
const ASSETS_DIR = path.resolve(__dirname, '../assets')
const OUTPUT_DIR = path.resolve(__dirname, '../output')

const ESRGAN_MODEL_NAME = 'RealESRGAN_x4plus_anime_6B.pth'
const INPUT_PATH = process.env.INPUT_PATH || path.join(ASSETS_DIR, 'von-neumann.jpg')

async function runUpscale (upscaler, label, repeats, filenameSuffix, inputBytes) {
  console.log(`Starting ${label}...`)

  const images = []
  const t0 = Date.now()
  const response = await upscaler.upscale(inputBytes, { repeats })

  await response
    .onUpdate(data => {
      if (data instanceof Uint8Array) images.push(data)
    })
    .await()

  console.log(`Upscaled in ${((Date.now() - t0) / 1000).toFixed(1)}s — got ${images.length} image(s)`)

  for (let i = 0; i < images.length; i++) {
    const baseName = path.basename(INPUT_PATH, path.extname(INPUT_PATH))
    const outPath = path.join(
      OUTPUT_DIR,
      `${baseName}_esrgan_${filenameSuffix}_${i}.png`
    )
    fs.writeFileSync(outPath, images[i])
    console.log(`Saved: ${outPath}`)
  }

  console.log()
}

async function main () {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true })

  if (!fs.existsSync(INPUT_PATH)) {
    console.error(`Input image not found: ${INPUT_PATH}`)
    console.error('Override with INPUT_PATH env var, e.g. INPUT_PATH=/path/to/image.png node examples/standalone-esrgan-upscale.js')
    process.exit(1)
  }

  const inputBytes = fs.readFileSync(INPUT_PATH)

  console.log('Standalone ESRGAN upscale')
  console.log('==========================')
  console.log('ESRGAN :', ESRGAN_MODEL_NAME)
  console.log('Input  :', INPUT_PATH, `(${inputBytes.length} bytes)`)
  console.log()
  console.log('Each ESRGAN repeat multiplies output dimensions by the model scale factor (typically 4×).')
  console.log()

  // Native C++ logs are process-global; configure them once via addonLogging.
  setLogger((priority, message) => {
    const labels = ['ERROR', 'WARN', 'INFO', 'DEBUG']
    console.log(`[C++ ${labels[priority] || priority}] ${message}`)
  })

  const upscaler = new EsrganUpscaler({
    files: {
      esrgan: path.join(MODELS_DIR, ESRGAN_MODEL_NAME)
    },
    config: {
      upscaler_tile_size: 128
    },
    logger: console
  })

  try {
    console.log('Loading ESRGAN weights...')
    const tLoad = Date.now()
    await upscaler.load()
    console.log(`Loaded in ${((Date.now() - tLoad) / 1000).toFixed(1)}s\n`)

    await runUpscale(upscaler, 'ESRGAN single pass (×4)', 1, 'x4', inputBytes)
    await runUpscale(upscaler, 'ESRGAN two-pass (×16)', 2, 'x16', inputBytes)
  } finally {
    console.log('Unloading upscaler...')
    await upscaler.unload()
    releaseLogger()
    console.log('Done.')
  }
}

main().catch(err => {
  console.error('Fatal:', err.message || err)
  process.exit(1)
})
