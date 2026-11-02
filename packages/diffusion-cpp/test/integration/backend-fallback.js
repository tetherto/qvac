'use strict'

// Run each case in a fresh process: ggml registers backends only once.
// This file is intentionally outside the ordinary *.test.js suite.
const proc = require('bare-process')
const path = require('bare-path')
const test = require('brittle')
const binding = require('../../binding')
const ImgStableDiffusion = require('../../index')
const { ensureModel, isPng, releaseJsLogger } = require('./utils')

const expected = proc.env.QVAC_EXPECT_BACKEND
if (!['CUDA', 'Vulkan', 'CPU'].includes(expected)) {
  throw new Error('Set QVAC_EXPECT_BACKEND to CUDA, Vulkan, or CPU')
}

test(`automatic backend selection executes on ${expected}`, { timeout: 600000 }, async (t) => {
  const logs = []
  binding.setLogger((priority, message) => {
    logs.push(String(message))
    console.log(`[C++ ${priority}] ${message}`)
  })
  let model
  try {
    let modelPath = proc.env.SD_TEST_MODEL_PATH
    if (!modelPath) {
      const [name, directory] = await ensureModel({ modelName: 'stable-diffusion-v2-1-Q8_0.gguf' })
      modelPath = path.join(directory, name)
    }
    model = new ImgStableDiffusion({
      files: { model: modelPath },
      config: {
        device: 'gpu',
        // Leave backend and params_backend unset to exercise automatic fallback.
        backendsDir: proc.env.QVAC_TEST_BACKENDS_DIR,
        prediction: 'v',
        threads: 4,
        vae_auto_cpu_fallback: false,
        verbosity: 3
      },
      logger: console
    })
    await model.load()
    const images = []
    const response = await model.run({
      prompt: 'a red fox in a snowy forest',
      steps: 2,
      width: 256,
      height: 256,
      cfg_scale: 7.5,
      seed: 42
    })
    await response
      .onUpdate((data) => {
        if (data instanceof Uint8Array) images.push(data)
      })
      .await()
    t.is(images.length, 1, 'inference returned one image')
    t.ok(images.length === 1 && isPng(images[0]), 'inference returned a valid PNG')

    // Verify the engine's resolved runtime, not an echoed config or a merely
    // registered device. A CPU fallback must not pass a Vulkan test.
    const selected = new RegExp(`Diffusion model runtime backend: ${expected}(?:[0-9]+)?(?:\\s|$)`)
    const deadline = Date.now() + 5000
    while (!logs.some((line) => selected.test(line)) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    t.ok(
      logs.some((line) => selected.test(line)),
      `diffusion executed on ${expected}`
    )
    if (expected !== 'CUDA') {
      t.absent(
        logs.find((line) => /registry\[\d+\]: name='CUDA', devices=[1-9]/.test(line)),
        'no usable CUDA device was registered'
      )
    }
  } finally {
    if (model) await model.unload().catch(() => {})
    releaseJsLogger(binding)
  }
})
