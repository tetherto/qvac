'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const process = require('bare-process')
const ImgStableDiffusion = require('../index')

const KEYFRAMES = {
  boat: {
    seed: 42,
    prompt:
      'Photorealistic travel photograph of a single traditional wooden Thai long-tail boat floating on clear turquoise water near a tropical limestone island. The full weathered wooden hull, pointed bow, canopy, and long-tail motor are visible in the foreground, with gentle ripples, pale sand, lush cliffs and a blue sky behind it. Natural daylight, rich realistic color, sharp detail, cinematic wide composition, no people, no writing, no illustration.'
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

  const outputDir = path.resolve(process.env.H3_KEYFRAME_OUTPUT_DIR || path.join(__dirname, '../assets'))
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
