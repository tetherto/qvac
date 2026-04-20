'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const ImgStableDiffusion = require('../index')

/**
 * FLUX2-klein multi-reference ("fusion") example — two scientists edition
 *
 * Fuses two reference images (two scientists) into a single
 * output via FLUX2's ref_images / RoPE in-context conditioning.
 *
 *   Model      : flux-2-klein-4b-Q8_0.gguf
 *   LLM        : Qwen3-4B-Q4_K_M.gguf
 *   VAE        : flux2-vae.safetensors
 *   Sampler    : euler, cfg_scale: 1.0
 *   Flash attn : on (diffusion_fa)
 *   refs       : assets/von-neumann.jpg + assets/claude-shannon.jpg
 *
 * Note: FLUX2-klein's text encoder (Qwen3) does not receive vision tokens
 * for refs, so @imageN tags in the prompt are prose to the model. The
 * fusion is purely visual (attention over ref latents in the DiT).
 *
 * Run:
 *   bare examples/generate-fusion.js
 */

async function main () {
  const modelDir = path.join(__dirname, '../models')
  const refPaths = [
    path.join(__dirname, '../assets/von-neumann.jpg'),
    path.join(__dirname, '../assets/claude-shannon.jpg')
  ]
  const outputImagePath = path.join(__dirname, '../output/fusion_two_scientists.png')

  for (const p of refPaths) {
    if (!fs.existsSync(p)) {
      console.error(`Error: reference image not found at ${p}`)
      return
    }
  }

  const outputDir = path.dirname(outputImagePath)
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true })
  }

  console.log('Loading FLUX2-klein-4B (GPU / Metal, diffusion_fa=on)...')

  const model = new ImgStableDiffusion({
    files: {
      model: path.join(modelDir, 'flux-2-klein-4b-Q8_0.gguf'),
      llm: path.join(modelDir, 'Qwen3-4B-Q4_K_M.gguf'),
      vae: path.join(modelDir, 'flux2-vae.safetensors')
    },
    config: {
      threads: 4,
      device: 'gpu',
      prediction: 'flux2_flow',
      diffusion_fa: true
    },
    logger: console
  })

  try {
    await model.load()
    console.log('Model loaded.')

    const refBuffers = refPaths.map((p, i) => {
      const buf = fs.readFileSync(p)
      console.log(`  @image${i + 1} : ${p} (${buf.length} bytes)`)
      return buf
    })

    const STEPS = 10
    const SEED = 10
    const WIDTH = 624
    const HEIGHT = 624
    const GUIDANCE = 3.5

    // TODO: write your own prompt here
    const prompt = [
      'two scientists in @image1 and @image2 shaking hands in a lab, use @image1 and @image2 as the two scientists, black studio background, colorized.'
    ].join(', ')

    console.log('\n=== FLUX2 fusion (2 references — two scientists) ===')
    console.log('  Model      : flux-2-klein-4b-Q8_0.gguf')
    console.log('  Refs       : ' + refBuffers.length)
    console.log('  Steps      : ' + STEPS)
    console.log('  Sampler    : euler')
    console.log('  cfg_scale  : 1.0')
    console.log('  Guidance   : ' + GUIDANCE)
    console.log('  Size       : ' + WIDTH + 'x' + HEIGHT)
    console.log('  Seed       : ' + SEED)
    console.log('  Output     : ' + outputImagePath)
    console.log()
    console.log('prompt: ' + prompt)
    const tGenStart = Date.now()
    let lastStepTime = tGenStart

    const response = await model.run({
      prompt,
      init_images: refBuffers,
      width: WIDTH,
      height: HEIGHT,
      sample_method: 'euler',
      cfg_scale: 1.0,
      guidance: GUIDANCE,
      steps: STEPS,
      seed: SEED
    })

    await response
      .onUpdate((data) => {
        if (data instanceof Uint8Array) {
          const totalMs = Date.now() - tGenStart
          console.log(`\nImage generated in ${(totalMs / 1000).toFixed(1)}s`)
          fs.writeFileSync(outputImagePath, data)
          console.log(`Saved to: ${outputImagePath}`)
        } else if (typeof data === 'string') {
          try {
            const tick = JSON.parse(data)
            if ('step' in tick && 'total' in tick) {
              const now = Date.now()
              const stepMs = now - lastStepTime
              lastStepTime = now
              const wallMs = now - tGenStart
              process.stdout.write(
                `\r  step ${tick.step}/${tick.total} | step ${(stepMs / 1000).toFixed(1)}s | wall ${(wallMs / 1000).toFixed(1)}s  `
              )
            }
          } catch (_) {}
        }
      })
      .await()

    console.log('\nDone.')
  } catch (error) {
    console.error('Error:', error)
  } finally {
    await model.unload()
  }
}

main()
