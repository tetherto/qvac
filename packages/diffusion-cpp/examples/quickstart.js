'use strict'

/**
 * Stable Diffusion Quickstart Example
 *
 * Generate an image from a text prompt using SD2.1.
 *
 * Prerequisites: ./scripts/download-model-sd2.sh
 * Usage: bare examples/quickstart.js
 */

const path = require('bare-path')
const process = require('bare-process')
const fs = require('bare-fs')
const binding = require('../binding')
const ImgStableDiffusion = require('../index')

const MODELS_DIR = path.resolve(__dirname, '../models')
const OUTPUT_DIR = path.resolve(__dirname, '../output')

const MODEL_NAME = 'stable-diffusion-v2-1-Q8_0.gguf'
const PROMPT = 'a cozy cabin in a snowy mountain landscape at sunset, warm light from windows, photorealistic'
const NEGATIVE_PROMPT = 'blurry, low quality, watermark, text'

async function main () {
  console.log('=== Stable Diffusion Quickstart ===\n')

  // 1. Setup native logger
  const LOG_PRIORITIES = ['ERROR', 'WARNING', 'INFO', 'DEBUG']
  binding.setLogger((priority, message) => {
    const label = LOG_PRIORITIES[priority] || `UNKNOWN(${priority})`
    console.log(`[C++ ${label}] ${message}`)
  })

  // 2. Validate model exists
  const modelPath = path.join(MODELS_DIR, MODEL_NAME)
  if (!fs.existsSync(modelPath)) {
    console.error(`Model not found: ${modelPath}`)
    console.error('Run: ./scripts/download-model-sd2.sh')
    binding.releaseLogger()
    return
  }

  fs.mkdirSync(OUTPUT_DIR, { recursive: true })

  console.log(`Model : ${MODEL_NAME}`)
  console.log(`Prompt: ${PROMPT}\n`)

  const model = new ImgStableDiffusion({
    files: {
      model: path.join(MODELS_DIR, MODEL_NAME)
    },
    config: {
      threads: 4,
      prediction: 'v',
      verbosity: 2
    },
    logger: console,
    opts: { stats: true }
  })

  try {
    // 3. Load model weights
    console.log('1. Loading model weights...')
    const tLoad = Date.now()
    await model.load()
    console.log(`   Loaded in ${((Date.now() - tLoad) / 1000).toFixed(1)}s\n`)

    // 4. Generate image
    console.log('2. Generating image...')
    const images = []

    const response = await model.run({
      prompt: PROMPT,
      negative_prompt: NEGATIVE_PROMPT,
      steps: 20,
      width: 512,
      height: 512,
      cfg_scale: 7.5,
      seed: 42
    })

    let stats = null
    response.on('stats', (s) => { stats = s })

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
              process.stdout.write(`\r   [${bar}] ${tick.step}/${tick.total} steps`)
            }
          } catch (_) {}
        }
      })
      .await()

    process.stdout.write('\n')
    console.log(`   Got ${images.length} image(s)\n`)

    // 5. Save output
    console.log('3. Saving output...')
    for (let i = 0; i < images.length; i++) {
      const outPath = path.join(OUTPUT_DIR, `quickstart_${i}.png`)
      fs.writeFileSync(outPath, images[i])
      console.log(`   Saved → ${outPath}`)
    }

    // 6. Print runtime stats
    if (!stats) stats = response.stats
    if (stats) {
      console.log('\n4. Runtime Stats:')
      for (const [key, value] of Object.entries(stats)) {
        const formatted = typeof value === 'number'
          ? (Number.isInteger(value) ? String(value) : value.toFixed(4))
          : String(value)
        console.log(`   ${key}: ${formatted}`)
      }
    }
  } finally {
    // 7. Cleanup
    console.log('\n5. Cleaning up...')
    await model.unload()
    binding.releaseLogger()
    console.log('\nDone!')
  }
}

main().catch(err => {
  console.error('Error:', err.message || err)
  binding.releaseLogger()
  process.exit(1)
})
