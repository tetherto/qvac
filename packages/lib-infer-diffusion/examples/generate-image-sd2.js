'use strict'

const path = require('bare-path')
const process = require('bare-process')
const fs = require('bare-fs')
const FilesystemDL = require('@qvac/dl-filesystem')
const ImgStableDiffusion = require('../index')

// ---------------------------------------------------------------------------
// Model file — downloaded via: ./scripts/download-model-sd2.sh
//
// SD2.1 all-in-one GGUF (Q8_0). No separate text encoder or VAE needed.
// Source: gpustack/stable-diffusion-v2-1-GGUF (public, no login required).
//
// prediction: 'v' is set explicitly in the config because even though this is
// a GGUF, the gpustack conversion does not always embed the prediction type KV.
// ---------------------------------------------------------------------------
const MODELS_DIR = path.resolve(__dirname, '../models')
const OUTPUT_DIR = path.resolve(__dirname, '../output')

const MODEL_NAME = 'stable-diffusion-v2-1-Q8_0.gguf'

// ---------------------------------------------------------------------------
// Generation params — edit freely
// SD2.1 is trained at 768×768; 512×512 works but looks softer.
// cfg_scale 7–9 is the typical range; guidance (FLUX-specific) is not used.
// ---------------------------------------------------------------------------
const PROMPT = [
  'a majestic red fox standing in a snowy forest at dusk,',
  'soft golden light through the pine trees,',
  'photorealistic, 8k, detailed fur'
].join(' ')

const NEGATIVE_PROMPT = 'blurry, low quality, watermark, text, bad anatomy'

const STEPS    = 30    // SD2.1 benefits from more steps than FLUX distilled
const WIDTH    = 712   // native training resolution for SD2.1
const HEIGHT   = 712
const CFG      = 7.5   // classifier-free guidance scale
const SEED     = -1    // -1 = random

async function main () {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true })

  console.log('Stable Diffusion 2.1 — text-to-image inference')
  console.log('================================================')
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
      // No llmModel — SD2.1 uses the CLIP text encoder baked into the checkpoint.
      // No vaeModel — the VAE is baked into the checkpoint.
    },
    {
      threads: 4,
      // SD2.1 uses v-prediction. This safetensors file has no GGUF metadata so
      // auto-detection cannot determine the prediction type; set it explicitly.
      prediction: 'v'
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
      cfg_scale: CFG,   // SD1.x / SD2.x CFG — not the FLUX distilled 'guidance'
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
      const outPath = path.join(OUTPUT_DIR, `sd2_seed${SEED}_${i}.png`)
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
