'use strict'

const test = require('brittle')
const fs = require('bare-fs')
const path = require('bare-path')
const proc = require('bare-process')
const ImgStableDiffusion = require('../../index')
const { isPng } = require('./utils')

const modelsDir = proc.env.FLUX3_MODELS_DIR
test(
  'FLUX.3 reference editing accepts one and multiple images',
  {
    skip: !modelsDir,
    timeout: 1200000
  },
  async (t) => {
    const files = {
      model: path.join(modelsDir, 'flux3-image-klein-Q8_0.gguf'),
      llm: path.join(modelsDir, 'Qwen3VL-4B-Instruct-Q4_K_M.gguf'),
      vae: path.join(modelsDir, 'flux3-vae.safetensors')
    }
    for (const file of Object.values(files)) t.ok(fs.existsSync(file), 'required model exists')
    const refs = ['claude-shannon.jpg', 'von-neumann.jpg'].map((name) =>
      fs.readFileSync(path.resolve(__dirname, '../../assets', name))
    )
    const model = new ImgStableDiffusion({
      files,
      config: {
        prediction: 'auto',
        diffusion_fa: true,
        ...(proc.env.FLUX3_BACKEND ? { backend: proc.env.FLUX3_BACKEND } : {})
      }
    })
    try {
      await model.load()
      for (const count of [1, 2]) {
        const images = []
        const response = await model.run({
          prompt: 'A portrait in a garden.',
          init_images: refs.slice(0, count),
          width: 256,
          height: 256,
          steps: 1,
          seed: 42,
          cfg_scale: 1,
          sampling_method: 'euler',
          scheduler: 'discrete'
        })
        await response
          .onUpdate((data) => {
            if (data instanceof Uint8Array) images.push(data)
          })
          .await()
        t.is(images.length, 1, count + ' references produce one image')
        t.ok(images[0] && isPng(images[0]), count + ' references produce a valid PNG')
      }
    } finally {
      await model.unload()
    }
  }
)
