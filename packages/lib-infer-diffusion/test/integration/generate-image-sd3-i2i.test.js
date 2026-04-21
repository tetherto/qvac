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

const SD3_MODEL = {
  name: 'sd3_medium_incl_clips.safetensors',
  url: 'https://huggingface.co/adamo1139/stable-diffusion-3-medium-ungated/resolve/main/sd3_medium_incl_clips.safetensors'
}

const STEPS = 20
const CFG_SCALE = 3.5
const STRENGTH = 0.75
const SEED = 3

test('SD3 Medium img2img — transforms an input image', { timeout: 1800000, skip }, async (t) => {
  setupJsLogger(binding)

  const [downloadedModelName, modelDir] = await ensureModel({
    modelName: SD3_MODEL.name,
    downloadUrl: SD3_MODEL.url
  })

  console.log('\n' + '='.repeat(60))
  console.log('SD3 MEDIUM IMG2IMG — INTEGRATION TEST')
  console.log('='.repeat(60))
  console.log(` Platform  : ${platform}`)
  console.log(` Model     : ${downloadedModelName}`)
  console.log(` Models dir: ${modelDir}`)

  const modelPath = path.join(modelDir, downloadedModelName)
  t.ok(fs.existsSync(modelPath), 'Model file exists on disk')

  const model = new ImgStableDiffusion({
    files: {
      model: path.join(modelDir, downloadedModelName)
    },
    config: {
      threads: 4,
      device: useCpu ? 'cpu' : 'gpu',
      vae_on_cpu: true,
      prediction: 'flow',
      flow_shift: '3.0'
    },
    logger: console
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
    const initImagePath = path.join(__dirname, '../../assets/von-neumann-colorized.jpg')
    if (!fs.existsSync(initImagePath)) {
      t.fail(`Init image not found at ${initImagePath}`)
      return
    }
    const initImage = fs.readFileSync(initImagePath)
    console.log(`\nLoaded init image: ${initImage.length} bytes`)

    // ── Generate (img2img) ────────────────────────────────────────────────────
    console.log('\n=== Generating image (img2img) ===')
    console.log(`  Steps    : ${STEPS}`)
    console.log(`  CFG Scale: ${CFG_SCALE}`)
    console.log(`  Strength : ${STRENGTH}`)
    console.log(`  Seed     : ${SEED}`)

    const tGen = Date.now()

    const response = await model.run({
      prompt: 'anime portrait, scientist, same pose, comic-book style, professional illustration',
      negative_prompt: 'photorealistic, blurry, low quality, 3d render, deformed, different person',
      init_image: initImage,
      cfg_scale: CFG_SCALE,
      steps: STEPS,
      strength: STRENGTH,
      sampling_method: 'euler',
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

    t.is(images.length, 1, 'Received exactly 1 image')

    if (images.length === 0) {
      t.fail('No image received — generation may have failed (check GPU memory)')
      return
    }

    const img = images[0]
    t.ok(img instanceof Uint8Array, 'Image is a Uint8Array')
    t.ok(img.length > 1000, `Image has meaningful size (${img.length} bytes)`)
    t.ok(isPng(img), 'Image has valid PNG magic bytes')

    const outPath = path.join(modelDir, 'generate-image--sd3-i2i-seed3.png')
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
