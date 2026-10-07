'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const process = require('bare-process')
const ImgStableDiffusion = require('../index')

// The committed boat frame was generated with the leejet/FLUX.2-klein-4B-GGUF
// model at revision 3b1f5a9dc3abb32238b053aeb3d823c30afdacbd
// (flux-2-klein-4b-Q8_0.gguf SHA-256:
// 0bba6951258ec8f92d51114a8fa13e66828297bfff58a738f52729b3ef66fa28).
// Text encoder: unsloth/Qwen3-4B-GGUF revision
// 22c9fc8a8c7700b76a1789366280a6a5a1ad1120. The local VAE file SHA-256
// was d64f3a68e1cc4f9f4e29b6e0da38a0204fe9a49f2d4053f0ec1fa1ca02f9c4b5.
// Generation used 960x544, 20 steps, and guidance 3.5.
const KEYFRAMES = {
  boat: {
    seed: 95,
    prompt:
      'Photorealistic travel photograph of one small traditional wooden passenger motorboat floating in a clear turquoise lagoon in Thailand. Broad side view from the beach, entire boat visible. The bow is a plain gently tapered wooden hull with no fittings projecting above it. A single modern outboard motor is attached to the stern and its propeller is submerged behind the boat. A low cream canvas awning covers the empty seats. Limestone islands and lush greenery in the distance, bright natural daylight, realistic nautical construction, no people, no text.'
  },
  balloon: {
    seed: 43,
    prompt:
      'Photorealistic travel photograph of a single red and cream hot air balloon floating above green rolling hills at sunrise. The full fabric envelope and wicker basket are clearly visible against a soft blue sky, with warm sunlight, light mist in the valleys, natural color and sharp detail. Cinematic wide composition, no writing, no illustration.'
  }
}

async function main() {
  const modelsDir = path.resolve(process.env.FLUX_MODELS_DIR || path.join(__dirname, '../models'))
  const files = {
    model: path.resolve(modelsDir, process.env.FLUX_MODEL || 'flux-2-klein-4b-Q8_0.gguf'),
    llm: path.resolve(modelsDir, process.env.FLUX_LLM || 'Qwen3-4B-Q4_K_M.gguf'),
    vae: path.resolve(modelsDir, process.env.FLUX_VAE || 'flux2-vae.safetensors')
  }
  for (const [name, filePath] of Object.entries(files)) {
    if (!fs.existsSync(filePath)) throw new Error(`Missing FLUX.2 ${name}: ${filePath}`)
  }

  const variant = process.env.H3_KEYFRAME
  if (variant && !KEYFRAMES[variant]) {
    throw new Error(`H3_KEYFRAME must be boat or balloon, got: ${variant}`)
  }
  const width = Number(process.env.H3_WIDTH || 960)
  const height = Number(process.env.H3_HEIGHT || 544)
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width % 32 ||
    height % 32
  ) {
    throw new Error('H3_WIDTH and H3_HEIGHT must be positive multiples of 32')
  }

  const outputDir = path.resolve(
    process.env.H3_KEYFRAME_OUTPUT_DIR || path.join(__dirname, '../assets')
  )
  const config = {
    device: process.env.FLUX_DEVICE || 'gpu',
    diffusion_fa: true,
    prediction: 'flux2_flow'
  }
  if (process.env.FLUX_BACKEND) config.backend = process.env.FLUX_BACKEND
  const model = new ImgStableDiffusion({ files, config, logger: console })
  try {
    await model.load()
    fs.mkdirSync(outputDir, { recursive: true })
    for (const [name, keyframe] of Object.entries(KEYFRAMES)) {
      if (variant && name !== variant) continue
      const response = await model.run({
        prompt: (name === variant && process.env.FLUX_IMAGE_PROMPT) || keyframe.prompt,
        width,
        height,
        steps: Number(process.env.FLUX_STEPS || 20),
        guidance: Number(process.env.FLUX_GUIDANCE || 3.5),
        seed: Number(process.env.FLUX_SEED || keyframe.seed)
      })
      let png
      await response
        .onUpdate((data) => {
          if (data instanceof Uint8Array) png = data
        })
        .await()
      if (!png) throw new Error(`FLUX.2 completed without a PNG for ${name}`)
      const outputPath = path.join(outputDir, `h3-keyframe-${name}.png`)
      fs.writeFileSync(outputPath, png)
      console.log(`Saved FLUX.2 keyframe: ${outputPath}`)
    }
  } finally {
    await model.unload()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
