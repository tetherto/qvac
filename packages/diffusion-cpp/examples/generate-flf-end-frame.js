'use strict'

const path = require('bare-path')
const process = require('bare-process')
const fs = require('bare-fs')
const VideoStableDiffusion = require('../video')
const { setLogger, releaseLogger } = require('../addonLogging')

// ---------------------------------------------------------------------------
// Helper script to regenerate claude-shannon.jpg at von-neumann dimensions.
// Uses img2vid with high strength to preserve image fidelity while resampling.
// Run with: bare examples/generate-flf-end-frame.js
// Output: assets/claude-shannon-resized.jpg (496x624)
// ---------------------------------------------------------------------------

const MODELS_DIR = path.resolve(__dirname, '../models')
const ASSETS_DIR = path.resolve(__dirname, '../assets')
const OUTPUT_DIR = path.resolve(__dirname, '../output')

const DIFFUSION_MODEL = 'wan2.1-i2v-14b-480p-Q4_K_M.gguf'
const VAE_MODEL = 'wan_2.1_vae.safetensors'
const T5XXL_MODEL = 'umt5_xxl_fp16.safetensors'
const CLIP_VISION_MODEL = 'clip_vision_h.safetensors'

const INIT_IMAGE_PATH = path.join(ASSETS_DIR, 'claude-shannon.jpg')
const OUTPUT_PATH = path.join(ASSETS_DIR, 'claude-shannon-resized.jpg')
const TEMP_VIDEO_PATH = path.join(OUTPUT_DIR, '_temp-claude-shannon.avi')

// Target dimensions (snapped to 16 for Wan)
const WIDTH = 496
const HEIGHT = 624

async function main () {
  setLogger((priority, message) => {
    process.stdout.write(`[C++ LOG] ${message}`)
    if (!message.endsWith('\n')) process.stdout.write('\n')
  })

  // Check models
  for (const file of [DIFFUSION_MODEL, VAE_MODEL, T5XXL_MODEL, CLIP_VISION_MODEL]) {
    const fullPath = path.join(MODELS_DIR, file)
    if (!fs.existsSync(fullPath)) {
      console.error(`Missing model file: ${fullPath}`)
      console.error('Run ./scripts/download-model-wan-i2v.sh to download all required files.')
      process.exit(1)
    }
  }

  // Check input image
  if (!fs.existsSync(INIT_IMAGE_PATH)) {
    console.error(`Missing input: ${INIT_IMAGE_PATH}`)
    process.exit(1)
  }

  // Create output dir
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true })
  }

  const initImage = fs.readFileSync(INIT_IMAGE_PATH)

  console.log('Generating claude-shannon at', `${WIDTH}x${HEIGHT}...`)
  console.log('Input path  :', INIT_IMAGE_PATH)
  console.log('Output path :', OUTPUT_PATH)
  console.log()

  const model = new VideoStableDiffusion({
    files: {
      model: path.join(MODELS_DIR, DIFFUSION_MODEL),
      t5Xxl: path.join(MODELS_DIR, T5XXL_MODEL),
      vae: path.join(MODELS_DIR, VAE_MODEL),
      clipVision: path.join(MODELS_DIR, CLIP_VISION_MODEL)
    },
    config: {
      threads: 4,
      device: 'gpu',
      diffusion_fa: true,
      offload_to_cpu: true,
      verbose: false
    }
  })

  try {
    await model.load()

    console.time('Generation')
    const videoBuffer = await model.run({
      mode: 'img2vid',
      init_image: initImage,
      width: WIDTH,
      height: HEIGHT,
      prompt: 'portrait of Claude Shannon, scientist, clear details, high fidelity',
      neg_prompt: 'blurry, distorted, warped, low quality',
      video_frames: 5,  // Minimum allowed (4*1 + 1)
      steps: 3,         // Minimal steps to preserve image
      strength: 0.95,   // Very high strength to stay faithful
      cfg_scale: 7.5,
      seed: 42
    })
    console.timeEnd('Generation')

    // Save video buffer to temp AVI
    fs.writeFileSync(TEMP_VIDEO_PATH, videoBuffer)
    console.log('✓ Saved temp video to:', TEMP_VIDEO_PATH)
    console.log()
    console.log('Next: Extract frame with ffmpeg:')
    console.log(`  ffmpeg -i "${TEMP_VIDEO_PATH}" -frames:v 1 -q:v 5 "${OUTPUT_PATH}"`)
  } finally {
    console.log('\nUnloading model...')
    await model.unload()
    releaseLogger()
    console.log('Done.')
  }
}

main().catch(err => {
  console.error('Error:', err.message)
  process.exit(1)
})
