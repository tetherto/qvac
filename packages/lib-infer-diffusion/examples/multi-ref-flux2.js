'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const ImgStableDiffusion = require('../index')

/**
 * FLUX2-klein multi-reference ("fusion") example
 *
 * Demonstrates the new `init_images` API for passing >1 reference image to
 * FLUX2's in-context conditioning. Each reference is addressable in the
 * prompt as @image1, @image2, …
 *
 * Usage:
 *   bare examples/multi-ref-flux2.js [image1] [image2] [...imageN] [-- outputPath]
 *
 * Default: uses temp/headshot.jpeg + temp/marco.png to match the
 *          scripts/multi-ref-flux2-anime.sh shell reference.
 */

async function main () {
  const modelDir = path.join(__dirname, '../models')

  // Split positional args from an optional `-- <outputPath>` tail.
  const rawArgs = Bare.argv.slice(2)
  const sepIdx = rawArgs.indexOf('--')
  const imgArgs =
    sepIdx === -1 ? rawArgs : rawArgs.slice(0, sepIdx)
  const outputImagePath =
    sepIdx === -1 || !rawArgs[sepIdx + 1]
      ? path.join(__dirname, '../temp/goku_fusion_addon.png')
      : path.resolve(rawArgs[sepIdx + 1])

  const inputPaths =
    imgArgs.length > 0
      ? imgArgs.map((p) => path.resolve(p))
      : [
          path.join(__dirname, '../temp/headshot.jpeg'),
          path.join(__dirname, '../temp/marco.png')
        ]

  for (const p of inputPaths) {
    if (!fs.existsSync(p)) {
      console.error(`Error: reference image not found at ${p}`)
      return
    }
  }

  // Ensure output directory exists.
  const outputDir = path.dirname(outputImagePath)
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true })
  }

  console.log('Loading FLUX2-klein model (GPU / Metal)...')

  const model = new ImgStableDiffusion(
    {
      logger: console,
      diskPath: modelDir,
      modelName: 'flux-2-klein-4b-Q8_0.gguf',
      llmModel: 'Qwen3-4B-Q4_K_M.gguf',
      vaeModel: 'flux2-vae.safetensors'
    },
    {
      threads: 4,
      device: 'gpu',
      prediction: 'flux2_flow'
    }
  )

  try {
    await model.load()
    console.log('Model loaded.')

    const initImages = inputPaths.map((p) => {
      const bytes = fs.readFileSync(p)
      console.log(`  reference: ${p} — ${bytes.length} bytes`)
      return bytes
    })

    const STEPS = 10
    const GUIDANCE = 5.0
    const SEED = -1

    // Prompt references every image by its @imageN tag so the FLUX2
    // in-context attention actually uses them. index.js will warn if any
    // @imageN is missing.
    const prompt =
      'A golden blonde hair supersayin with green bead earring with green eyes and ' +
      'blonde lightning hair. Buff dude, mixed version of @image1 and @image2, ' +
      'like a hyperrealistic anime of goku from dragonball z'

    console.log('\n=== FLUX2 multi-reference fusion ===')
    console.log('  Model      : flux-2-klein-4b-Q8_0.gguf')
    console.log('  References : ' + initImages.length)
    console.log('  Steps      : ' + STEPS)
    console.log('  Guidance   : ' + GUIDANCE)
    console.log('  Seed       : ' + SEED)
    console.log('  Output     : ' + outputImagePath)
    console.log()

    const tGenStart = Date.now()
    let lastStepTime = tGenStart

    const response = await model.run({
      prompt,
      negative_prompt: 'blurry, low quality, NSFW, distorted, extra limbs',
      init_images: initImages,
      cfg_scale: 1.0,
      steps: STEPS,
      guidance: GUIDANCE,
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
                `\r  step ${tick.step}/${tick.total} | step took ${(stepMs / 1000).toFixed(1)}s | wall ${(wallMs / 1000).toFixed(1)}s elapsed  `
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
