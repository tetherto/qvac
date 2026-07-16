'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const os = require('bare-os')
const proc = require('bare-process')
const ImgStableDiffusion = require('../../index')
const { ensureModel, verifyLocalModelPath, detectPlatform, isPng, safeTest } = require('./utils')

const platform = detectPlatform()
const isDarwinX64 = os.platform() === 'darwin' && os.arch() === 'x64'
const isLinuxArm64 = os.platform() === 'linux' && os.arch() === 'arm64'
const isMobile = os.platform() === 'ios' || os.platform() === 'android'
const noGpu = proc.env && proc.env.NO_GPU === 'true'
const skip = isMobile || noGpu || isDarwinX64 || isLinuxArm64
const EXAMPLE_MODELS_DIR = path.resolve(__dirname, '../../models')

const DIFFUSION_MODEL = {
  name: 'ideogram4-Q4_0.gguf',
  url: 'https://huggingface.co/leejet/ideogram-4-GGUF/resolve/c93c0ac616d3abc7910c9af0bf117244ce3a11c4/ideogram4-Q4_0.gguf'
}

const UNCOND_MODEL = {
  name: 'ideogram4_uncond-Q4_0.gguf',
  url: 'https://huggingface.co/leejet/ideogram-4-GGUF/resolve/c93c0ac616d3abc7910c9af0bf117244ce3a11c4/ideogram4_uncond-Q4_0.gguf'
}

const LLM_MODEL = {
  name: 'Qwen3-VL-8B-Instruct-Q4_K_M.gguf',
  url: 'https://huggingface.co/unsloth/Qwen3-VL-8B-Instruct-GGUF/resolve/b93a7ee713758252c555be4210c00540df954dc2/Qwen3-VL-8B-Instruct-Q4_K_M.gguf'
}

const VAE_MODEL = {
  name: 'flux2-vae.safetensors',
  url: 'https://huggingface.co/black-forest-labs/FLUX.2-klein-4B/resolve/e7b7dc27f91deacad38e78976d1f2b499d76a294/vae/diffusion_pytorch_model.safetensors'
}

const PROMPT = JSON.stringify({
  high_level_description:
    'A bright product photo of one yellow coffee mug on a clean office desk with a tiny readable label that says IDEO.',
  style_description: {
    aesthetics: 'simple product photography, clean bright office desk, minimal composition',
    lighting: 'soft studio light with gentle shadows',
    photo: 'sharp focus, crisp readable label text',
    medium: 'product photo',
    color_palette: ['#FFD54A', '#FFFFFF', '#111111', '#7EC8E3']
  },
  compositional_deconstruction: {
    canvas: 'Square canvas, upright orientation. All text is horizontal and readable.',
    background: 'Clean white office desk with a soft blue background gradient.',
    elements: [
      {
        type: 'obj',
        bbox: [230, 260, 800, 740],
        desc: 'Exactly one matte yellow ceramic coffee mug centered on the desk.'
      },
      {
        type: 'text',
        bbox: [510, 360, 620, 640],
        text: 'IDEO',
        desc: 'Small black label printed horizontally on the mug.'
      }
    ]
  }
})

async function resolveModelPath(spec) {
  const examplePath = path.join(EXAMPLE_MODELS_DIR, spec.name)
  if (fs.existsSync(examplePath)) {
    const stats = fs.statSync(examplePath)
    if (stats.size > 0) {
      await verifyLocalModelPath({ modelName: spec.name, filePath: examplePath })
      console.log(`[model] Using verified example model: ${examplePath}`)
      return examplePath
    }
  }

  const [downloadedModelName, modelDir] = await ensureModel({
    modelName: spec.name,
    downloadUrl: spec.url
  })
  return path.join(modelDir, downloadedModelName)
}

safeTest(
  'Ideogram 4 txt2img smoke - generates a valid PNG image',
  { timeout: 3600000, skip },
  async (t) => {
    let model = null
    try {
      const diffusionModelPath = await resolveModelPath(DIFFUSION_MODEL)
      const uncondModelPath = await resolveModelPath(UNCOND_MODEL)
      const llmModelPath = await resolveModelPath(LLM_MODEL)
      const vaeModelPath = await resolveModelPath(VAE_MODEL)

      console.log('\n' + '='.repeat(60))
      console.log('IDEOGRAM 4 - SMOKE INTEGRATION TEST')
      console.log('='.repeat(60))
      console.log(` Platform  : ${platform}`)
      console.log(` Model     : ${diffusionModelPath}`)
      console.log(` Uncond    : ${uncondModelPath}`)
      console.log(` LLM       : ${llmModelPath}`)
      console.log(` VAE       : ${vaeModelPath}`)

      t.ok(fs.existsSync(diffusionModelPath), 'Diffusion model file exists on disk')
      t.ok(fs.existsSync(uncondModelPath), 'Unconditional model file exists on disk')
      t.ok(fs.existsSync(llmModelPath), 'LLM model file exists on disk')
      t.ok(fs.existsSync(vaeModelPath), 'VAE model file exists on disk')

      model = new ImgStableDiffusion({
        files: {
          model: diffusionModelPath,
          uncondModel: uncondModelPath,
          llm: llmModelPath,
          vae: vaeModelPath
        },
        config: {
          threads: 4,
          device: 'gpu',
          diffusion_fa: true,
          offload_to_cpu: true,
          verbosity: 2
        },
        logger: console,
        opts: { stats: true }
      })

      console.log('\n=== Loading model ===')
      await model.load()
      t.pass('Model loaded')

      const images = []
      const progressTicks = []

      console.log('\n=== Generating smoke image ===')
      const response = await model.run({
        prompt: PROMPT,
        steps: 2,
        width: 256,
        height: 256,
        cfg_scale: 7,
        seed: 42
      })

      await response
        .onUpdate((data) => {
          if (data instanceof Uint8Array) {
            images.push(data)
          } else if (typeof data === 'string') {
            try {
              const tick = JSON.parse(data)
              if ('step' in tick && 'total' in tick) progressTicks.push(tick)
            } catch (_) {}
          }
        })
        .await()

      t.ok(progressTicks.length > 0, `Received progress ticks (got ${progressTicks.length})`)
      t.is(
        progressTicks[progressTicks.length - 1].total,
        2,
        'Final progress tick reports 2 total steps'
      )

      t.is(images.length, 1, 'Received exactly 1 image')
      t.ok(images[0] instanceof Uint8Array, 'Image is a Uint8Array')
      t.ok(images[0].length > 0, `Image is non-empty (${images[0].length} bytes)`)
      t.ok(isPng(images[0]), 'Image has valid PNG magic bytes')

      const outPath = path.join(
        path.dirname(diffusionModelPath),
        'generate-image--ideogram-smoke-seed42.png'
      )
      fs.writeFileSync(outPath, images[0])
      console.log(`\nSaved -> ${outPath}`)
    } finally {
      console.log('\n=== Cleanup ===')
      if (model) await model.unload().catch(() => {})
      console.log('Done.')
    }
  }
)
