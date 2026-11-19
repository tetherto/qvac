'use strict'

const fs = require('bare-fs')
const os = require('bare-os')
const path = require('bare-path')
const proc = require('bare-process')
const test = require('brittle')
const binding = require('../../binding')
const ImgStableDiffusion = require('../../index')
const { assessFit } = require('../../fit')
const { ensureModelPath, loadManifest, verifyModelFileOnce, isPng } = require('./utils')
const { waitForLogEvidence } = require('./abot-guards')

// CI stages these files from the package manifest. Missing assets on this lane
// fail the test; a successful ggml run must not pass as Core ML coverage.
const skip = os.platform() !== 'darwin' || os.arch() !== 'arm64'
const modelDir = path.resolve(proc.env.COREML_MODELS_DIR || path.join(__dirname, '../model'))

async function sidecarFiles() {
  const entries = Object.entries(loadManifest().models).filter(
    ([, entry]) => entry.group === 'coreml'
  )
  for (const [name, entry] of entries) {
    const result = await verifyModelFileOnce(path.join(modelDir, name), entry)
    if (!result.ok) throw new Error(`Core ML asset ${name}: ${result.reason}`)
  }
  return {
    model: await ensureModelPath({ modelName: 'stable-diffusion-v2-1-Q8_0.gguf' }),
    taesd: path.join(modelDir, 'taesd.safetensors'),
    coremlUnet: path.join(modelDir, 'sd21base_unet_p6.mlmodelc'),
    coremlTaeDecoder: path.join(modelDir, 'taesd_decoder.mlmodelc')
  }
}

test(
  'SD2 Core ML UNet and tiny decoder generate; tiled decode falls back to ggml',
  { skip, timeout: 600000 },
  async (t) => {
    const files = await sidecarFiles()
    const messages = []
    binding.setLogger((_priority, message) => {
      messages.push(message)
      console.log(message)
    })
    const model = new ImgStableDiffusion({
      files,
      // The exported sidecar is SD 2.1-base (epsilon), with the same OpenCLIP
      // text encoder as the all-in-one SD 2.1 GGUF. Its UNet is replaced.
      config: { device: 'cpu', threads: 4, prediction: 'eps', verbosity: 3 },
      logger: console,
      opts: { stats: true }
    })
    try {
      await model.load()
      await waitForLogEvidence(messages, [
        `coreml unet: ${files.coremlUnet} ready`,
        `coreml tae: ${files.coremlTaeDecoder} ready`
      ])
      t.ok(
        messages.some((m) => /coreml unet: .* ready/.test(m)),
        'native Core ML UNet loaded'
      )
      t.ok(
        messages.some((m) => /coreml tae: .* ready/.test(m)),
        'native Core ML decoder loaded'
      )
      const fit = await assessFit({ files, workload: { width: 512, height: 512 } })
      t.is(fit.status, 'unknown', 'ggml fit does not claim to size Core ML memory')
      t.alike(fit.devices, [])

      for (const tiled of [false, true]) {
        messages.length = 0
        const images = []
        const response = await model.run({
          prompt: 'a red fox in a snowy forest',
          negative_prompt: 'blurry',
          width: 512,
          height: 512,
          steps: 2,
          cfg_scale: 7,
          seed: 42,
          vae_tiling: tiled
        })
        await response
          .onUpdate((data) => {
            if (data instanceof Uint8Array) images.push(data)
          })
          .await()
        t.is(images.length, 1, 'one generated image')
        t.ok(isPng(images[0]), 'valid PNG')
        if (!tiled) await waitForLogEvidence(messages, ['coreml tae: prediction took'])
        t.is(
          messages.some((m) => /coreml tae: prediction took/.test(m)),
          !tiled,
          'untiled decode executes Core ML; tiled decode uses ggml'
        )
        if (images[0]) {
          fs.writeFileSync(path.join(modelDir, `coreml-sd2-tiled-${tiled}.png`), images[0])
        }
      }
    } finally {
      try {
        await model.unload()
      } finally {
        binding.releaseLogger()
      }
    }
  }
)

test('explicit invalid Core ML sidecars fail loading', { skip, timeout: 600000 }, async (t) => {
  const files = await sidecarFiles()
  for (const key of ['coremlUnet', 'coremlTaeDecoder']) {
    const model = new ImgStableDiffusion({
      files: { ...files, [key]: path.join(modelDir, 'missing.mlmodelc') },
      config: { device: 'cpu', prediction: 'eps' }
    })
    try {
      await t.exception.all(() => model.load(), 'explicit selection does not silently fall back')
    } finally {
      await model.unload()
    }
  }
})
