'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const process = require('bare-process')
const ImgStableDiffusion = require('../index')

// Distilled Klein 4B: four Euler steps, text CFG 1, native FLUX.2 schedule.
// CUDA im2col + matrix multiplication avoids the slow direct VAE convolution
// path measured on GB10 and RTX 5090. Keep weights resident for requests.
async function main() {
  const modelsDir = path.resolve(process.env.FLUX_MODELS_DIR || path.join(__dirname, '../models'))
  const outputDir = path.resolve(process.env.FLUX_OUTPUT_DIR || path.join(__dirname, '../output'))
  const width = Number(process.env.FLUX_WIDTH || 864)
  const height = Number(process.env.FLUX_HEIGHT || 480)
  const count = Number(process.env.FLUX_IMAGES || 1)
  const seed = Number(process.env.FLUX_SEED || 0)
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width % 32 ||
    height % 32
  ) {
    throw new Error('FLUX_WIDTH and FLUX_HEIGHT must be positive multiples of 32')
  }
  if (!Number.isInteger(count) || count <= 0 || !Number.isSafeInteger(seed) || seed < 0) {
    throw new Error(
      'FLUX_IMAGES must be a positive integer and FLUX_SEED a nonnegative safe integer'
    )
  }
  const files = {
    model: path.join(modelsDir, 'flux-2-klein-4b-Q8_0.gguf'),
    llm: path.join(modelsDir, 'Qwen3-4B-Q4_K_M.gguf'),
    vae: path.join(modelsDir, 'flux2-vae.safetensors')
  }
  for (const file of Object.values(files)) {
    if (!fs.existsSync(file)) throw new Error(`Missing FLUX.2 asset: ${file}`)
  }
  const model = new ImgStableDiffusion({
    files,
    config: {
      device: 'gpu',
      backend: 'cuda0',
      params_backend: 'cuda0',
      prediction: 'flux2_flow',
      diffusion_fa: true,
      vae_conv_direct: false
    },
    opts: { stats: true },
    logger: console
  })
  try {
    const loadStart = Date.now()
    await model.load()
    console.log(`Model load: ${Date.now() - loadStart} ms`)
    fs.mkdirSync(outputDir, { recursive: true })
    for (let index = 0; index < count; index++) {
      let png
      const start = Date.now()
      const response = await model.run({
        prompt:
          process.env.FLUX_PROMPT ||
          'A cozy wooden cabin beside a still alpine lake at sunrise, pine forest and snowy mountain peaks reflected in the water, realistic landscape photograph.',
        width,
        height,
        steps: 4,
        cfg_scale: 1,
        guidance: 1,
        sampling_method: 'euler',
        seed
      })
      response.on('stats', (stats) => console.log('Native stats:', JSON.stringify(stats)))
      await response
        .onUpdate((data) => {
          if (data instanceof Uint8Array) png = data
          else console.log('Progress:', data)
        })
        .await()
      const elapsedMs = Date.now() - start
      if (!png) throw new Error('FLUX.2 completed without a PNG')
      const file = path.join(outputDir, `flux2-cuda-${width}x${height}-${index}.png`)
      fs.writeFileSync(file, png)
      console.log(`Request-to-PNG: ${elapsedMs} ms; saved ${file}`)
    }
  } finally {
    await model.unload()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
