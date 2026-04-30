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

const DIFFUSION_MODEL = {
  name: 'flux-2-klein-4b-Q8_0.gguf',
  url: 'https://huggingface.co/leejet/FLUX.2-klein-4B-GGUF/resolve/main/flux-2-klein-4b-Q8_0.gguf'
}

const LLM_MODEL = {
  name: 'Qwen3-4B-Q4_K_M.gguf',
  url: 'https://huggingface.co/unsloth/Qwen3-4B-GGUF/resolve/main/Qwen3-4B-Q4_K_M.gguf'
}

const VAE_MODEL = {
  name: 'flux2-vae.safetensors',
  url: 'https://huggingface.co/Comfy-Org/vae-text-encorder-for-flux-klein-4b/resolve/main/split_files/vae/flux2-vae.safetensors'
}

test('FLUX.2 klein txt2img — generates a valid PNG image', { timeout: 1800000, skip }, async (t) => {
  setupJsLogger(binding)

  const [downloadedModelName, modelDir] = await ensureModel({
    modelName: DIFFUSION_MODEL.name,
    downloadUrl: DIFFUSION_MODEL.url
  })

  await ensureModel({
    modelName: LLM_MODEL.name,
    downloadUrl: LLM_MODEL.url
  })

  await ensureModel({
    modelName: VAE_MODEL.name,
    downloadUrl: VAE_MODEL.url
  })

  console.log('\n' + '='.repeat(60))
  console.log('FLUX.2 [klein] 4B — INTEGRATION TEST')
  console.log('='.repeat(60))
  console.log(` Platform  : ${platform}`)
  console.log(` Model     : ${downloadedModelName}`)
  console.log(` LLM       : ${LLM_MODEL.name}`)
  console.log(` VAE       : ${VAE_MODEL.name}`)
  console.log(` Models dir: ${modelDir}`)

  const modelPath = path.join(modelDir, downloadedModelName)
  t.ok(fs.existsSync(modelPath), 'Model file exists on disk')

  const model = new ImgStableDiffusion({
    files: {
      model: path.join(modelDir, downloadedModelName),
      llm: path.join(modelDir, LLM_MODEL.name),
      vae: path.join(modelDir, VAE_MODEL.name)
    },
    config: {
      threads: 4,
      device: useCpu ? 'cpu' : 'gpu'
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
    t.ok(loadMs < 120000, `Model loaded within 120s (took ${(loadMs / 1000).toFixed(1)}s)`)

    // ── Generate ──────────────────────────────────────────────────────────────
    console.log('\n=== Generating image ===')
    const tGen = Date.now()

    const response = await model.run({
      prompt: 'a red fox in a snowy forest, laying on a rock with a santa hat, cartoon, watercolor',
      steps: 10,
      width: 512,
      height: 512,
      guidance: 3.5,
      seed: 1000
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
    t.is(progressTicks[progressTicks.length - 1].total, 10, 'Final progress tick reports 10 total steps')

    t.is(images.length, 1, 'Received exactly 1 image')

    const img = images[0]
    t.ok(img instanceof Uint8Array, 'Image is a Uint8Array')
    t.ok(img.length > 0, `Image is non-empty (${img.length} bytes)`)
    t.ok(isPng(img), 'Image has valid PNG magic bytes')

    const outPath = path.join(modelDir, 'generate-image--flux2-txt2img-seed42.png')
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
