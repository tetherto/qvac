'use strict'

const path = require('bare-path')
const process = require('bare-process')
const fs = require('bare-fs')
const VideoStableDiffusion = require('../video')

// ---------------------------------------------------------------------------
// Model files — downloaded via: ./scripts/download-model-wan.sh
// ---------------------------------------------------------------------------
const MODELS_DIR = path.resolve(__dirname, '../models')
const OUTPUT_DIR = path.resolve(__dirname, '../output')

// NOTE: wan2.1_t2v_1.3B is *trained* for T2V but also accepts img2vid in the
// library; for production img2vid you'll typically want a dedicated Wan I2V
// checkpoint. This example reuses the T2V file so the download-model-wan.sh
// flow is sufficient to run it.
const DIFFUSION_MODEL = 'wan2.1_t2v_1.3B_fp16.safetensors'
const VAE_MODEL = 'wan_2.1_vae.safetensors'
const T5XXL_MODEL = 'umt5_xxl_fp16.safetensors'

// First-frame source — reuses the headshot shipped with the repo for
// consistency with the FLUX img2img examples.
const INIT_IMAGE_PATH = path.resolve(__dirname, '../assets/von-neumann.jpg')

// ---------------------------------------------------------------------------
// Generation params — edit freely
// ---------------------------------------------------------------------------
const PROMPT = 'a subtle breeze moves through the scene, gentle camera push-in, cinematic lighting'
const NEG_PROMPT = 'blurry, distorted, low quality, jittery'

const VIDEO_FRAMES = 33
const FPS = 16
const STEPS = 30
const CFG_SCALE = 6.0
// Wan 2.1 needs flow_shift = 3.0 for actual frame-to-frame motion; higher
// values flatten the trajectory and produce near-static output. See the
// long comment in generate-video-wan.js.
const FLOW_SHIFT = 3.0
const STRENGTH = 0.8
const SEED = 42

async function main () {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true })

  if (!fs.existsSync(INIT_IMAGE_PATH)) {
    console.error(`Init image not found at ${INIT_IMAGE_PATH}`)
    process.exit(1)
  }

  const initImage = fs.readFileSync(INIT_IMAGE_PATH)

  console.log('Wan 2.1 T2V 1.3B — image-to-video inference')
  console.log('==========================================')
  console.log('Init image :', INIT_IMAGE_PATH, `(${initImage.length.toLocaleString()} bytes)`)
  console.log('Prompt     :', PROMPT)
  console.log('Frames     :', VIDEO_FRAMES, `(@${FPS} fps → ${(VIDEO_FRAMES / FPS).toFixed(2)}s)`)
  console.log('Steps      :', STEPS)
  console.log('Strength   :', STRENGTH)
  console.log('Seed       :', SEED)
  console.log('Note       : dimensions are auto-detected from the init image.')
  console.log()

  const model = new VideoStableDiffusion({
    files: {
      model: path.join(MODELS_DIR, DIFFUSION_MODEL),
      t5Xxl: path.join(MODELS_DIR, T5XXL_MODEL),
      vae: path.join(MODELS_DIR, VAE_MODEL)
    },
    config: {
      threads: 4,
      device: 'gpu',
      diffusion_fa: true,
      offload_to_cpu: true,
      vae_tiling: true
    },
    logger: console
  })

  try {
    console.log('Loading Wan 2.1 T2V 1.3B weights...')
    const tLoad = Date.now()
    await model.load()
    console.log(`Loaded in ${((Date.now() - tLoad) / 1000).toFixed(1)}s\n`)

    console.log('Starting img2vid...')
    const tGen = Date.now()
    let lastStepTime = tGen

    const response = await model.run({
      mode: 'img2vid',
      prompt: PROMPT,
      negative_prompt: NEG_PROMPT,
      init_image: initImage,
      video_frames: VIDEO_FRAMES,
      fps: FPS,
      steps: STEPS,
      cfg_scale: CFG_SCALE,
      flow_shift: FLOW_SHIFT,
      strength: STRENGTH,
      seed: SEED
    })

    let avi = null

    await response
      .onUpdate((data) => {
        if (data instanceof Uint8Array) {
          avi = data
        } else if (typeof data === 'string') {
          try {
            const tick = JSON.parse(data)
            if ('step' in tick && 'total' in tick) {
              const now = Date.now()
              const stepMs = now - lastStepTime
              lastStepTime = now
              const wallMs = now - tGen
              const pct = Math.round((tick.step / tick.total) * 100)
              const bar = '█'.repeat(Math.floor(pct / 5)).padEnd(20, '░')
              process.stdout.write(
                `\r  [${bar}] ${tick.step}/${tick.total} | ` +
                `step ${(stepMs / 1000).toFixed(1)}s | wall ${(wallMs / 1000).toFixed(1)}s  `
              )
            }
          } catch (_) {}
        }
      })
      .await()

    process.stdout.write('\n')
    console.log(`\nGenerated in ${((Date.now() - tGen) / 1000).toFixed(1)}s`)

    if (avi) {
      const outPath = path.join(OUTPUT_DIR, `wan_img2vid_seed${SEED}.avi`)
      fs.writeFileSync(outPath, avi)
      console.log(`Saved → ${outPath} (${avi.length.toLocaleString()} bytes)`)
    } else {
      console.warn('No AVI buffer received from the addon — check native logs above.')
    }
  } finally {
    console.log('\nUnloading model...')
    await model.unload()
    console.log('Done.')
  }
}

main().catch(err => {
  console.error('Fatal:', err.message || err)
  process.exit(1)
})
