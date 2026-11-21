'use strict'

const test = require('brittle')
const fs = require('bare-fs')
const path = require('bare-path')
const proc = require('bare-process')
const ImgStableDiffusion = require('../../index')
const { isPng } = require('./utils')

const modelsDir = proc.env.FIBO_MODELS_DIR

test(
  'Fibo Edit Turbo: references, validation, cancellation and reload',
  { skip: !modelsDir, timeout: 1200000 },
  async (t) => {
    const files = {
      model: path.join(modelsDir, 'fibo2_edit_turbo-q4_0.gguf'),
      llm: path.join(modelsDir, 'Qwen3VL-4B-Instruct-Q4_K_M.gguf'),
      llmVision: path.join(modelsDir, 'mmproj-Qwen3VL-4B-Instruct-F16.gguf'),
      vae: path.join(modelsDir, 'vae/flux2-vae.safetensors')
    }
    for (const file of Object.values(files)) {
      if (!fs.existsSync(file)) throw new Error(`Missing Fibo component: ${file}`)
    }
    const asset = (name) => path.resolve(__dirname, '../../assets', name)
    const refs = [
      proc.env.FIBO_TEST_IMAGE || asset('claude-shannon.jpg'),
      asset('von-neumann-colorized.jpg'),
      asset('h3-keyframe-balloon.png'),
      asset('h3-keyframe-boat.png')
    ].map((file) => fs.readFileSync(file))
    const config = { threads: 8, diffusion_fa: true }
    if (proc.env.FIBO_BACKEND) {
      config.backend = proc.env.FIBO_BACKEND
      config.params_backend = proc.env.FIBO_BACKEND
    }
    const model = new ImgStableDiffusion({ files, config, opts: { stats: true } })
    const params = {
      prompt: 'Add a blue magician hat with gold stars. Preserve the person and background.',
      width: 512,
      height: 512,
      steps: 4,
      cfg_scale: 1,
      sampling_method: 'euler',
      scheduler: 'flux',
      seed: 42
    }
    const outputDir = proc.env.FIBO_TEST_OUTPUT_DIR
    if (outputDir) fs.mkdirSync(outputDir, { recursive: true })

    async function generate(name, overrides = {}) {
      const images = []
      const start = Date.now()
      const response = await model.run({ ...params, init_image: refs[0], ...overrides })
      await response
        .onUpdate((data) => {
          if (data instanceof Uint8Array) images.push(data)
        })
        .await()
      t.is(images.length, 1, `${name}: one image`)
      t.ok(images[0] && isPng(images[0]), `${name}: valid PNG`)
      if (images[0]) {
        const view = new DataView(images[0].buffer, images[0].byteOffset, images[0].byteLength)
        t.is(view.getUint32(16), params.width, `${name}: requested width`)
        t.is(view.getUint32(20), params.height, `${name}: requested height`)
        if (outputDir) fs.writeFileSync(path.join(outputDir, `${name}.png`), images[0])
      }
      console.log(JSON.stringify({ event: 'fibo-case', name, elapsedMs: Date.now() - start }))
    }

    async function rejects(overrides, pattern, name) {
      try {
        const response = await model.run({ ...params, ...overrides })
        await response.onUpdate(() => {}).await()
        t.fail(`${name}: expected rejection`)
      } catch (error) {
        t.ok(pattern.test(error.message), `${name}: ${error.message}`)
      }
    }

    try {
      await model.load()
      await generate('single-reference')
      for (const count of [2, 4]) {
        await generate(`${count}-references`, {
          init_image: undefined,
          init_images: refs.slice(0, count),
          prompt:
            count === 2
              ? 'Place the person from <image_1> beside the person from <image_2> in a garden.'
              : 'Create a collage with the people from <image_1> and <image_2>, the balloon from <image_3>, and the boat from <image_4>.'
        })
      }
      await rejects(
        { init_image: refs[0], init_images: [refs[1]] },
        /mutually exclusive/,
        'conflicting image inputs'
      )
      await rejects({ init_images: [] }, /empty array/, 'empty references')
      await rejects(
        { init_image: new Uint8Array([1, 2, 3]) },
        /decode|corrupt|unsupported/i,
        'corrupt image'
      )

      let cancelled = false
      const response = await model.run({ ...params, init_image: refs[0], steps: 32 })
      try {
        await response
          .onUpdate(async (data) => {
            if (!cancelled && typeof data === 'string') {
              cancelled = true
              await model.cancel()
            }
          })
          .await()
      } catch (error) {
        t.ok(/cancel|aborted|stopp?ed/i.test(error.message), `cancel settles: ${error.message}`)
      }
      t.ok(cancelled, 'cancel requested after native progress')
      await generate('after-cancel')
      await model.unload()
      await model.load()
      await generate('after-reload', {
        prompt: JSON.stringify({ edit_instruction: params.prompt })
      })
    } finally {
      await model.unload()
    }
  }
)
