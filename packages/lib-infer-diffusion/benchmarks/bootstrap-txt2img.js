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

const BASE_PARAMS = {
  prompt: 'a red fox in a snowy forest, photorealistic',
  negative_prompt: 'blurry, low quality, watermark',
  steps: 10,
  width: 512,
  height: 512,
  cfg_scale: 7.5,
  seed: 42
}

const CASES = [
  {
    id: 'sd2-steps8-384',
    params: { ...BASE_PARAMS, steps: 8, width: 384, height: 384 }
  },
  {
    id: 'sd2-steps10-512',
    params: { ...BASE_PARAMS, steps: 10, width: 512, height: 512 }
  },
  {
    id: 'sd2-steps16-512',
    params: { ...BASE_PARAMS, steps: 16, width: 512, height: 512 }
  }
]

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

function tsFileStamp () {
  const d = new Date()
  const yyyy = String(d.getFullYear())
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  return `${yyyy}${mm}${dd}-${hh}${mi}${ss}`
}

function toMarkdown (report) {
  const lines = []
  lines.push('# Diffusion Bootstrap Benchmark Report')
  lines.push('')
  lines.push(`- Started: ${report.startedAt}`)
  lines.push(`- Finished: ${report.finishedAt}`)
  lines.push(`- Model: ${report.modelName}`)
  lines.push(`- Device: ${report.device}`)
  lines.push(`- Threads: ${report.threads}`)
  lines.push(`- Load ms: ${report.loadMs}`)
  lines.push('')
  lines.push('| Case | Steps | Size | Status | Gen ms | Images | Progress ticks | First image bytes | Error |')
  lines.push('|---|---:|---|---|---:|---:|---:|---:|---|')

  for (const item of report.cases) {
    const size = `${item.params.width}x${item.params.height}`
    const error = item.error ? item.error.message : ''
    lines.push(
      `| ${item.id} | ${item.params.steps} | ${size} | ${item.status} | ${item.generationMs ?? ''} | ${item.imageCount} | ${item.progressTickCount} | ${item.firstImageBytes} | ${error} |`
    )
  }

  lines.push('')
  return `${lines.join('\n')}\n`
}

async function runCase (model, caseDef) {
  const images = []
  const progressTicks = []
  let stats = null
  const startedAt = Date.now()

  try {
    const response = await model.run(caseDef.params)

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

    if (!stats && response.stats) stats = response.stats

    return {
      id: caseDef.id,
      status: 'ok',
      params: caseDef.params,
      generationMs: Date.now() - startedAt,
      progressTickCount: progressTicks.length,
      finalProgress: progressTicks[progressTicks.length - 1] || null,
      imageCount: images.length,
      firstImageBytes: images[0] ? images[0].length : 0,
      runtimeStats: stats || null,
      error: null
    }
  } catch (error) {
    return {
      id: caseDef.id,
      status: 'error',
      params: caseDef.params,
      generationMs: Date.now() - startedAt,
      progressTickCount: progressTicks.length,
      finalProgress: progressTicks[progressTicks.length - 1] || null,
      imageCount: images.length,
      firstImageBytes: images[0] ? images[0].length : 0,
      runtimeStats: stats || null,
      error: {
        message: error.message || String(error)
      }
    }
  }
}

async function main () {
  setupLogger()

  const modelDir = resolveModelDir(MODEL_NAME)
  fs.mkdirSync(RESULTS_DIR, { recursive: true })

  const stamp = tsFileStamp()
  const jsonPath = path.join(RESULTS_DIR, `diffusion-bootstrap-${stamp}.json`)
  const mdPath = path.join(RESULTS_DIR, `diffusion-bootstrap-${stamp}.md`)

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
  let loadMs = null
  const cases = []

  try {
    const loadStart = Date.now()
    await model.load()
    loadMs = Date.now() - loadStart

    for (let i = 0; i < CASES.length; i++) {
      const caseDef = CASES[i]
      console.log(`[${i + 1}/${CASES.length}] ${caseDef.id}`)
      const result = await runCase(model, caseDef)
      cases.push(result)
      console.log(`  -> ${result.status} generationMs=${result.generationMs} imageCount=${result.imageCount}`)
    }

    const finishedAt = Date.now()
    const report = {
      benchmark: 'diffusion-bootstrap-txt2img',
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date(finishedAt).toISOString(),
      modelName: MODEL_NAME,
      modelDir,
      device: DEVICE,
      threads: THREADS,
      loadMs,
      totalMs: finishedAt - startedAt,
      cases
    }

    fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2))
    fs.writeFileSync(mdPath, toMarkdown(report))

    console.log(`Saved JSON -> ${jsonPath}`)
    console.log(`Saved MD   -> ${mdPath}`)
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
