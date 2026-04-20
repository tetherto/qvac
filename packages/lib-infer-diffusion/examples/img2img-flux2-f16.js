'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const ImgStableDiffusion = require('../index')

/**
 * FLUX2-klein F16 img2img example
 *
 * Full precision (F16) version for comparison with Q8_0 quantized model.
 * This should have much less quantization bias.
 */

async function main () {
  const modelDir = path.join(__dirname, '../models')
  const inputImagePath = path.join(__dirname, '../assets/von-neumann.jpg')
  const outputImagePath = path.join(__dirname, '../temp/von-neumann_transformed_f16.png')

  if (!fs.existsSync(inputImagePath)) {
    console.error(`Error: Input image not found at ${inputImagePath}`)
    return
  }

  // Ensure output directory exists
  const outputDir = path.dirname(outputImagePath)
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true })
  }

  console.log('Loading FLUX2-klein F16 model (full precision)...')

  const model = new ImgStableDiffusion({
    files: {
      model: path.join(modelDir, 'flux-2-klein-4b-F16.gguf'), // F16 full precision
      llm: path.join(modelDir, 'Qwen3-4B-Q8_0.gguf'), // Q8 text encoder
      vae: path.join(modelDir, 'flux2-vae.safetensors')
    },
    config: {
      threads: 4,
      device: 'gpu',
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

    const STEPS = 20
    const STRENGTH = 1.0 // CRITICAL: Default is 0.75! Must be 1.0 for full denoising
    const GUIDANCE = 9.0 // Match Iris exactly
    const SEED = -1 // Match Iris exactly

    console.log('\n=== F16 Full Precision Model (Iris-matched settings) ===')
    console.log('  Model    : flux-2-klein-4b-F16.gguf (16-bit)')
    console.log('  Steps    : ' + STEPS)
    console.log('  Strength : ' + STRENGTH + ' (EXPLICIT - addon defaults to 0.75!)')
    console.log('  Effective: ' + Math.round(STEPS * STRENGTH) + " steps (matches Iris's 20 full steps)")
    console.log('  Guidance : ' + GUIDANCE)
    console.log('  Seed     : ' + SEED + '\n')

    const tGenStart = Date.now()
    let lastStepTime = tGenStart

    const response = await model.run({
      prompt: 'a modern tech CEO version of this person, professional headshot, studio lighting',
      negative_prompt: 'blurry, low quality, distorted',
      init_image: initImage,
      strength: STRENGTH,
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
          console.log('\nFor comparison, run the Q8 version:')
          console.log('  bare examples/img2img-flux2.js')
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
