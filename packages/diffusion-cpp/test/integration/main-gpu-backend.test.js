'use strict'

const path = require('bare-path')
const os = require('bare-os')
const proc = require('bare-process')
const test = require('brittle')
const binding = require('../../binding')
const ImgStableDiffusion = require('../../index')
const { ensureModel, releaseJsLogger } = require('./utils')

const BACKENDS_DIR = path.resolve(__dirname, '../../prebuilds')

const MODEL = {
  name: 'stable-diffusion-v2-1-Q4_0.gguf',
  url: 'https://huggingface.co/gpustack/stable-diffusion-v2-1-GGUF/resolve/main/stable-diffusion-v2-1-Q4_0.gguf'
}

async function waitForLog (logs, predicate, timeoutMs = 5000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const match = logs.find(predicate)
    if (match) return match
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return logs.find(predicate)
}

test('main-gpu requests Vulkan0 on Windows multi-GPU runner', { timeout: 600000 }, async (t) => {
  if (os.platform() !== 'win32' || os.arch() !== 'x64') {
    t.pass('main-gpu Windows multi-GPU integration is win32-x64 only')
    return
  }
  if (proc.env && proc.env.NO_GPU === 'true') {
    t.pass('NO_GPU=true; skipping main-gpu multi-GPU integration')
    return
  }

  const logs = []
  binding.setLogger((priority, message) => {
    logs.push(String(message))
    console.log(`[C++ ${priority}] ${message}`)
  })

  let model = null
  try {
    const targetName = 'Vulkan0'
    const targetIndex = 0

    const [modelName, modelDir] = await ensureModel({
      modelName: MODEL.name,
      downloadUrl: MODEL.url
    })

    model = new ImgStableDiffusion({
      files: {
        model: path.join(modelDir, modelName)
      },
      config: {
        device: 'gpu',
        'main-gpu': targetIndex,
        threads: 4,
        prediction: 'v',
        diffusion_fa: true,
        verbosity: 2,
        backendsDir: BACKENDS_DIR
      },
      logger: console,
      opts: { stats: true }
    })

    await model.load()

    const resolvedLog = await waitForLog(logs, (line) =>
      line.includes(`main-gpu resolved to backend '${targetName}'`)
    )
    const backendPinLog = await waitForLog(logs, (line) =>
      line.includes(`main-gpu pinning stable-diffusion backend '${targetName}'`)
    )

    t.ok(resolvedLog, `main-gpu resolved to ${targetName}`)
    t.ok(backendPinLog, `stable-diffusion.cpp was asked to use ${targetName}`)
  } finally {
    if (model) await model.unload().catch(() => {})
    releaseJsLogger(binding)
  }
})
