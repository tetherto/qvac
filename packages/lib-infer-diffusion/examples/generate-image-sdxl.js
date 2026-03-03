'use strict'

const path = require('bare-path')
const process = require('bare-process')
const fs = require('bare-fs')
const FilesystemDL = require('@qvac/dl-filesystem')
const ImgStableDiffusion = require('../index')

// ---------------------------------------------------------------------------
// Model file — downloaded via: ./scripts/download-model-sdxl.sh
//
// SDXL base all-in-one GGUF (Q8_0). CLIP-L, CLIP-G, UNet, and VAE are all
// baked in — no separate text encoder or VAE needed.
//
// prediction is left unset: SDXL uses eps-prediction and the gpustack GGUF
// has the metadata embedded, so auto-detection works correctly.
// ---------------------------------------------------------------------------
const MODELS_DIR = path.resolve(__dirname, '../models')
const OUTPUT_DIR = path.resolve(__dirname, '../output')

const MODEL_NAME = 'stable-diffusion-xl-base-1.0-Q4_0.gguf'

// ---------------------------------------------------------------------------
// Generation params
// SDXL is trained at 1024×1024 but 512×512 works and is significantly faster.
// Use cfg_scale (not guidance — that is FLUX-specific).
// ---------------------------------------------------------------------------
const PROMPT = [
  'a majestic red fox standing in a snowy forest at dusk,',
  'soft golden light through the pine trees,',
  'photorealistic, 8k, detailed fur'
].join(' ')

const NEGATIVE_PROMPT = 'blurry, low quality, watermark, text, bad anatomy'

const STEPS    = 30
const WIDTH    = 1024
const HEIGHT   = 1024
const CFG      = 6.5
const SEED     = 15    // -1 = random

async function main () {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true })

  console.log('Stable Diffusion XL Base 1.0 — text-to-image inference')
  console.log('========================================================')
  console.log('Model  :', MODEL_NAME)
  console.log('Prompt :', PROMPT)
  console.log('Steps  :', STEPS)
  console.log('Size   :', `${WIDTH}x${HEIGHT}`)
  console.log('CFG    :', CFG)
  console.log('Seed   :', SEED)
  console.log()

  const loader = new FilesystemDL({ dirPath: MODELS_DIR })

  const model = new ImgStableDiffusion(
    {
      loader,
      logger: console,
      diskPath: MODELS_DIR,
      modelName: MODEL_NAME
      // No llmModel — SDXL uses CLIP-L + CLIP-G baked into the checkpoint.
      // No vaeModel — the VAE is baked into the checkpoint.
    },
    {
      threads: 4
      // No prediction override — SDXL uses eps-prediction and the GGUF
      // has the correct metadata for auto-detection.
    }
  )

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
      cfg_scale: CFG,
      seed: SEED
      // vae_tiling: true  — uncomment if VAE decode fails at larger resolutions
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
      const outPath = path.join(OUTPUT_DIR, `sdxl_seed${SEED}_${i}.png`)
      fs.writeFileSync(outPath, images[i])
      console.log(`Saved → ${outPath}`)
    }
  } finally {
    console.log('\nUnloading model...')
    await model.unload()
    await loader.close()
    console.log('Done.')
  }
}

main().catch(err => {
  console.error('Fatal:', err.message || err)
  process.exit(1)
})
