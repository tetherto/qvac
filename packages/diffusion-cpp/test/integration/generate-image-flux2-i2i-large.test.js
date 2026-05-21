'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const os = require('bare-os')
const test = require('brittle')
const binding = require('../../binding')
const ImgStableDiffusion = require('../../index')
const {
  ensureModel,
  detectPlatform,
  setupJsLogger,
  isPng
} = require('./utils')
const { readImageDimensions } = require('../../addon')

const proc = require('bare-process')

const platform = detectPlatform()
const isLinuxX64 = os.platform() === 'linux' && os.arch() === 'x64'
const isMobile = os.platform() === 'ios' || os.platform() === 'android'
const noGpu = proc.env && proc.env.NO_GPU === 'true'
const skip = !isLinuxX64 || noGpu || isMobile

const FLUX2_MODEL = {
  name: 'flux-2-klein-4b-Q8_0.gguf',
  url: 'https://huggingface.co/leejet/FLUX.2-klein-4B-GGUF/resolve/main/flux-2-klein-4b-Q8_0.gguf'
}

const QWEN3_MODEL = {
  name: 'Qwen3-4B-Q4_K_M.gguf',
  url: 'https://huggingface.co/unsloth/Qwen3-4B-GGUF/resolve/main/Qwen3-4B-Q4_K_M.gguf'
}

const VAE_MODEL = {
  name: 'flux2-vae.safetensors',
  url: 'https://huggingface.co/black-forest-labs/FLUX.2-klein-4B/resolve/main/vae/diffusion_pytorch_model.safetensors'
}

const STEPS = 20
const GUIDANCE = 5.0
const SEED = 42

test('FLUX2-klein img2img — generates 1024×1024 output on GPU without OOM', { timeout: 1800000, skip }, async (t) => {
  setupJsLogger(binding)

  const [downloadedModelName, modelDir] = await ensureModel({
    modelName: FLUX2_MODEL.name,
    downloadUrl: FLUX2_MODEL.url
  })

  const [qwenName] = await ensureModel({
    modelName: QWEN3_MODEL.name,
    downloadUrl: QWEN3_MODEL.url
  })

  const [vaeName] = await ensureModel({
    modelName: VAE_MODEL.name,
    downloadUrl: VAE_MODEL.url
  })

  console.log('\n' + '='.repeat(60))
  console.log('FLUX2-KLEIN IMG2IMG 1024×1024 — INTEGRATION TEST')
  console.log('='.repeat(60))
  console.log(` Platform  : ${platform}`)
  console.log(` Model     : ${downloadedModelName}`)
  console.log(` Text Enc  : ${qwenName}`)
  console.log(` VAE       : ${vaeName}`)
  console.log(` Models dir: ${modelDir}`)

  const modelPath = path.join(modelDir, downloadedModelName)
  t.ok(fs.existsSync(modelPath), 'Model file exists on disk')

  const model = new ImgStableDiffusion({
    files: {
      model: path.join(modelDir, downloadedModelName),
      llm: path.join(modelDir, qwenName),
      vae: path.join(modelDir, vaeName)
    },
    config: {
      threads: 4,
      device: 'gpu',
      prediction: 'flux2_flow',
      diffusion_fa: true,
      verbosity: 2
    },
    logger: console,
    opts: { stats: true }
  })

  const images = []
  const progressTicks = []

  try {
    // ── Load ─────────────────────────────────────────────────────────────────
    console.log('\n=== Loading model ===')
    const tLoad = Date.now()
    await model.load()
    const loadMs = Date.now() - tLoad
    console.log(`Loaded in ${(loadMs / 1000).toFixed(1)}s`)
    t.ok(loadMs < 180000, `Model loaded within 180s (took ${(loadMs / 1000).toFixed(1)}s)`)

    // ── Load init image ───────────────────────────────────────────────────────
    const initImagePath = path.join(__dirname, '../../assets/von-neumann.jpg')
    const initImage = fs.readFileSync(initImagePath)
    console.log(`\nLoaded init image: ${initImage.length} bytes`)

    // ── Generate 1024×1024 img2img ────────────────────────────────────────────
    console.log('\n=== Generating 1024×1024 image (img2img) ===')
    console.log(`  Steps    : ${STEPS}`)
    console.log(`  Guidance : ${GUIDANCE}`)
    console.log(`  Seed     : ${SEED}`)

    const tGen = Date.now()

    const response = await model.run({
      prompt: 'same person, color photograph, modern tech CEO, wearing a gray zip up vest, black studio background',
      negative_prompt: 'blurry, low quality, distorted',
      init_image: initImage,
      cfg_scale: 1.0,
      steps: STEPS,
      guidance: GUIDANCE,
      seed: SEED,
      vae_tiling: true
    })

    await response
      .onUpdate((data) => {
        if (data instanceof Uint8Array) {
          images.push(data)
        } else if (typeof data === 'string') {
          try {
            const tick = JSON.parse(data)
            if ('step' in tick && 'total' in tick) {
              progressTicks.push(tick)
            }
          } catch (_) {}
        }
      })
      .await()

    const genMs = Date.now() - tGen
    console.log(`\nGenerated in ${(genMs / 1000).toFixed(1)}s`)

    // ── Assertions ────────────────────────────────────────────────────────────
    const diffusionTicks = progressTicks.filter(tick => tick.total === STEPS)
    t.ok(diffusionTicks.length > 0, `Received diffusion progress ticks (got ${diffusionTicks.length})`)
    if (diffusionTicks.length === 0) return
    t.is(diffusionTicks[diffusionTicks.length - 1].step, STEPS, `Final diffusion tick is step ${STEPS}`)

    t.is(images.length, 1, 'Received exactly 1 image')
    if (images.length === 0) return

    const img = images[0]
    t.ok(img instanceof Uint8Array, 'Image is a Uint8Array')
    t.ok(img.length > 1000, `Image has meaningful size (${img.length} bytes)`)
    t.ok(isPng(img), 'Image has valid PNG magic bytes')

    const dims = readImageDimensions(img)
    t.is(dims.width, 1024, 'Output width is 1024')
    t.is(dims.height, 1024, 'Output height is 1024')

    const outPath = path.join(modelDir, 'generate-image--flux2-i2i-1024-seed42.png')
    fs.writeFileSync(outPath, img)
    console.log(`\nSaved → ${outPath}`)

    // ── Summary ───────────────────────────────────────────────────────────────
    console.log('\n' + '='.repeat(60))
    console.log('TEST SUMMARY')
    console.log('='.repeat(60))
    console.log(` Load time   : ${(loadMs / 1000).toFixed(1)}s`)
    console.log(` Gen time    : ${(genMs / 1000).toFixed(1)}s`)
    console.log(` Steps ticks : ${progressTicks.length}`)
    console.log(` Output dims : ${dims.width}×${dims.height}`)
    console.log(` Image size  : ${img.length} bytes`)
    console.log(' PNG valid   : true')
    console.log('='.repeat(60))
  } finally {
    console.log('\n=== Cleanup ===')
    await model.unload().catch(() => {})
    try {
      binding.releaseLogger()
    } catch (_) {}
    console.log('Done.')
  }
})
