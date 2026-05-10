'use strict'

const GGMLBert = require('../index')
const path = require('bare-path')
const process = require('bare-process')
const { downloadModel } = require('./utils')

const DEFAULT_RUNS = 5
const DEFAULT_WARMUP = 2
const DEFAULT_TEXTS = [
  'The quick brown fox jumps over the lazy dog.',
  'Artificial intelligence is transforming the world.',
  'Embeddings capture semantic meaning in high-dimensional space.',
  'Neural networks learn representations through gradient descent.',
  'Multi-GPU inference distributes computation for faster throughput.'
]

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

async function runInference (model, texts) {
  const response = await model.run(texts)
  const embeddings = await response.await()
  return { embeddings, stats: response.stats || {} }
}

async function benchmarkMode ({ label, config, modelPath, runs, warmup, texts }) {
  console.log(`\n${'='.repeat(72)}`)
  console.log(`Benchmarking: ${label}`)
  console.log(`Config: ${JSON.stringify(config)}`)
  console.log('='.repeat(72))

  const model = new GGMLBert({
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
      const result = await runInference(model, texts)
      const totalTokens = Number(result.stats.total_tokens || 0)
      const totalTimeMs = Number(result.stats.total_time_ms || 0)
      const tps = Number(result.stats.tokens_per_second || 0)

      console.log(
        `  [${phase}] run ${i + 1}/${totalRuns} ` +
        `tokens=${totalTokens} time=${fmt(totalTimeMs, 1)}ms TPS=${fmt(tps, 1)}`
      )

      if (i >= warmup) {
        samples.push({ totalTokens, totalTimeMs, tps })
      }
    }
  } finally {
    await model.unload()
  }

  const tpsValues = samples.map(s => s.tps).filter(Number.isFinite)
  const timeValues = samples.map(s => s.totalTimeMs).filter(Number.isFinite)

  return {
    label,
    loadTime,
    runs: samples.length,
    tpsMedian: median(tpsValues),
    tpsMean: mean(tpsValues),
    timeMedian: median(timeValues),
    timeMean: mean(timeValues),
    avgTokens: mean(samples.map(s => s.totalTokens))
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
    'Time med(ms)'.padEnd(14) +
    'Time avg(ms)'.padEnd(14) +
    'TPS med'.padEnd(10) +
    'TPS avg'.padEnd(10) +
    'Tokens'
  )
  console.log('-'.repeat(83))

  for (const r of results) {
    console.log(
      r.label.padEnd(25) +
      fmt(r.loadTime, 0).padEnd(10) +
      fmt(r.timeMedian, 1).padEnd(14) +
      fmt(r.timeMean, 1).padEnd(14) +
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
      const timeDiff = ((r.timeMedian - baseline.timeMedian) / baseline.timeMedian * 100)
      const tpsDiff = ((r.tpsMedian - baseline.tpsMedian) / baseline.tpsMedian * 100)
      console.log(
        `  ${r.label}: time ${timeDiff >= 0 ? '+' : ''}${fmt(timeDiff, 1)}%, ` +
        `TPS ${tpsDiff >= 0 ? '+' : ''}${fmt(tpsDiff, 1)}%`
      )
    }
  }
}

async function main () {
  console.log('Multi-GPU Split Mode Benchmark (Embed)')
  console.log('Compares: single GPU vs layer parallelism vs tensor parallelism')
  console.log('')
  console.log('Usage: bare examples/multiGpuBenchmark.js [options]')
  console.log('Options:')
  console.log(`  --runs=${DEFAULT_RUNS}           Measured runs per mode (default: ${DEFAULT_RUNS})`)
  console.log(`  --warmup=${DEFAULT_WARMUP}         Warmup runs per mode (default: ${DEFAULT_WARMUP})`)
  console.log('  --tensor-split=1,1  GPU split proportions (default: 1,1)')
  console.log('  --gpu-layers=999    Layers to offload (default: 999)')
  console.log('')

  const runs = parseIntegerArg('runs', DEFAULT_RUNS)
  const warmup = parseIntegerArg('warmup', DEFAULT_WARMUP)
  const gpuLayers = parseIntegerArg('gpu-layers', 999)
  const tensorSplit = parseStringArg('tensor-split', '1,1')

  const [modelName, dirPath] = await downloadModel(
    'https://huggingface.co/unsloth/embeddinggemma-300m-GGUF/resolve/main/embeddinggemma-300M-Q8_0.gguf',
    'embeddinggemma-300M-Q8_0.gguf'
  )

  const modelPath = path.join(dirPath, modelName)

  const baseConfig = {
    device: 'gpu',
    gpu_layers: String(gpuLayers),
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
        texts: DEFAULT_TEXTS
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
