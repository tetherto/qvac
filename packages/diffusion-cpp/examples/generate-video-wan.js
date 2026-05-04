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

const DIFFUSION_MODEL = 'wan2.1_t2v_1.3B_fp16.safetensors'
const VAE_MODEL = 'wan_2.1_vae.safetensors'
const T5XXL_MODEL = 'umt5_xxl_fp16.safetensors'

// ---------------------------------------------------------------------------
// Generation params — edit freely
// ---------------------------------------------------------------------------
const PROMPT = [
  'a majestic red fox standing in a snowy forest at dusk,',
  'soft golden light through the pine trees,',
  'photorealistic, 8k, detailed fur, smooth motion'
].join(' ')

const NEG_PROMPT = 'blurry, low quality, static, jittery, watermark'

const WIDTH = 832
const HEIGHT = 480
const VIDEO_FRAMES = 33 // (4*k+1); ~1.4s at 24 fps, ~2.0s at 16 fps
const FPS = 16
const STEPS = 30 // Wan recommended for 1.3B
const CFG_SCALE = 6.0
const FLOW_SHIFT = 5.0 // Wan T2V 1.3B recommended range: 5.0–8.0
const SEED = 42

async function main () {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true })

  console.log('Wan 2.1 T2V 1.3B — text-to-video inference')
  console.log('==========================================')
  console.log('Prompt     :', PROMPT)
  console.log('Size       :', `${WIDTH}x${HEIGHT}`)
  console.log('Frames     :', VIDEO_FRAMES, `(@${FPS} fps → ${(VIDEO_FRAMES / FPS).toFixed(2)}s)`)
  console.log('Steps      :', STEPS)
  console.log('CFG        :', CFG_SCALE)
  console.log('Flow shift :', FLOW_SHIFT)
  console.log('Seed       :', SEED)
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
    // ── 1. Load weights ───────────────────────────────────────────────────────
    console.log('Loading Wan 2.1 T2V 1.3B weights...')
    const tLoad = Date.now()
    await model.load()
    console.log(`Loaded in ${((Date.now() - tLoad) / 1000).toFixed(1)}s\n`)

    // ── 2. Start generation ───────────────────────────────────────────────────
    console.log('Starting generation...')
    const tGen = Date.now()

    const response = await model.run({
      mode: 'txt2vid',
      prompt: PROMPT,
      negative_prompt: NEG_PROMPT,
      width: WIDTH,
      height: HEIGHT,
      video_frames: VIDEO_FRAMES,
      fps: FPS,
      steps: STEPS,
      cfg_scale: CFG_SCALE,
      flow_shift: FLOW_SHIFT,
      seed: SEED
    })

    // ── 3. Stream progress + collect AVI bytes ───────────────────────────────
    // For video modes the output stream carries a single Uint8Array (MJPG
    // AVI buffer) plus per-step progress ticks as JSON strings. Collect
    // the last Uint8Array seen — that's the AVI.
    let avi = null
    let lastStepTime = tGen

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

    // ── 4. Save AVI to disk ──────────────────────────────────────────────────
    if (avi) {
      const outPath = path.join(OUTPUT_DIR, `wan_t2v_seed${SEED}.avi`)
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
