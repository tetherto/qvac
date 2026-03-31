'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const proc = require('bare-process')
const binding = require('../binding')
const ImgStableDiffusion = require('../index')

const MODEL_NAME = proc.env.BENCH_MODEL_NAME || 'stable-diffusion-v2-1-Q8_0.gguf'
const DEVICE = proc.env.BENCH_DEVICE || 'gpu'
const THREADS = Number(proc.env.BENCH_THREADS || 4)
const REPEATS = parsePositiveInt(proc.env.BENCH_REPEATS, 1)
const RESULTS_DIR = path.resolve(__dirname, './results')

const RUNTIME_CONFIG = {
  modelName: MODEL_NAME,
  device: DEVICE,
  threads: THREADS,
  repeats: REPEATS
}

const CASES = [
  {
    id: 'sd2-steps8-384',
    params: {
      prompt: 'a red fox in a snowy forest, photorealistic',
      negative_prompt: 'blurry, low quality, watermark',
      steps: 8,
      width: 384,
      height: 384,
      cfg_scale: 7.5,
      seed: 42
    }
  },
  {
    id: 'sd2-steps10-512',
    params: {
      prompt: 'a red fox in a snowy forest, photorealistic',
      negative_prompt: 'blurry, low quality, watermark',
      steps: 10,
      width: 512,
      height: 512,
      cfg_scale: 7.5,
      seed: 42
    }
  },
  {
    id: 'sd2-steps16-512',
    params: {
      prompt: 'a red fox in a snowy forest, photorealistic',
      negative_prompt: 'blurry, low quality, watermark',
      steps: 16,
      width: 512,
      height: 512,
      cfg_scale: 7.5,
      seed: 42
    }
  }
]

function parsePositiveInt (value, fallback) {
  if (value == null || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, got: ${value}`)
  }
  return parsed
}

function applyEnvOverrides (params) {
  const steps = proc.env.BENCH_STEPS != null
    ? parsePositiveInt(proc.env.BENCH_STEPS, params.steps)
    : params.steps

  const width = proc.env.BENCH_WIDTH != null
    ? parsePositiveInt(proc.env.BENCH_WIDTH, params.width)
    : params.width

  const height = proc.env.BENCH_HEIGHT != null
    ? parsePositiveInt(proc.env.BENCH_HEIGHT, params.height)
    : params.height

  return {
    ...params,
    steps,
    width,
    height
  }
}

function buildCases () {
  return CASES.map((item) => ({
    id: item.id,
    params: applyEnvOverrides(item.params)
  }))
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

function average (values) {
  if (values.length === 0) return null
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)
}

function min (values) {
  if (values.length === 0) return null
  return Math.min(...values)
}

function max (values) {
  if (values.length === 0) return null
  return Math.max(...values)
}

function aggregateRuns (runs) {
  const okRuns = runs.filter(run => run.status === 'ok')
  const generationTimes = okRuns
    .map(run => run.generationMs)
    .filter(value => Number.isFinite(value))

  return {
    repeats: runs.length,
    successes: okRuns.length,
    failures: runs.length - okRuns.length,
    avgGenerationMs: average(generationTimes),
    minGenerationMs: min(generationTimes),
    maxGenerationMs: max(generationTimes)
  }
}

function toMarkdown (report) {
  const lines = []
  lines.push('# Diffusion Bootstrap Benchmark Report')
  lines.push('')
  lines.push(`- Started: ${report.startedAt}`)
  lines.push(`- Finished: ${report.finishedAt}`)
  lines.push(`- Model: ${report.modelName}`)
  lines.push(`- Device: ${report.runtime.device}`)
  lines.push(`- Threads: ${report.runtime.threads}`)
  lines.push(`- Repeats per case: ${report.runtime.repeats}`)
  lines.push(`- Load ms: ${report.loadMs}`)
  lines.push('')
  lines.push('| Case | Steps | Size | Repeats | OK | Avg ms | Min ms | Max ms | Images | Error |')
  lines.push('|---|---:|---|---:|---:|---:|---:|---:|---:|---|')

  for (const item of report.cases) {
    const size = `${item.params.width}x${item.params.height}`
    const firstError = item.runs.find(run => run.error)
    const error = firstError ? firstError.error.message : ''
    const lastOk = [...item.runs].reverse().find(run => run.status === 'ok')
    const imageCount = lastOk ? lastOk.imageCount : 0

    lines.push(
      `| ${item.id} | ${item.params.steps} | ${size} | ${item.summary.repeats} | ${item.summary.successes} | ${item.summary.avgGenerationMs ?? ''} | ${item.summary.minGenerationMs ?? ''} | ${item.summary.maxGenerationMs ?? ''} | ${imageCount} | ${error} |`
    )
  }

  lines.push('')
  return `${lines.join('\n')}\n`
}

async function runOnce (model, caseDef) {
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
      status: 'ok',
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
      status: 'error',
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

async function runCase (model, caseDef, repeats) {
  const runs = []

  for (let i = 0; i < repeats; i++) {
    console.log(`  repeat ${i + 1}/${repeats}`)
    const result = await runOnce(model, caseDef)
    runs.push(result)
    console.log(`    -> ${result.status} generationMs=${result.generationMs} imageCount=${result.imageCount}`)
  }

  return {
    id: caseDef.id,
    params: caseDef.params,
    runs,
    summary: aggregateRuns(runs)
  }
}

async function main () {
  setupLogger()

  const modelDir = resolveModelDir(RUNTIME_CONFIG.modelName)
  const casesToRun = buildCases()

  fs.mkdirSync(RESULTS_DIR, { recursive: true })

  const stamp = tsFileStamp()
  const jsonPath = path.join(RESULTS_DIR, `diffusion-bootstrap-${stamp}.json`)
  const mdPath = path.join(RESULTS_DIR, `diffusion-bootstrap-${stamp}.md`)

  const model = new ImgStableDiffusion(
    {
      logger: console,
      diskPath: modelDir,
      modelName: RUNTIME_CONFIG.modelName,
      opts: { stats: true }
    },
    {
      threads: RUNTIME_CONFIG.threads,
      device: RUNTIME_CONFIG.device,
      prediction: 'v'
    }
  )

  const startedAt = Date.now()
  let loadMs = null
  const caseResults = []

  try {
    const loadStart = Date.now()
    await model.load()
    loadMs = Date.now() - loadStart

    for (let i = 0; i < casesToRun.length; i++) {
      const caseDef = casesToRun[i]
      console.log(`[${i + 1}/${casesToRun.length}] ${caseDef.id}`)
      const result = await runCase(model, caseDef, RUNTIME_CONFIG.repeats)
      caseResults.push(result)
      console.log(
        `  summary -> ok=${result.summary.successes}/${result.summary.repeats} avg=${result.summary.avgGenerationMs} min=${result.summary.minGenerationMs} max=${result.summary.maxGenerationMs}`
      )
    }

    const finishedAt = Date.now()
    const report = {
      benchmark: 'diffusion-bootstrap-txt2img',
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date(finishedAt).toISOString(),
      modelName: RUNTIME_CONFIG.modelName,
      modelDir,
      runtime: RUNTIME_CONFIG,
      loadMs,
      totalMs: finishedAt - startedAt,
      cases: caseResults
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
