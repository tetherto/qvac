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

const proc = require('bare-process')

const platform = detectPlatform()
const isDarwinX64 = os.platform() === 'darwin' && os.arch() === 'x64'
const isLinuxArm64 = os.platform() === 'linux' && os.arch() === 'arm64'
const isMobile = os.platform() === 'ios' || os.platform() === 'android'
const noGpu = proc.env && proc.env.NO_GPU === 'true'
const useCpu = isDarwinX64 || isLinuxArm64 || noGpu
const skip = isMobile || noGpu

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
const GUIDANCE = 3.5
const SEED = 42

test('FLUX2-klein img2img — transforms an input image', { timeout: 1800000, skip }, async (t) => {
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
  console.log('FLUX2-KLEIN IMG2IMG — INTEGRATION TEST')
  console.log('='.repeat(60))
  console.log(` Platform  : ${platform}`)
  console.log(` Model     : ${downloadedModelName}`)
  console.log(` Text Enc  : ${qwenName}`)
  console.log(` VAE       : ${vaeName}`)
  console.log(` Models dir: ${modelDir}`)

  const modelPath = path.join(modelDir, downloadedModelName)
  t.ok(fs.existsSync(modelPath), 'Model file exists on disk')

  const model = new ImgStableDiffusion(
    {
      logger: console,
      diskPath: modelDir,
      modelName: downloadedModelName,
      llmModel: qwenName,
      vaeModel: vaeName
    },
    {
      threads: 4,
      device: useCpu ? 'cpu' : 'gpu',
      prediction: 'flux2_flow'
    }
  )

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
    if (!fs.existsSync(initImagePath)) {
      t.fail(`Init image not found at ${initImagePath}`)
      return
    }
    const initImage = fs.readFileSync(initImagePath)
    console.log(`\nLoaded init image: ${initImage.length} bytes`)

    // ── Generate (img2img) ────────────────────────────────────────────────────
    console.log('\n=== Generating image (img2img) ===')
    console.log(`  Steps    : ${STEPS}`)
    console.log(`  Guidance : ${GUIDANCE}`)
    console.log(`  Seed     : ${SEED}`)

    const tGen = Date.now()

    const response = await model.run({
      prompt: 'same person, color photograph, modern tech CEO of this version, wearing a gray zip up vest, black studio background',
      negative_prompt: 'blurry, low quality, NSFW, distorted, different person, different face',
      init_image: initImage,
      cfg_scale: 1.0,
      steps: STEPS,
      guidance: GUIDANCE,
      seed: SEED
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
    t.ok(progressTicks.length > 0, `Received progress ticks (got ${progressTicks.length})`)
    t.is(progressTicks[progressTicks.length - 1].total, STEPS, `Final progress tick reports ${STEPS} total steps`)

    t.is(images.length, 1, 'Received exactly 1 image')

    const img = images[0]
    t.ok(img instanceof Uint8Array, 'Image is a Uint8Array')
    t.ok(img.length > 1000, `Image has meaningful size (${img.length} bytes)`)
    t.ok(isPng(img), 'Image has valid PNG magic bytes')

    // Saved to modelDir so mobile has write permission to the same path
    const outPath = path.join(modelDir, 'generate-image--flux2-i2i-seed42.png')
    fs.writeFileSync(outPath, img)
    console.log(`\nSaved → ${outPath}`)

    // ── Summary ───────────────────────────────────────────────────────────────
    console.log('\n' + '='.repeat(60))
    console.log('TEST SUMMARY')
    console.log('='.repeat(60))
    console.log(` Load time   : ${(loadMs / 1000).toFixed(1)}s`)
    console.log(` Gen time    : ${(genMs / 1000).toFixed(1)}s`)
    console.log(` Steps ticks : ${progressTicks.length}`)
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
