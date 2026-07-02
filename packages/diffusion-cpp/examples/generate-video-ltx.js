'use strict'

const path = require('bare-path')
const process = require('bare-process')
const fs = require('bare-fs')
const VideoStableDiffusion = require('../video')

// ---------------------------------------------------------------------------
// LTX-2.3 text-to-video (+ audio) — downloaded via:
//   ./scripts/download-model-ltx.sh            # distilled-1.1 Q5_K_M (default)
//
// LTX-2.3 is a joint audio+video model: one text prompt drives both the video
// frames and a synchronized 48 kHz audio track. The audio is decoded by the
// audio VAE and muxed into the output AVI as a second IEEE-float PCM stream
// (play the result in VLC, which handles float-PCM AVI).
//
// Unlike Wan, LTX has stricter shape constraints:
//   - width / height must be multiples of 32   (e.g. 768 x 512)
//   - video_frames must be (8*k + 1), max 257  (9, 17, 25, 33, ...)
// ---------------------------------------------------------------------------
const MODELS_DIR = path.resolve(__dirname, '../models')
const OUTPUT_DIR = path.resolve(__dirname, '../output')

// File names match scripts/download-model-ltx.sh (distilled-1.1 Q5_K_M + the
// "distilled" aux VAEs/connectors). Override via env vars to use --dev weights
// or a different quantization (e.g. LTX_MODEL=LTX-2.3-22B-distilled-1.1-Q8_0.gguf).
const DIFFUSION_MODEL = process.env.LTX_MODEL || 'LTX-2.3-22B-distilled-1.1-Q5_K_M.gguf'
const LLM_MODEL = process.env.LTX_LLM || 'gemma-3-12b-it-UD-Q4_K_XL.gguf'
const VIDEO_VAE = process.env.LTX_VAE || 'ltx-2.3-22b-distilled_video_vae.safetensors'
const AUDIO_VAE = process.env.LTX_AUDIO_VAE || 'ltx-2.3-22b-distilled_audio_vae.safetensors'
const EMBEDDINGS_CONNECTORS =
  process.env.LTX_CONNECTORS || 'ltx-2.3-22b-distilled_embeddings_connectors.safetensors'

// ---------------------------------------------------------------------------
// Generation params — edit freely (or override via env vars).
// ---------------------------------------------------------------------------
const PROMPT = process.env.PROMPT ||
  'a claymation cat playing jazz on a piano'

const NEG_PROMPT = process.env.NEG_PROMPT ||
  'blurry, low quality, static, jittery, watermark, distorted audio'

// Multiples of 32. 768x512 is a good 3:2 default for LTX-2.3.
const WIDTH = parseInt(process.env.WIDTH || '512', 10)
const HEIGHT = parseInt(process.env.HEIGHT || '320', 10)
// Frame count must satisfy (8*k + 1), k >= 1, max 257.  @24 fps:
//   25 frames  → 1.00 s     49 frames → 2.00 s     73 frames → 3.00 s
//   97 frames  → 4.00 s    121 frames → 5.00 s    257 frames → 10.67 s (max)
const VIDEO_FRAMES = parseInt(process.env.FRAMES || '241', 10)
const FPS = parseInt(process.env.FPS || '24', 10)
// Distilled variants run in 4-8 steps with cfg ~1.0. For the full --dev model
// use STEPS=20+ and CFG_SCALE=7.0.
const STEPS = parseInt(process.env.STEPS || '10', 10)
const CFG_SCALE = parseFloat(process.env.CFG_SCALE || '1.0')
const SEED = parseInt(process.env.SEED || '42', 10)
// Temporal tiling bounds peak VRAM during the video VAE decode at the cost of
// some speed; recommended ON for HD / long clips.
const TEMPORAL_TILING = (process.env.TEMPORAL_TILING || 'true') === 'true'

async function main () {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true })

  // Sanity-check LTX shape rules before loading ~20 GB of weights.
  if (WIDTH % 32 !== 0 || HEIGHT % 32 !== 0) {
    console.error(`WIDTH/HEIGHT must be multiples of 32 (got ${WIDTH}x${HEIGHT}).`)
    process.exit(1)
  }
  if (VIDEO_FRAMES < 9 || (VIDEO_FRAMES - 1) % 8 !== 0 || VIDEO_FRAMES > 257) {
    console.error(`FRAMES must be (8*k + 1) in [9, 257] (got ${VIDEO_FRAMES}).`)
    console.error('Valid: 9, 17, 25, 33, 41, 49, ..., 257.')
    process.exit(1)
  }

  console.log('LTX-2.3 — text-to-video + audio inference')
  console.log('=========================================')
  console.log('Prompt        :', PROMPT)
  console.log('Size          :', `${WIDTH}x${HEIGHT}`)
  console.log('Frames        :', VIDEO_FRAMES, `(@${FPS} fps → ${(VIDEO_FRAMES / FPS).toFixed(2)}s)`)
  console.log('Steps         :', STEPS)
  console.log('CFG           :', CFG_SCALE)
  console.log('Temporal tile :', TEMPORAL_TILING)
  console.log('Seed          :', SEED)
  console.log()

  const model = new VideoStableDiffusion({
    files: {
      model: path.join(MODELS_DIR, DIFFUSION_MODEL),
      llm: path.join(MODELS_DIR, LLM_MODEL),
      vae: path.join(MODELS_DIR, VIDEO_VAE),
      audioVae: path.join(MODELS_DIR, AUDIO_VAE),
      embeddingsConnectors: path.join(MODELS_DIR, EMBEDDINGS_CONNECTORS)
    },
    config: {
      threads: 4,
      device: 'gpu',
      diffusion_fa: true,
      offload_to_cpu: false,
      vae_tiling: true,
      // LTX video VAE convolutions go through the direct (im2col-free) path to
      // avoid the CPU im2col F16 assert; the audio VAE F32 conv path is handled
      // by the ggml 2026-06-06 conv_1d type fix.
      vae_conv_direct: true
    },
    opts: { stats: true },
    logger: console
  })

  try {
    // ── 1. Load weights ───────────────────────────────────────────────────────
    console.log('Loading LTX-2.3 weights (video + audio VAE + connectors + Gemma)...')
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
      temporal_tiling: TEMPORAL_TILING,
      seed: SEED
    })

    // ── 3. Stream progress + collect AVI bytes ───────────────────────────────
    // The output stream carries a single Uint8Array (MJPG AVI with a muxed
    // audio stream) plus per-step progress ticks as JSON strings. Keep the
    // last Uint8Array seen — that's the AVI.
    let avi = null
    let stats = null
    let lastStepTime = tGen

    // Stats arrive on the 'stats' event when opts.stats is enabled.
    response.on('stats', (s) => { stats = s })

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

    if (stats) {
      const hasAudio = stats.hasAudio === 1 || stats.hasAudio === true
      console.log('Audio         :', hasAudio
        ? `yes (${stats.audioSampleRate} Hz, muxed into AVI)`
        : 'no track produced')
    }

    // ── 4. Save AVI to disk ──────────────────────────────────────────────────
    if (avi) {
      const outPath = path.join(OUTPUT_DIR, `ltx_t2v_seed${SEED}.avi`)
      fs.writeFileSync(outPath, avi)
      console.log(`Saved → ${outPath} (${avi.length.toLocaleString()} bytes)`)
      console.log('Tip: play in VLC to hear the muxed audio track.')
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
