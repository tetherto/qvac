'use strict'

const path = require('bare-path')
const process = require('bare-process')
const fs = require('bare-fs')
const ImgStableDiffusion = require('../index')

// ---------------------------------------------------------------------------
// Model file — downloaded via: ./scripts/download-model-sd3.sh
//
// sd3_medium_incl_clips.safetensors: official Stability AI safetensors from
// adamo1139/stable-diffusion-3-medium-ungated (ungated public mirror).
// Contains the diffusion model + CLIP-L + CLIP-G text encoders in one file.
// No separate encoder paths needed.
//
// NOTE: The gpustack GGUF variants (stable-diffusion-v3-medium-*.gguf) have
// zero KV metadata pairs and are NOT compatible with standard stable-diffusion.cpp.
// ---------------------------------------------------------------------------
const MODELS_DIR = path.resolve(__dirname, '../models')
const OUTPUT_DIR = path.resolve(__dirname, '../output')

// All-in-one safetensors — diffusion + CLIP-L + CLIP-G:
const MODEL_NAME = 'sd3_medium_incl_clips.safetensors'

// ---------------------------------------------------------------------------
// Generation params
// SD3 Medium uses flow-matching. cfg_scale 4.5–7.0 is the typical range.
// 512×512 works fine; SD3 was trained at 1024×1024 but smaller is faster.
// ---------------------------------------------------------------------------
const PROMPT = [
  'a majestic red fox standing in a snowy forest at dusk,',
  'soft golden light through the pine trees,',
  'photorealistic, 8k, detailed fur'
].join(' ')

const NEGATIVE_PROMPT = 'blurry, low quality, watermark, text, bad anatomy'

const STEPS = 28 // SD3 Medium typically 20–30 steps
const WIDTH = 512
const HEIGHT = 512
const CFG = 5.0 // SD3 flow-matching; lower than SD1/SD2 (4.5–7.0 range)
const SEED = 42 // -1 = random

async function main () {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true })

  console.log('Stable Diffusion 3 Medium — text-to-image inference')
  console.log('=====================================================')
  console.log('Model  :', MODEL_NAME)
  console.log('Prompt :', PROMPT)
  console.log('Steps  :', STEPS)
  console.log('Size   :', `${WIDTH}x${HEIGHT}`)
  console.log('CFG    :', CFG)
  console.log('Seed   :', SEED)
  console.log()

  const model = new ImgStableDiffusion({
    files: {
      model: path.join(MODELS_DIR, MODEL_NAME)
      // All-in-one safetensors: no clipL, clipG, t5Xxl, or vae.
      //
      // To add T5-XXL (better text following) without redownloading the main file:
      //   t5Xxl: path.join(MODELS_DIR, 't5xxl_fp8_e4m3fn.safetensors')   // download via download-model-sd3.sh
    },
    config: {
      threads: 4,
      // SD3 uses flow-matching. The safetensors metadata allows auto-detection,
      // but we set these explicitly as safety overrides.
      prediction: 'flow', // FLOW_PRED — SD3 flow-matching
      flow_shift: '3.0' // SD3 Medium default; overrides INFINITY sentinel
    },
    logger: console
  })

  try {
    // ── 1. Load weights ───────────────────────────────────────────────────────
    console.log('Loading model weights...')
    const tLoad = Date.now()
    await model.load()
    console.log(`Loaded in ${((Date.now() - tLoad) / 1000).toFixed(1)}s\n`)

    // ── 2. Start generation ───────────────────────────────────────────────────
    console.log('Starting generation...')
    const tGen = Date.now()

    const response = await model.run({
      prompt: PROMPT,
      negative_prompt: NEGATIVE_PROMPT,
      steps: STEPS,
      width: WIDTH,
      height: HEIGHT,
      cfg_scale: CFG, // SD3 CFG — not the FLUX distilled 'guidance'
      sampling_method: 'euler', // SD3 flow-matching requires euler (not euler_a)
      seed: SEED
    })

    // ── 3. Stream progress + collect image bytes ──────────────────────────────
    const images = []

    await response
      .onUpdate((data) => {
        if (data instanceof Uint8Array) {
          images.push(data)
        } else if (typeof data === 'string') {
          try {
            const tick = JSON.parse(data)
            if ('step' in tick && 'total' in tick) {
              const pct = Math.round((tick.step / tick.total) * 100)
              const bar = '█'.repeat(Math.floor(pct / 5)).padEnd(20, '░')
              process.stdout.write(`\r  [${bar}] ${tick.step}/${tick.total} steps`)
            }
          } catch (_) {}
        }
      })
      .await()

    process.stdout.write('\n')
    console.log(`\nGenerated in ${((Date.now() - tGen) / 1000).toFixed(1)}s`)
    console.log(`Got ${images.length} image(s)`)

    // ── 4. Save each image to disk ────────────────────────────────────────────
    for (let i = 0; i < images.length; i++) {
      const outPath = path.join(OUTPUT_DIR, `sd3_seed${SEED}_${i}.png`)
      fs.writeFileSync(outPath, images[i])
      console.log(`Saved → ${outPath}`)
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
