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

// NOTE: flf2vid (first-last-frame interpolation) is expected to be run with
// a Wan I2V / flf-tuned checkpoint. This example reuses the T2V 1.3B file
// so the download-model-wan.sh flow is sufficient; on production flows
// point files.model at a flf-tuned Wan checkpoint for best quality.
const DIFFUSION_MODEL = 'wan2.1_t2v_1.3B_fp16.safetensors'
const VAE_MODEL = 'wan_2.1_vae.safetensors'
const T5XXL_MODEL = 'umt5_xxl_fp16.safetensors'

// ---------------------------------------------------------------------------
// Frame paths — drop two same-sized frames at these locations to run.
// ---------------------------------------------------------------------------
const INIT_IMAGE_PATH = path.resolve(__dirname, '../assets/flf-first.png')
const END_IMAGE_PATH = path.resolve(__dirname, '../assets/flf-last.png')

// ---------------------------------------------------------------------------
// Generation params — edit freely
// ---------------------------------------------------------------------------
const PROMPT = 'smooth cinematic transition between the two frames, coherent motion'
const NEG_PROMPT = 'blurry, low quality, stutter, jump cut'

const VIDEO_FRAMES = 33
const FPS = 16
const STEPS = 30
const CFG_SCALE = 6.0
// Wan 2.1 needs flow_shift = 3.0 for actual frame-to-frame motion; higher
// values flatten the trajectory and produce near-static output. See the
// long comment in generate-video-wan.js.
const FLOW_SHIFT = 3.0
const STRENGTH = 0.85
const SEED = 42

async function main () {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true })

  if (!fs.existsSync(INIT_IMAGE_PATH) || !fs.existsSync(END_IMAGE_PATH)) {
    console.error('Missing frames for flf2vid.')
    console.error('  expected first frame :', INIT_IMAGE_PATH)
    console.error('  expected last frame  :', END_IMAGE_PATH)
    console.error('Drop two same-sized PNG/JPEG files at those paths and re-run.')
    process.exit(1)
  }

  const initImage = fs.readFileSync(INIT_IMAGE_PATH)
  const endImage = fs.readFileSync(END_IMAGE_PATH)

  console.log('Wan 2.1 T2V 1.3B — first-last-frame video inference')
  console.log('==================================================')
  console.log('First frame :', INIT_IMAGE_PATH, `(${initImage.length.toLocaleString()} bytes)`)
  console.log('Last frame  :', END_IMAGE_PATH, `(${endImage.length.toLocaleString()} bytes)`)
  console.log('Prompt      :', PROMPT)
  console.log('Frames      :', VIDEO_FRAMES, `(@${FPS} fps → ${(VIDEO_FRAMES / FPS).toFixed(2)}s)`)
  console.log('Steps       :', STEPS)
  console.log('Strength    :', STRENGTH)
  console.log('Seed        :', SEED)
  console.log('Note        : dimensions are auto-detected from the first frame; ' +
              'both frames must be the same size.')
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

    console.log('Starting flf2vid...')
    const tGen = Date.now()
    let lastStepTime = tGen

    const response = await model.run({
      mode: 'flf2vid',
      prompt: PROMPT,
      negative_prompt: NEG_PROMPT,
      init_image: initImage,
      end_image: endImage,
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
      const outPath = path.join(OUTPUT_DIR, `wan_flf2vid_seed${SEED}.avi`)
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
