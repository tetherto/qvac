'use strict'

const path = require('bare-path')
const process = require('bare-process')
const fs = require('bare-fs')
const ImgStableDiffusion = require('../index')

// ---------------------------------------------------------------------------
// Model files — downloaded via: ./scripts/download-model.sh
// ---------------------------------------------------------------------------
const MODELS_DIR = path.resolve(__dirname, '../models')
const OUTPUT_DIR = path.resolve(__dirname, '../output')

const MODEL_NAME = 'flux-2-klein-4b-Q8_0.gguf'
const LLM_MODEL = 'Qwen3-4B-Q4_K_M.gguf'
const VAE_MODEL = 'flux2-vae.safetensors'

// ---------------------------------------------------------------------------
// Generation params — edit freely
// ---------------------------------------------------------------------------
const PROMPT = [
  'a majestic red fox standing in a snowy forest at dusk,',
  'soft golden light through the pine trees,',
  'photorealistic, 8k, detailed fur'
].join(' ')

const STEPS = 20
const WIDTH = 512
const HEIGHT = 512
const GUIDANCE = 3.5 // distilled guidance scale for FLUX.2
const SEED = 42 // -1 = random

async function main () {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true })

  console.log('FLUX.2 [klein] 4B — text-to-image inference')
  console.log('============================================')
  console.log('Prompt :', PROMPT)
  console.log('Steps  :', STEPS)
  console.log('Size   :', `${WIDTH}x${HEIGHT}`)
  console.log('Seed   :', SEED)
  console.log()

  const model = new ImgStableDiffusion({
    files: {
      model: path.join(MODELS_DIR, MODEL_NAME),
      llm: path.join(MODELS_DIR, LLM_MODEL),
      vae: path.join(MODELS_DIR, VAE_MODEL)
    },
    config: {
      threads: 4
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
      steps: STEPS,
      width: WIDTH,
      height: HEIGHT,
      guidance: GUIDANCE,
      seed: SEED
    })

    // ── 3. Stream progress + collect image bytes ──────────────────────────────
    const images = []

    await response
      .onUpdate((data) => {
        if (data instanceof Uint8Array) {
          // PNG-encoded output image
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
      const outPath = path.join(OUTPUT_DIR, `output_seed${SEED}_${i}.png`)
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
