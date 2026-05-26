'use strict'

const path = require('bare-path')
const process = require('bare-process')
const fs = require('bare-fs')
const VideoStableDiffusion = require('../video')

// ---------------------------------------------------------------------------
// Model files — downloaded via: ./scripts/download-model-wan-14b.sh
//
// This example uses the Wan 2.1 T2V 14B model in Q8_0 GGUF quantization.
// At ~10x the parameters of the 1.3B baseline, it produces noticeably
// better motion coherence, prompt adherence, and per-frame detail at
// roughly 3x the wall-clock cost. The VAE and T5 text encoder are the
// *same files* used by generate-video-wan.js -- only the diffusion
// model differs.
// ---------------------------------------------------------------------------
const MODELS_DIR = path.resolve(__dirname, '../models')
const OUTPUT_DIR = path.resolve(__dirname, '../output')

const DIFFUSION_MODEL = 'wan2.1_t2v_14B_Q8_0.gguf'
const VAE_MODEL = 'wan_2.1_vae.safetensors'
const T5XXL_MODEL = 'umt5_xxl_fp16.safetensors'

// ---------------------------------------------------------------------------
// Generation params — edit freely (or override via env vars).
//
// Prompt tip: motion-explicit verbs still help, but 14B has much
// stronger temporal priors than 1.3B and tolerates richer prompts
// without collapsing to "frozen" output. You can also drop the
// CFG scale a notch (5.5-7.0) compared to the 1.3B defaults --
// 14B is more sample-efficient and tends to over-saturate at CFG 8+.
// ---------------------------------------------------------------------------
const PROMPT = process.env.PROMPT ||
  'a colorful bird flapping its wings, dynamic motion, sharp detail'

const NEG_PROMPT = process.env.NEG_PROMPT ||
  'blurry, low quality, static, jittery, watermark'

const WIDTH = parseInt(process.env.WIDTH || '480', 10)
const HEIGHT = parseInt(process.env.HEIGHT || '832', 10)
// Frame count must satisfy (4*k + 1), k >= 1. Same cap as 1.3B (81 max --
// the positional embeddings don't scale with model size).
const VIDEO_FRAMES = parseInt(process.env.FRAMES || '81', 10)
const FPS = parseInt(process.env.FPS || '16', 10)
// 14B converges in fewer steps than 1.3B. 25-30 is usually enough for
// production output; bump to 40+ only if you need the last few percent
// of fidelity. Default kept at 30 to match upstream Wan reference scripts.
const STEPS = parseInt(process.env.STEPS || '30', 10)
const CFG_SCALE = parseFloat(process.env.CFG_SCALE || '6.0')
// Same flow_shift behaviour as the 1.3B model -- 3.0 yields visible
// frame-to-frame motion; values >= 5 flatten the rectified-flow
// trajectory and produce near-static output. See the long comment in
// generate-video-wan.js for the upstream reference scripts that use 3.0.
const FLOW_SHIFT = parseFloat(process.env.FLOW_SHIFT || '3.0')
const SEED = parseInt(process.env.SEED || '42', 10)

async function main () {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true })

  if (VIDEO_FRAMES < 5 || (VIDEO_FRAMES - 1) % 4 !== 0) {
    console.error(`FRAMES must be (4*k + 1), k >= 1 (got ${VIDEO_FRAMES}).`)
    console.error('Valid: 5, 9, 13, 17, 21, 25, 29, 33, ..., 77, 81.')
    process.exit(1)
  }

  const diffusionPath = path.join(MODELS_DIR, DIFFUSION_MODEL)
  if (!fs.existsSync(diffusionPath)) {
    console.error(`Diffusion model not found at ${diffusionPath}`)
    console.error('Run: bash scripts/download-model-wan-14b.sh')
    process.exit(1)
  }

  console.log('Wan 2.1 T2V 14B (Q8_0) — text-to-video inference')
  console.log('================================================')
  console.log('Prompt     :', PROMPT)
  console.log('Size       :', `${WIDTH}x${HEIGHT}`)
  console.log('Frames     :', VIDEO_FRAMES, `(@${FPS} fps → ${(VIDEO_FRAMES / FPS).toFixed(2)}s)`)
  console.log('Steps      :', STEPS)
  console.log('CFG        :', CFG_SCALE)
  console.log('Flow shift :', FLOW_SHIFT)
  console.log('Seed       :', SEED)
  console.log()
  console.log('Note: 14B generation is ~3x slower than 1.3B.')
  console.log()

  const model = new VideoStableDiffusion({
    files: {
      model: diffusionPath,
      t5Xxl: path.join(MODELS_DIR, T5XXL_MODEL),
      vae: path.join(MODELS_DIR, VAE_MODEL)
    },
    config: {
      threads: 4,
      device: 'gpu',
      diffusion_fa: true,
      // 14B Q8 is ~15-16 GB on disk; combined with the 11 GB T5 encoder
      // and 1.2 GB VAE the working set comfortably exceeds 24 GB. Keep
      // offload-to-cpu + vae-tiling on by default so this runs on
      // mid-range single GPUs (16-24 GB VRAM) with the slow path, and
      // doesn't OOM on 32 GB cards that still have other tenants.
      offload_to_cpu: true,
      vae_tiling: true
    },
    logger: console
  })

  try {
    // ── 1. Load weights ───────────────────────────────────────────────────────
    console.log('Loading Wan 2.1 T2V 14B (Q8_0) weights...')
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
      const outPath = path.join(OUTPUT_DIR, `wan_t2v_14B_seed${SEED}.avi`)
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
