'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const process = require('bare-process')
const VideoStableDiffusion = require('../video')

// Download first:
//   ./scripts/download-model-wan2.2.sh
const MODELS_DIR = path.resolve(__dirname, '../models')
const OUTPUT_DIR = path.resolve(__dirname, '../output')
const TURBO_MODEL = 'Wan2_2-TI2V-5B-Turbo-Q5_K_S.gguf'
const files = {
  model: path.join(MODELS_DIR, TURBO_MODEL),
  t5Xxl: path.join(MODELS_DIR, 'umt5_xxl_fp16.safetensors'),
  vae: path.join(MODELS_DIR, 'wan2.2_vae.safetensors')
}

const PROMPT =
  process.env.PROMPT ||
  'A single white porcelain espresso cup sits on a dark walnut table beside a sunlit window. Delicate steam curls upward from fresh coffee, a slow circular camera move, warm morning light, sharp ceramic texture, subtle reflections, calm premium coffee commercial, realistic continuous motion.'
const NEGATIVE_PROMPT =
  process.env.NEG_PROMPT ||
  'flickering, temporal jitter, morphing, duplicated subject, warped geometry, distorted anatomy, blurry details, low resolution, text, watermark, logo'
// Turbo was trained for this 720p, 24 fps, five-second shape.
const WIDTH = parseInt(process.env.WIDTH || '1280', 10)
const HEIGHT = parseInt(process.env.HEIGHT || '704', 10)
const VIDEO_FRAMES = parseInt(process.env.FRAMES || '121', 10)
const FPS = parseInt(process.env.FPS || '24', 10)
const STEPS = parseInt(process.env.STEPS || '4', 10)
const CFG_SCALE = parseFloat(process.env.CFG_SCALE || '1.0')
const FLOW_SHIFT = parseFloat(process.env.FLOW_SHIFT || '5.0')
const SEED = parseInt(process.env.SEED || '-1', 10)

function assertRunShape() {
  if (WIDTH <= 0 || HEIGHT <= 0 || WIDTH % 32 !== 0 || HEIGHT % 32 !== 0) {
    throw new Error(`WIDTH and HEIGHT must be positive multiples of 32, got ${WIDTH}x${HEIGHT}`)
  }
  if (VIDEO_FRAMES < 5 || (VIDEO_FRAMES - 1) % 4 !== 0) {
    throw new Error(`FRAMES must satisfy (4*k + 1), k >= 1, got ${VIDEO_FRAMES}`)
  }
}

async function main() {
  assertRunShape()
  fs.mkdirSync(OUTPUT_DIR, { recursive: true })

  const model = new VideoStableDiffusion({
    files,
    config: {
      threads: 4,
      device: 'gpu',
      diffusion_fa: true,
      offload_to_cpu: true,
      vae_tiling: true
    },
    logger: console,
    opts: { stats: true }
  })

  try {
    console.log('Loading Wan 2.2 TI2V-5B Turbo GGUF (Q5_K_S)...')
    await model.load()

    const params = {
      mode: 'txt2vid',
      prompt: PROMPT,
      negative_prompt: NEGATIVE_PROMPT,
      width: WIDTH,
      height: HEIGHT,
      video_frames: VIDEO_FRAMES,
      fps: FPS,
      steps: STEPS,
      cfg_scale: CFG_SCALE,
      flow_shift: FLOW_SHIFT,
      seed: SEED
    }

    let avi = null
    const response = await model.run(params)
    await response
      .onUpdate((data) => {
        if (data instanceof Uint8Array) avi = data
      })
      .await()

    if (!avi) throw new Error('No AVI output was received from the addon')
    const outputPath = path.join(OUTPUT_DIR, `wan22-ti2v-5b-turbo-Q5_K_S-seed${SEED}.avi`)
    fs.writeFileSync(outputPath, avi)
    console.log(`Saved → ${outputPath}`)
    console.log('Stats:', response.stats)
  } finally {
    await model.unload()
  }
}

main().catch((err) => {
  console.error('Fatal:', err.message || err)
  process.exit(1)
})
