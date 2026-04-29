'use strict'

const path = require('bare-path')
const process = require('bare-process')
const fs = require('bare-fs')
const ImgStableDiffusion = require('../index')

// ---------------------------------------------------------------------------
// Model file — downloaded via: ./scripts/download-model-sd2.sh
// ---------------------------------------------------------------------------
const MODELS_DIR = path.resolve(__dirname, '../models')
const OUTPUT_DIR = path.resolve(__dirname, '../output')

const MODEL_NAME = 'stable-diffusion-v2-1-Q8_0.gguf'

// ---------------------------------------------------------------------------
// Generation params
// ---------------------------------------------------------------------------
const PROMPT = [
  'a majestic red fox standing in a snowy forest at dusk,',
  'soft golden light through the pine trees,',
  'photorealistic, 8k, detailed fur'
].join(' ')

const NEGATIVE_PROMPT = 'blurry, low quality, watermark, text, bad anatomy'

const STEPS = 20
const WIDTH = 512
const HEIGHT = 512
const CFG = 7.5
const SEED = 42

function printStats (label, stats) {
  console.log(`\n── ${label} ${'─'.repeat(60 - label.length)}`)
  if (!stats || typeof stats !== 'object') {
    console.log('  (no stats available)')
    return
  }
  const keys = Object.keys(stats)
  const maxLen = Math.max(...keys.map(k => k.length))
  for (const [key, value] of Object.entries(stats)) {
    const formatted = typeof value === 'number'
      ? (Number.isInteger(value) ? String(value) : value.toFixed(4))
      : String(value)
    console.log(`  ${key.padEnd(maxLen)}  ${formatted}`)
  }
}

async function main () {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true })

  console.log('Stable Diffusion 2.1 — RuntimeStats Example')
  console.log('=============================================')
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
    },
    config: {
      threads: 4,
      prediction: 'v'
    },
    logger: console,
    opts: { stats: true }
  })

  try {
    // ── 1. Load weights ─────────────────────────────────────────────────────
    console.log('Loading model weights...')
    const tLoad = Date.now()
    await model.load()
    console.log(`Loaded in ${((Date.now() - tLoad) / 1000).toFixed(1)}s\n`)

    // ── 2. First generation ─────────────────────────────────────────────────
    console.log('Starting generation 1/2...')
    const images1 = []

    const response1 = await model.run({
      prompt: PROMPT,
      negative_prompt: NEGATIVE_PROMPT,
      steps: STEPS,
      width: WIDTH,
      height: HEIGHT,
      cfg_scale: CFG,
      seed: SEED
    })

    let stats1 = null
    response1.on('stats', (s) => { stats1 = s })

    await response1
      .onUpdate((data) => {
        if (data instanceof Uint8Array) {
          images1.push(data)
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
    console.log(`Got ${images1.length} image(s)`)

    if (!stats1) stats1 = response1.stats
    printStats('Generation 1 — RuntimeStats', stats1)

    for (let i = 0; i < images1.length; i++) {
      const outPath = path.join(OUTPUT_DIR, `sd2_stats_gen1_${i}.png`)
      fs.writeFileSync(outPath, images1[i])
      console.log(`Saved → ${outPath}`)
    }

    // ── 3. Second generation (cumulative stats) ─────────────────────────────
    console.log('\nStarting generation 2/2 (different seed)...')
    const images2 = []

    const response2 = await model.run({
      prompt: PROMPT,
      negative_prompt: NEGATIVE_PROMPT,
      steps: STEPS,
      width: WIDTH,
      height: HEIGHT,
      cfg_scale: CFG,
      seed: 123
    })

    let stats2 = null
    response2.on('stats', (s) => { stats2 = s })

    await response2
      .onUpdate((data) => {
        if (data instanceof Uint8Array) {
          images2.push(data)
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
    console.log(`Got ${images2.length} image(s)`)

    if (!stats2) stats2 = response2.stats
    printStats('Generation 2 — Cumulative RuntimeStats', stats2)

    for (let i = 0; i < images2.length; i++) {
      const outPath = path.join(OUTPUT_DIR, `sd2_stats_gen2_${i}.png`)
      fs.writeFileSync(outPath, images2[i])
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
