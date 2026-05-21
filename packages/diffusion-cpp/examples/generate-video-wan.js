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
// Generation params — edit freely (or override via env vars).
//
// Prompt tip: Wan 1.3B is small and has weak temporal priors. Use motion-
// explicit verbs and avoid static framing words. Upstream demos use
// "a dancing robot", "dynamic motion", "a lovely cat" — short and verb-led.
// Avoid words like "standing", "still", "portrait" in the positive prompt.
// ---------------------------------------------------------------------------
const PROMPT = process.env.PROMPT ||
  'a colorful bird flapping its wings'

const NEG_PROMPT = process.env.NEG_PROMPT ||
  'blurry, low quality, static, jittery, watermark'

const WIDTH = parseInt(process.env.WIDTH || '480', 10)
const HEIGHT = parseInt(process.env.HEIGHT || '832', 10)
// Frame count must satisfy (4*k + 1), k >= 1. Common values @ 16 fps:
//   17 frames  → 1.06 s   (very fast,  ~6 min  on M3 Ultra Metal)
//   33 frames  → 2.06 s   (~11 min)
//   49 frames  → 3.06 s   (~17 min)
//   65 frames  → 4.06 s   (~22 min)
//   81 frames  → 5.06 s   (Wan 1.3B native training length — best motion
//                          quality, ~28 min, needs ~12 GB unified RAM)
// Going beyond 81 is unsupported by the model's positional embeddings and
// will produce visible quality breakdown / repetition.
const VIDEO_FRAMES = parseInt(process.env.FRAMES || '81', 10)
const FPS = parseInt(process.env.FPS || '16', 10)
const STEPS = parseInt(process.env.STEPS || '30', 10) // Wan recommended for 1.3B
const CFG_SCALE = parseFloat(process.env.CFG_SCALE || '6.0')
// Wan 2.1 T2V (1.3B and 14B) needs flow_shift = 3.0 for actual motion. Higher
// values (5+) compress the rectified-flow trajectory so consecutive frames end
// up near-identical (visible as a "frozen" video). The reference
// qvac-ext-stable-diffusion.cpp test-wan/ scripts all use 3.0; some upstream
// docs misleadingly mention 5–8.
const FLOW_SHIFT = parseFloat(process.env.FLOW_SHIFT || '3.0')
const SEED = parseInt(process.env.SEED || '42', 10)

async function main () {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true })

  // Sanity-check the (4*k + 1) rule before loading 8 GB of weights.
  if (VIDEO_FRAMES < 5 || (VIDEO_FRAMES - 1) % 4 !== 0) {
    console.error(`FRAMES must be (4*k + 1), k >= 1 (got ${VIDEO_FRAMES}).`)
    console.error('Valid: 5, 9, 13, 17, 21, 25, 29, 33, ..., 77, 81.')
    process.exit(1)
  }

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
