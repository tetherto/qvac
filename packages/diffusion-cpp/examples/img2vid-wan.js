'use strict'

const path = require('bare-path')
const process = require('bare-process')
const fs = require('bare-fs')
const VideoStableDiffusion = require('../video')
const { setLogger, releaseLogger } = require('../addonLogging')

// ---------------------------------------------------------------------------
// Model files — download via: ./scripts/download-model-wan-i2v.sh
//
// This example uses the dedicated Wan 2.1 I2V 14B checkpoint in GGUF format.
//
// stable-diffusion.cpp supports GGUF natively (Q4_K_M, Q8_0, etc.).
// The fp8_scaled safetensors format is ComfyUI-only: the C++ library ignores
// the per-tensor scale_weight tensors, producing near-zero velocity and
// noise-only video.  Use the GGUF variant for correct output.
//
// Required files (~17.2 GB total, default Q4_K_M):
//   wan2.1-i2v-14b-480p-Q4_K_M.gguf   11.3 GB  (I2V diffusion, GGUF)
//   wan_2.1_vae.safetensors             1.2 GB
//   umt5_xxl_fp16.safetensors           4.6 GB
//   clip_vision_h.safetensors           0.6 GB   (CLIP ViT-H/14)
// ---------------------------------------------------------------------------
const MODELS_DIR = path.resolve(__dirname, '../models')
const OUTPUT_DIR = path.resolve(__dirname, '../output')

const DIFFUSION_MODEL = process.env.WAN_I2V_MODEL ||
  'wan2.1-i2v-14b-480p-Q4_K_M.gguf'
const VAE_MODEL = 'wan_2.1_vae.safetensors'
const T5XXL_MODEL = 'umt5_xxl_fp16.safetensors'
const CLIP_VISION_MODEL = 'clip_vision_h.safetensors'

const INIT_IMAGE_PATH = process.env.INIT_IMAGE ||
  path.resolve(__dirname, '../assets/von-neumann.jpg')

// ---------------------------------------------------------------------------
// Generation params — edit freely
//
// Prompt tip: For I2V the init_image supplies identity and composition;
// focus the prompt on the *motion* you want. Verb-first, action-specific
// prompts work best. Avoid words that describe the static state of the
// subject ("standing still", "portrait") — describe the movement instead.
// ---------------------------------------------------------------------------
const PROMPT = process.env.PROMPT ||
  'the man slowly turns his head and smiles, soft natural lighting, ' +
  'subtle camera push-in, fine film grain, cinematic'
const NEG_PROMPT = process.env.NEG_PROMPT ||
  'blurry, distorted, low quality, jittery, static, frozen, ' +
  'watermark, double face, extra limbs'

// Read image dimensions from PNG/JPEG header bytes — no external dependencies.
// Returns { width, height } or null if the format is unrecognised.
function readImageDims (buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  // PNG: signature bytes 0–7, IHDR chunk: width @ 16, height @ 20 (big-endian)
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) {
    return { width: dv.getUint32(16, false), height: dv.getUint32(20, false) }
  }
  // JPEG: SOI 0xFF 0xD8, then scan for SOF marker
  if (buf[0] === 0xFF && buf[1] === 0xD8) {
    let i = 2
    while (i + 8 < buf.length) {
      if (buf[i] !== 0xFF) break
      const m = buf[i + 1]
      // SOF0-SOF3, SOF5-SOF7, SOF9-SOF11, SOF13-SOF15
      if ((m >= 0xC0 && m <= 0xC3) || (m >= 0xC5 && m <= 0xC7) ||
          (m >= 0xC9 && m <= 0xCB) || (m >= 0xCD && m <= 0xCF)) {
        return { width: dv.getUint16(i + 7, false), height: dv.getUint16(i + 5, false) }
      }
      if (m === 0xD9 || m === 0xDA) break
      i += 2 + dv.getUint16(i + 2, false)
    }
  }
  return null
}

// Wan 2.1 spatial_multiple = vae_scale_factor(8) × diffusion_model_down_factor(2) = 16.
// generate_video() silently aligns dimensions up to the nearest multiple of 16
// and then uses the aligned value as the row stride when filling the init_image
// tensor — if our image has a different stride the reads are corrupted.
// Always snap to multiples of 16 to prevent that misalignment.
function snapTo16 (n) { return Math.max(16, Math.round(n / 16) * 16) }

const VIDEO_FRAMES = parseInt(process.env.FRAMES || '33', 10)
const FPS = parseInt(process.env.FPS || '16', 10)
const STEPS = parseInt(process.env.STEPS || '5', 10)
const CFG_SCALE = parseFloat(process.env.CFG_SCALE || '6.0')
// flow_shift 3.0 is the sweet spot for Wan 2.1 I2V — higher values flatten
// the rectified-flow trajectory, producing near-static frames.
const FLOW_SHIFT = parseFloat(process.env.FLOW_SHIFT || '3.0')
const SEED = parseInt(process.env.SEED || '42', 10)

async function main () {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true })

  // Frame-count validation before spending time loading weights.
  if (VIDEO_FRAMES < 5 || (VIDEO_FRAMES - 1) % 4 !== 0) {
    console.error(`FRAMES must be (4*k + 1), k >= 1 (got ${VIDEO_FRAMES}).`)
    console.error('Valid: 5, 9, 13, 17, 21, 25, 29, 33, 37, 41, ..., 81.')
    process.exit(1)
  }

  const LOG_PRIORITIES = ['ERROR', 'WARNING', 'INFO', 'DEBUG']
  setLogger((priority, message) => {
    const label = LOG_PRIORITIES[priority] || `UNKNOWN(${priority})`
    process.stdout.write(`[C++ ${label}] ${message}`)
    if (!message.endsWith('\n')) process.stdout.write('\n')
  })

  if (!fs.existsSync(INIT_IMAGE_PATH)) {
    console.error(`Init image not found at ${INIT_IMAGE_PATH}`)
    console.error('Set INIT_IMAGE env var to an absolute path or drop a file at the default location.')
    process.exit(1)
  }

  // Validate required model files before loading.
  for (const file of [DIFFUSION_MODEL, VAE_MODEL, T5XXL_MODEL, CLIP_VISION_MODEL]) {
    const fullPath = path.join(MODELS_DIR, file)
    if (!fs.existsSync(fullPath)) {
      console.error(`Missing model file: ${fullPath}`)
      console.error('Run ./scripts/download-model-wan-i2v.sh to download all required files.')
      process.exit(1)
    }
  }

  const initImage = fs.readFileSync(INIT_IMAGE_PATH)

  // Auto-detect dimensions from the image header and snap to multiples of 8.
  // Env var overrides (WIDTH / HEIGHT) take precedence when provided.
  let width, height
  if (process.env.WIDTH && process.env.HEIGHT) {
    width = parseInt(process.env.WIDTH, 10)
    height = parseInt(process.env.HEIGHT, 10)
  } else {
    const dims = readImageDims(initImage)
    if (!dims) {
      console.error('Could not read image dimensions — pass WIDTH and HEIGHT env vars explicitly.')
      process.exit(1)
    }
    width = process.env.WIDTH ? parseInt(process.env.WIDTH, 10) : snapTo16(dims.width)
    height = process.env.HEIGHT ? parseInt(process.env.HEIGHT, 10) : snapTo16(dims.height)
    if (dims.width !== width || dims.height !== height) {
      console.log(`Note: image is ${dims.width}x${dims.height} — snapped to ${width}x${height} (nearest multiples of 16)`)
    }
  }

  console.log('Wan 2.1 I2V 14B — image-to-video inference')
  console.log('===========================================')
  console.log('Diffusion  :', DIFFUSION_MODEL)
  console.log('CLIP vision:', CLIP_VISION_MODEL)
  console.log('Init image :', INIT_IMAGE_PATH, `(${initImage.length.toLocaleString()} bytes)`)
  console.log('Prompt     :', PROMPT)
  console.log('Size       :', `${width}x${height}`)
  console.log('Frames     :', VIDEO_FRAMES, `(@${FPS} fps → ${(VIDEO_FRAMES / FPS).toFixed(2)}s)`)
  console.log('Steps      :', STEPS)
  console.log('Flow shift :', FLOW_SHIFT)
  console.log('Seed       :', SEED)
  console.log()

  if (width % 16 !== 0 || height % 16 !== 0) {
    console.error(`Dimensions ${width}x${height} must be multiples of 16 for Wan I2V.`)
    process.exit(1)
  }

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
      vae_tiling: true,
      flow_shift: FLOW_SHIFT
    },
    logger: console,
    opts: { stats: true }
  })

  try {
    console.log('Loading Wan 2.1 I2V 14B weights (this may take ~1–2 min)...')
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
      width,
      height,
      video_frames: VIDEO_FRAMES,
      fps: FPS,
      steps: STEPS,
      cfg_scale: CFG_SCALE,
      flow_shift: FLOW_SHIFT,
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
      const outPath = path.join(OUTPUT_DIR, `wan_i2v_seed${SEED}.avi`)
      fs.writeFileSync(outPath, avi)
      console.log(`Saved → ${outPath} (${avi.length.toLocaleString()} bytes)`)
    } else {
      console.warn('No AVI buffer received from the addon — check native logs above.')
    }
  } finally {
    console.log('\nUnloading model...')
    await model.unload()
    releaseLogger()
    console.log('Done.')
  }
}

main().catch(err => {
  console.error('Fatal:', err.message || err)
  process.exit(1)
})
