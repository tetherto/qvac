'use strict'

const LlmLlamacpp = require('../index')
const path = require('bare-path')
const process = require('bare-process')
const { downloadModel } = require('./utils')

const DEFAULT_RUNS = 5
const DEFAULT_WARMUP = 2
const DEFAULT_PROMPT_BASE = 'Explain in detail how neural networks learn through backpropagation, covering gradient descent, chain rule, weight updates, loss functions, activation functions, and optimization techniques. '
const DEFAULT_PROMPT_REPEATS = 50

function parseIntegerArg (name, defaultValue) {
  const arg = process.argv.find(a => a.startsWith(`--${name}=`))
  if (!arg) return defaultValue
  const value = Number.parseInt(arg.split('=')[1], 10)
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid --${name} value`)
  }
  return value
}

function parseStringArg (name, defaultValue) {
  const arg = process.argv.find(a => a.startsWith(`--${name}=`))
  if (!arg) return defaultValue
  return arg.slice(`--${name}=`.length)
}

function median (values) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid]
}

function mean (values) {
  if (values.length === 0) return 0
  return values.reduce((sum, v) => sum + v, 0) / values.length
}

function fmt (value, digits = 2) {
  return Number.isFinite(value) ? value.toFixed(digits) : 'n/a'
}

async function runInference (model, prompt) {
  const response = await model.run([{ role: 'user', content: prompt }])
  let text = ''
  await response.onUpdate(chunk => { text += chunk }).await()
  return { text, stats: response.stats || {} }
}

async function benchmarkMode ({ label, config, modelPath, runs, warmup, prompt }) {
  console.log(`\n${'='.repeat(72)}`)
  console.log(`Benchmarking: ${label}`)
  console.log(`Config: ${JSON.stringify(config)}`)
  console.log('='.repeat(72))

  const model = new LlmLlamacpp({
    files: { model: [modelPath] },
    config,
    logger: null,
    opts: { stats: true }
  })

  const loadStart = Date.now()
  await model.load()
  const loadTime = Date.now() - loadStart
  console.log(`Model loaded in ${loadTime}ms`)

  const samples = []
  const totalRuns = warmup + runs

  try {
    for (let i = 0; i < totalRuns; i++) {
      const phase = i < warmup ? 'warmup' : 'measure'
      const result = await runInference(model, prompt)
      const ttft = Number(result.stats.TTFT)
      const tps = Number(result.stats.TPS)
      const tokens = Number(result.stats.generatedTokens || 0)

      console.log(
        `  [${phase}] run ${i + 1}/${totalRuns} ` +
        `TTFT=${fmt(ttft, 1)}ms TPS=${fmt(tps, 1)} tokens=${tokens}`
      )

      if (i >= warmup) {
        samples.push({ ttft, tps, tokens })
      }
    }
  } finally {
    await model.unload()
  }

  const ttfts = samples.map(s => s.ttft).filter(Number.isFinite)
  const tpsValues = samples.map(s => s.tps).filter(Number.isFinite)

  return {
    label,
    loadTime,
    runs: samples.length,
    ttftMedian: median(ttfts),
    ttftMean: mean(ttfts),
    tpsMedian: median(tpsValues),
    tpsMean: mean(tpsValues),
    avgTokens: mean(samples.map(s => s.tokens))
  }
}

function printSummary (results) {
  console.log(`\n${'='.repeat(72)}`)
  console.log('COMPARISON SUMMARY')
  console.log('='.repeat(72))
  console.log('')
  console.log(
    'Mode'.padEnd(25) +
    'Load(ms)'.padEnd(10) +
    'TTFT med(ms)'.padEnd(14) +
    'TTFT avg(ms)'.padEnd(14) +
    'TPS med'.padEnd(10) +
    'TPS avg'.padEnd(10) +
    'Tokens'
  )
  console.log('-'.repeat(83))

  for (const r of results) {
    console.log(
      r.label.padEnd(25) +
      fmt(r.loadTime, 0).padEnd(10) +
      fmt(r.ttftMedian, 1).padEnd(14) +
      fmt(r.ttftMean, 1).padEnd(14) +
      fmt(r.tpsMedian, 1).padEnd(10) +
      fmt(r.tpsMean, 1).padEnd(10) +
      fmt(r.avgTokens, 0)
    )
  }

  if (results.length >= 2) {
    const baseline = results[0]
    console.log('')
    console.log('Relative to single GPU:')
    for (let i = 1; i < results.length; i++) {
      const r = results[i]
      const ttftDiff = ((r.ttftMedian - baseline.ttftMedian) / baseline.ttftMedian * 100)
      const tpsDiff = ((r.tpsMedian - baseline.tpsMedian) / baseline.tpsMedian * 100)
      console.log(
        `  ${r.label}: TTFT ${ttftDiff >= 0 ? '+' : ''}${fmt(ttftDiff, 1)}%, ` +
        `TPS ${tpsDiff >= 0 ? '+' : ''}${fmt(tpsDiff, 1)}%`
      )
    }
  }
}

async function main () {
  console.log('Multi-GPU Split Mode Benchmark')
  console.log('Compares: single GPU vs layer parallelism vs tensor parallelism')
  console.log('')
  console.log('Usage: bare examples/multiGpuBenchmark.js [options]')
  console.log('Options:')
  console.log(`  --runs=${DEFAULT_RUNS}           Measured runs per mode (default: ${DEFAULT_RUNS})`)
  console.log(`  --warmup=${DEFAULT_WARMUP}         Warmup runs per mode (default: ${DEFAULT_WARMUP})`)
  console.log('  --tensor-split=1,1  GPU split proportions (default: 1,1)')
  console.log('  --ctx-size=4096     Context size (default: 4096)')
  console.log('  --gpu-layers=999    Layers to offload (default: 999)')
  console.log(`  --prompt-repeats=${DEFAULT_PROMPT_REPEATS}  Repeat base prompt N times for large input (default: ${DEFAULT_PROMPT_REPEATS})`)
  console.log('  --prompt=<text>     Custom prompt (overrides prompt-repeats)')
  console.log('')

  const runs = parseIntegerArg('runs', DEFAULT_RUNS)
  const warmup = parseIntegerArg('warmup', DEFAULT_WARMUP)
  const ctxSize = parseIntegerArg('ctx-size', 4096)
  const gpuLayers = parseIntegerArg('gpu-layers', 999)
  const tensorSplit = parseStringArg('tensor-split', '1,1')
  const promptRepeats = parseIntegerArg('prompt-repeats', DEFAULT_PROMPT_REPEATS)
  const prompt = parseStringArg('prompt', DEFAULT_PROMPT_BASE.repeat(promptRepeats) + '\n\nSummarize the above in 3 sentences.')

  const [modelName, dirPath] = await downloadModel(
    'https://huggingface.co/unsloth/Qwen3-32B-GGUF/resolve/main/Qwen3-32B-Q4_K_M.gguf',
    'Qwen3-32B-Q4_K_M.gguf'
  )

  const modelPath = path.join(dirPath, modelName)

  const baseConfig = {
    device: 'gpu',
    gpu_layers: String(gpuLayers),
    ctx_size: String(ctxSize),
    verbosity: '0'
  }

  const modes = [
    {
      label: 'Single GPU (none)',
      config: { ...baseConfig, 'split-mode': 'none' }
    },
    {
      label: 'Layer parallelism',
      config: { ...baseConfig, 'split-mode': 'layer', 'tensor-split': tensorSplit }
    },
    {
      label: 'Tensor parallelism (row)',
      config: { ...baseConfig, 'split-mode': 'row', 'tensor-split': tensorSplit }
    }
  ]

  const results = []

  for (const mode of modes) {
    try {
      const result = await benchmarkMode({
        label: mode.label,
        config: mode.config,
        modelPath,
        runs,
        warmup,
        prompt
      })
      results.push(result)
    } catch (err) {
      console.error(`\n  ERROR in "${mode.label}": ${err.message}`)
      console.error('  Skipping this mode.\n')
    }
  }

  if (results.length > 0) {
    printSummary(results)
  }
}

main().catch(error => {
  console.error('Fatal error:', error.message)
  console.error('Stack:', error.stack)
  process.exit(1)
})
