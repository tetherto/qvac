'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const proc = require('bare-process')
const binding = require('../binding')
const ImgStableDiffusion = require('../index')

const MODEL_NAME = proc.env.BENCH_MODEL_NAME || 'stable-diffusion-v2-1-Q8_0.gguf'
const DEVICE = proc.env.BENCH_DEVICE || 'gpu'
const THREADS = Number(proc.env.BENCH_THREADS || 4)
const RESULTS_DIR = path.resolve(__dirname, './results')

const PARAMS = {
  prompt: 'a red fox in a snowy forest, photorealistic',
  negative_prompt: 'blurry, low quality, watermark',
  steps: 10,
  width: 512,
  height: 512,
  cfg_scale: 7.5,
  seed: 42
}

function resolveModelDir (modelName) {
  const explicitDir = proc.env.BENCH_MODEL_DIR
  if (explicitDir) {
    const resolved = path.resolve(explicitDir)
    if (fs.existsSync(path.join(resolved, modelName))) return resolved
    throw new Error(`Model not found in BENCH_MODEL_DIR: ${path.join(resolved, modelName)}`)
  }

  const candidates = [
    path.resolve(__dirname, '../models'),
    path.resolve(__dirname, '../test/model')
  ]

  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, modelName))) return dir
  }

  throw new Error(
    `Model not found. Looked for ${modelName} in:\n` +
    candidates.map(dir => `- ${dir}`).join('\n') +
    '\nSet BENCH_MODEL_DIR to override.'
  )
}

function setupLogger () {
  const enabled = proc.env.BENCH_CPP_LOG === '1'
  const LOG_PRIORITIES = ['ERROR', 'WARNING', 'INFO', 'DEBUG']

  binding.setLogger((priority, message) => {
    if (!enabled) return
    const label = LOG_PRIORITIES[priority] || `UNKNOWN(${priority})`
    console.log(`[C++ ${label}] ${message}`)
  })
}

async function main () {
  setupLogger()

  const modelDir = resolveModelDir(MODEL_NAME)
  fs.mkdirSync(RESULTS_DIR, { recursive: true })

  const stamp = String(Date.now())
  const outPath = path.join(RESULTS_DIR, `diffusion-bootstrap-${stamp}.json`)

  const model = new ImgStableDiffusion(
    {
      logger: console,
      diskPath: modelDir,
      modelName: MODEL_NAME,
      opts: { stats: true }
    },
    {
      threads: THREADS,
      device: DEVICE,
      prediction: 'v'
    }
  )

  const startedAt = Date.now()
  const images = []
  const progressTicks = []
  let stats = null
  let loadMs = null
  let generationMs = null

  try {
    const loadStart = Date.now()
    await model.load()
    loadMs = Date.now() - loadStart

    const runStart = Date.now()
    const response = await model.run(PARAMS)

    if (typeof response.on === 'function') {
      response.on('stats', (s) => { stats = s })
    }

    await response
      .onUpdate((data) => {
        if (data instanceof Uint8Array) {
          images.push(data)
          return
        }

        if (typeof data !== 'string') return

        try {
          const tick = JSON.parse(data)
          if (typeof tick.step === 'number' && typeof tick.total === 'number') {
            progressTicks.push(tick)
          }
        } catch (_) {}
      })
      .await()

    generationMs = Date.now() - runStart

    if (!stats && response.stats) stats = response.stats

    const finishedAt = Date.now()
    const result = {
      benchmark: 'diffusion-bootstrap-txt2img',
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date(finishedAt).toISOString(),
      modelName: MODEL_NAME,
      modelDir,
      device: DEVICE,
      threads: THREADS,
      params: PARAMS,
      loadMs,
      generationMs,
      totalMs: finishedAt - startedAt,
      progressTickCount: progressTicks.length,
      finalProgress: progressTicks[progressTicks.length - 1] || null,
      imageCount: images.length,
      firstImageBytes: images[0] ? images[0].length : 0,
      runtimeStats: stats || null
    }

    fs.writeFileSync(outPath, JSON.stringify(result, null, 2))
    console.log(`Saved benchmark result -> ${outPath}`)
    console.log(`loadMs=${loadMs} generationMs=${generationMs} imageCount=${images.length}`)
  } finally {
    try {
      await model.unload()
    } catch (_) {}
    try {
      binding.releaseLogger()
    } catch (_) {}
  }
}

main().catch((error) => {
  console.error(error.stack || String(error))
  try {
    binding.releaseLogger()
  } catch (_) {}
  proc.exit(1)
})
