'use strict'

// This test is deliberately opt-in: it requires a CUDA-built addon, NVIDIA
// driver access, and the pinned SD2.1 model. Run it on a CUDA runner with
// QVAC_CUDA_SMOKE=1 after `npm run build:cuda`.
const path = require('bare-path')
const proc = require('bare-process')
const test = require('brittle')
const binding = require('../../binding')
const ImgStableDiffusion = require('../../index')
const { ensureModel, isPng, releaseJsLogger } = require('./utils')

const enabled = proc.env && proc.env.QVAC_CUDA_SMOKE === '1'
const MODEL = { name: 'stable-diffusion-v2-1-Q8_0.gguf' }

function hasCuda(logs) {
  return logs.some((line) => /cuda/i.test(line))
}

async function waitForLog(logs, predicate, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (logs.some(predicate)) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return logs.some(predicate)
}

test('CUDA smoke — enumerate, select, generate, reload, and CPU-fallback', {
  timeout: 900000,
  skip: !enabled
}, async (t) => {
  const logs = []
  binding.setLogger((priority, message) => {
    const line = String(message)
    logs.push(line)
    console.log(`[C++ ${priority}] ${line}`)
  })

  let cudaModel = null
  let fallbackModel = null
  try {
    const [modelName, modelDir] = await ensureModel({ modelName: MODEL.name })
    const modelPath = path.join(modelDir, modelName)
    console.log(`CUDA smoke model: ${modelPath}`)
    console.log(`CUDA smoke compiler: ${proc.env.CUDACXX || 'configured by CMake'}`)

    cudaModel = new ImgStableDiffusion({
      files: { model: modelPath },
      config: {
        device: 'gpu',
        backend: 'CUDA0',
        threads: 4,
        prediction: 'v',
        // Keep this toolchain smoke test on the standard CUDA path. Flash
        // attention has separate kernel coverage and is not required to
        // validate CUDA backend discovery, selection, or inference here.
        diffusion_fa: false,
        verbosity: 2
      },
      logger: console,
      opts: { stats: true }
    })
    await cudaModel.load()

    const images = []
    const response = await cudaModel.run({
      prompt: 'a red cube on a white table',
      negative_prompt: 'blurry',
      steps: 1,
      width: 512,
      height: 512,
      cfg_scale: 7.5,
      seed: 42
    })
    await response.onUpdate((data) => {
      if (data instanceof Uint8Array) images.push(data)
    }).await()
    t.ok(hasCuda(logs), 'CUDA backend was enumerated and selected')
    t.is(images.length, 1, 'one CUDA image was generated')
    t.ok(isPng(images[0]), 'CUDA output is a PNG')
    await cudaModel.unload()
    cudaModel = null
    t.pass('CUDA model unload completed')

    // An unavailable integrated GPU must not quietly choose a CUDA device.
    // The addon is required to fall back to CPU in this case; on a multi-GPU
    // CUDA host this exercises the failure path without hiding CUDA itself.
    fallbackModel = new ImgStableDiffusion({
      files: { model: modelPath },
      config: {
        device: 'gpu',
        'main-gpu': 'integrated',
        threads: 4,
        prediction: 'v',
        verbosity: 2
      },
      logger: console
    })
    await fallbackModel.load()
    t.ok(
      await waitForLog(logs, (line) =>
        line.includes("main-gpu 'integrated' not available; falling back to CPU")
      ),
      'unavailable GPU request fell back to CPU'
    )
    await fallbackModel.unload()
    fallbackModel = null
    t.pass('CPU fallback unload completed')
  } finally {
    if (cudaModel) await cudaModel.unload().catch(() => {})
    if (fallbackModel) await fallbackModel.unload().catch(() => {})
    releaseJsLogger(binding)
  }
})
