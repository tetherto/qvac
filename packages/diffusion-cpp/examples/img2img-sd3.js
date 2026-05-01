'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const ImgStableDiffusion = require('../index')

/**
 * Stable Diffusion 3 Medium img2img example
 *
 * SD3 uses a Multimodal Diffusion Transformer (MMDiT) trained with rectified
 * flow-matching. Key differences from FLUX2 img2img:
 *
 *   - prediction: 'flow'  (not 'flux2_flow')
 *   - Standard CFG (cfg_scale 4.5–7.0) — no separate distilled guidance param
 *   - sampling_method must be 'euler' for flow-matching
 *   - strength controls how much noise is added to the input image before
 *     denoising: 0.4 = subtle edits, 0.65 = balanced, 0.8 = large changes
 *   - All-in-one safetensors — no separate VAE or LLM model paths needed
 *
 * Model downloaded via:  ./scripts/download-model-sd3.sh
 */

async function main () {
  const modelDir = path.join(__dirname, '../models')
  // const inputImagePath = path.join(__dirname, '../temp/headshot.jpeg')
  // const outputImagePath = path.join(__dirname, '../assets/headshot_transformed_sd3.jpeg')
  const inputImagePath = path.join(__dirname, '../assets/von-neumann-colorized.jpg')
  const outputImagePath = path.join(__dirname, '../temp/von-neumann_transformed_sd3.jpg')

  if (!fs.existsSync(inputImagePath)) {
    console.error(`Error: Input image not found at ${inputImagePath}`)
    console.error('Expected path:', inputImagePath)
    return
  }

  // Ensure output directory exists
  const outputDir = path.dirname(outputImagePath)
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true })
  }

  // SD3 Medium — all-in-one safetensors (diffusion + CLIP-L + CLIP-G).
  // Downloaded via ./scripts/download-model-sd3.sh
  const MODEL_NAME = 'sd3_medium_incl_clips.safetensors'

  // ---------------------------------------------------------------------------
  // SD3 img2img parameters
  //
  // cfg_scale 4.5:      stable-diffusion.cpp's own SD3 example uses 4.5 explicitly.
  //                     The library's internal default of 7.0 is tuned for SD1/SD2
  //                     DDPM — too high for flow-matching, causing over-saturation.
  // strength 0.65:      How much the input image is changed. 0.4 = subtle,
  //                     0.65 = balanced identity-preserving edits, 0.8 = heavy.
  // steps 28:           SD3 Medium typically needs 20–30 steps.
  // sampling_method:    Must be 'euler' — euler_a is unstable with flow-matching.
  // ---------------------------------------------------------------------------
  const STEPS = 28
  // stable-diffusion.cpp recommends 4.5 for SD3 flow-matching.
  // The library default of 7.0 is designed for SD1/SD2 DDPM — too high for flow-matching
  // and causes over-saturation and distorted faces in img2img.
  const CFG = 3.5
  const STRENGTH = 0.75
  const SEED = 3

  console.log('\n=== SD3 Medium img2img ===')
  console.log('  Model    : ' + MODEL_NAME)
  console.log('  Steps    : ' + STEPS)
  console.log('  CFG      : ' + CFG + '  (4.5 = sd.cpp SD3 recommended; 7.0 default is for SD1/SD2 only)')
  console.log('  Strength : ' + STRENGTH + '  (0=no change → 1=ignore input)')
  console.log('  Seed     : ' + SEED)
  console.log('  Note     : VAE encode runs first (no progress tick) — please wait...\n')

  const model = new ImgStableDiffusion({
    files: {
      model: path.join(modelDir, MODEL_NAME)
      // All-in-one safetensors: no clipL, clipG, t5Xxl, or vae.
      // To improve text-following, add T5-XXL (download via download-model-sd3.sh):
      //   t5Xxl: path.join(modelDir, 't5xxl_fp8_e4m3fn.safetensors')
    },
    config: {
      threads: 4,
      device: 'gpu',
      prediction: 'flow', // SD3 rectified flow-matching (not flux2_flow)
      flow_shift: '3.0' // SD3 Medium default; controls noise schedule shift
    },
    logger: console
  })

  try {
    console.log('Loading SD3 Medium model...')
    const tLoad = Date.now()
    await model.load()
    console.log(`Model loaded in ${((Date.now() - tLoad) / 1000).toFixed(1)}s\n`)

    const initImage = fs.readFileSync(inputImagePath)
    console.log(`Input image: ${inputImagePath} (${initImage.length} bytes)`)

    const tGenStart = Date.now()
    let lastStepTime = tGenStart

    const response = await model.run({
      prompt: 'anime portrait, same pose, comic-book style, professional illustration',
      negative_prompt: 'photorealistic, blurry, low quality, 3d render, deformed, girl, different person, asian, girl',
      init_image: initImage,

      // SD3 uses standard classifier-free guidance via cfg_scale.
      // There is no separate distilled 'guidance' field like FLUX2.
      cfg_scale: CFG,

      steps: STEPS,
      strength: STRENGTH, // img2img noise strength (0.0–1.0)
      sampling_method: 'euler', // required for SD3 flow-matching
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
