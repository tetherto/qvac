'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const process = require('bare-process')
const ImgStableDiffusion = require('../index')

/**
 * Generate Claude Shannon portrait at von-neumann.jpg dimensions (496x624)
 * using FLUX2-klein img2img to transform claude-shannon.jpg
 * Output: assets/claude-shannon-resized.jpg
 *
 * Run with: bare examples/generate-shannon-flux.js
 */

async function main () {
  const modelDir = path.join(__dirname, '../models')
  const inputImagePath = path.join(__dirname, '../assets/claude-shannon.jpg')
  const outputImagePath = path.join(__dirname, '../assets/claude-shannon-resized.jpg')

  if (!fs.existsSync(inputImagePath)) {
    console.error(`Error: Input image not found at ${inputImagePath}`)
    process.exit(1)
  }

  console.log('Loading FLUX2-klein model...')

  const model = new ImgStableDiffusion({
    files: {
      model: path.join(modelDir, 'flux-2-klein-4b-Q8_0.gguf'),
      llm: path.join(modelDir, 'Qwen3-4B-Q4_K_M.gguf'),
      vae: path.join(modelDir, 'flux2-vae.safetensors')
    },
    config: {
      threads: 4,
      device: 'gpu',
      diffusion_fa: true,
      prediction: 'flux2_flow'
    },
    logger: console
  })

  try {
    // Load model weights
    await model.load()
    console.log('Model loaded!')

    // Read input image
    const initImage = fs.readFileSync(inputImagePath)
    console.log(`Input image: ${initImage.length} bytes`)

    const STEPS = 15
    const GUIDANCE = 3.5
    const SEED = 42
    const WIDTH = 496
    const HEIGHT = 624

    console.log('\n=== FLUX2-klein img2img: Claude Shannon ===')
    console.log(`  Width    : ${WIDTH}`)
    console.log(`  Height   : ${HEIGHT}`)
    console.log(`  Steps    : ${STEPS}`)
    console.log(`  Guidance : ${GUIDANCE}`)
    console.log(`  Seed     : ${SEED}`)
    console.log(`  Note     : VAE encode runs first (no progress tick) — please wait...\n`)

    const tGenStart = Date.now()
    let lastStepTime = tGenStart

    const response = await model.run({
      prompt: 'high quality portrait of Claude Shannon, scientist, detailed face, natural lighting, same person, professional photograph',
      negative_prompt: 'blurry, low quality, distorted, different person, changed features, warped',
      init_image: initImage,
      width: WIDTH,
      height: HEIGHT,
      cfg_scale: 1.0,
      steps: STEPS,
      guidance: GUIDANCE,
      seed: SEED
    })

    await response
      .onUpdate((data) => {
        if (data instanceof Uint8Array) {
          const totalMs = Date.now() - tGenStart
          console.log(`\n✓ Image generated in ${(totalMs / 1000).toFixed(1)}s`)
          fs.writeFileSync(outputImagePath, data)
          console.log(`✓ Saved to: ${outputImagePath}`)
        } else if (typeof data === 'string') {
          try {
            const tick = JSON.parse(data)
            if ('step' in tick && 'total' in tick) {
              const now = Date.now()
              const stepMs = now - lastStepTime
              lastStepTime = now
              const wallMs = now - tGenStart
              process.stdout.write(
                `\r  step ${tick.step}/${tick.total} | step took ${(stepMs / 1000).toFixed(1)}s | wall ${(wallMs / 1000).toFixed(1)}s elapsed  `
              )
            }
          } catch (_) {}
        }
      })
      .await()

    console.log('\nDone!')
  } catch (error) {
    console.error('Error:', error)
  } finally {
    await model.unload()
  }
}

main()
