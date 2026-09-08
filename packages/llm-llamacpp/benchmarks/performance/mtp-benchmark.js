'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const process = require('bare-process')

const {
  parseArgs,
  parseAddonSource,
  resolveAddonCtor,
  createAddonRuntimeLogger,
  buildConfigObject
} = require('./utils')
const { average, stddev, elapsedMs, parsePositiveInt, round } = require('./math')
const { tsFileStamp } = require('./reporters')

const DEFAULT_MODEL_PATH = path.resolve(__dirname, '../../test/model/Qwen3.5-0.8B-MTP-Q8_0.gguf')

const PROMPTS = {
  short: [
    { role: 'system', content: 'You are a concise technical assistant.' },
    {
      role: 'user',
      content:
        'Explain why speculative decoding can improve token generation speed in one paragraph.'
    }
  ],
  medium: [
    { role: 'system', content: 'You are a careful performance engineer.' },
    {
      role: 'user',
      content: [
        'Create a practical checklist for validating a local inference optimization.',
        'Include what to measure, how to keep comparisons fair, and what failure signals to watch.',
        'Keep the answer structured and specific.'
      ].join(' ')
    }
  ],
  long: [
    { role: 'system', content: 'You are a careful performance engineer.' },
    {
      role: 'user',
      content: makeLongPrompt()
    }
  ]
}

function makeLongPrompt() {
  const notes = [
    'A team added multi-token prediction support to a llama.cpp-backed inference addon.',
    'The implementation uses the same model file when the GGUF includes next-token heads.',
    'The benchmark must compare normal decoding and MTP decoding on identical prompts.',
    'Measurements should separate model load time from generation time.',
    'The report should include throughput, latency, generated tokens, and draft acceptance.',
    'Short, medium, and long prompts can expose different prefill and decode behavior.'
  ]
  return [
    'Using the notes below, write an engineering assessment of the optimization.',
    'Discuss expected performance behavior, risks, and how to interpret benchmark results.',
    Array.from({ length: 32 }, (_, i) => `Note ${i + 1}: ${notes[i % notes.length]}`).join('\n')
  ].join('\n\n')
}

function printHelp() {
  console.log(`MTP benchmark runner

Usage:
  bare ./mtp-benchmark.js [options]

Options:
  --model-path <path>       MTP GGUF path. Default: ${DEFAULT_MODEL_PATH}
  --addon-source <source>   local or npm. Default: local
  --device <device>         cpu or gpu. Default: gpu
  --gpu-layers <n>          GPU layer count. Default: 999
  --ctx-size <n>            Context size. Default: 2048
  --batch-size <n>          Batch size. Default: 512
  --ubatch-size <n>         Ubatch size. Default: 512
  --n-predict <list>        Comma-separated generation lengths. Default: 64,256,512
  --spec-draft-n-max <n>    Max draft tokens per speculative round. Fabric default: 3
  --spec-draft-n-min <n>    Minimum draft tokens to use. Fabric default: 0
  --spec-draft-p-min <n>    Minimum draft token probability. Fabric default: 0
  --spec-draft-type-k <t>   Draft KV key cache type. Fabric default: f16
  --spec-draft-type-v <t>   Draft KV value cache type. Fabric default: f16
  --spec-draft-device <d>   Draft backend device list
  --spec-draft-ngl <n>      Draft GPU layer count
  --no-spec-draft-backend-sampling
                            Disable fabric backend-side draft sampling
  --prompt-cases <list>     Comma-separated cases: short,medium,long. Default: short,medium,long
  --repeats <n>             Measured runs per mode/case. Default: 5
  --warmups <n>             Warmup runs per mode/case. Default: 1
  --seed <n>                Sampling seed. Default: 42
  --temp <n>                Sampling temperature. Default: 0
  --results-dir <path>      Output directory. Default: ./results/mtp
  --debug                   Forward native logs to console
  --help                    Show this help
`)
}

function parseCsvList(value, fallback) {
  if (value == null || value === true || String(value).trim() === '') return fallback
  return String(value)
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
}

function parsePositiveIntList(value, fallback, name) {
  return parseCsvList(value, fallback.map(String)).map((x) => parsePositiveInt(x, name))
}

function numberOrNull(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function parseOptionalBool(value, name) {
  if (value == null) return false
  if (value === true) return true
  const normalized = String(value).trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  throw new Error(`Invalid ${name}: ${value}. Expected true/false, yes/no, on/off, or 1/0.`)
}

function safeRatio(numerator, denominator, digits = 3) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null
  return round(numerator / denominator, digits)
}

function createRuntimeConfig(args, nPredict, mode) {
  const runtimeConfig = {
    device: args.device || 'gpu',
    gpu_layers: args['gpu-layers'] || '999',
    ctx_size: args['ctx-size'] || '2048',
    batch_size: args['batch-size'] || '512',
    ubatch_size: args['ubatch-size'] || '512',
    n_predict: String(nPredict),
    temp: args.temp || '0',
    seed: args.seed || '42',
    'reasoning-budget': args['reasoning-budget'] || '0',
    verbosity: args.verbosity || '0'
  }

  if (args.threads) runtimeConfig.threads = args.threads
  if (args['cache-type-k']) runtimeConfig['cache-type-k'] = args['cache-type-k']
  if (args['cache-type-v']) runtimeConfig['cache-type-v'] = args['cache-type-v']
  if (args['flash-attn']) runtimeConfig['flash-attn'] = args['flash-attn']
  if (mode === 'mtp') {
    runtimeConfig['spec-type'] = 'draft-mtp'
    for (const key of [
      'spec-draft-n-max',
      'spec-draft-n-min',
      'spec-draft-p-min',
      'spec-draft-type-k',
      'spec-draft-type-v',
      'spec-draft-device',
      'spec-draft-ngl'
    ]) {
      if (args[key] != null && args[key] !== true) runtimeConfig[key] = args[key]
    }
    const noBackendSampling = parseOptionalBool(
      args['no-spec-draft-backend-sampling'],
      'no-spec-draft-backend-sampling'
    )
    const backendSampling = parseOptionalBool(
      args['spec-draft-backend-sampling'],
      'spec-draft-backend-sampling'
    )
    if (noBackendSampling) {
      runtimeConfig['no-spec-draft-backend-sampling'] = ''
    } else if (backendSampling) {
      runtimeConfig['spec-draft-backend-sampling'] = ''
    }
  }

  return buildConfigObject(runtimeConfig)
}

async function collectResponse(response) {
  const chunks = []
  const ticker = setInterval(() => {}, 50)
  let firstTokenMs = null
  const started = process.hrtime()

  try {
    await response
      .onUpdate((data) => {
        if (firstTokenMs == null) firstTokenMs = elapsedMs(started)
        chunks.push(data)
      })
      .await()
  } finally {
    clearInterval(ticker)
  }

  return {
    output: chunks.join('').trim(),
    firstTokenMs
  }
}

async function loadAddon({ Addon, modelPath, config, debug }) {
  const logger = createAddonRuntimeLogger(debug)
  const addon = new Addon({
    files: { model: [modelPath] },
    config,
    logger,
    opts: { stats: true }
  })

  const loadStart = process.hrtime()
  await addon.load()
  return {
    addon,
    loadMs: elapsedMs(loadStart)
  }
}

async function runInference(addon, messages) {
  const started = process.hrtime()
  const response = await addon.run(messages)
  const { output, firstTokenMs } = await collectResponse(response)
  const runMs = elapsedMs(started)
  const stats = response.stats || {}
  const generatedTokens = numberOrNull(stats.generatedTokens)
  const nativeTps = numberOrNull(stats.TPS)
  const wallTps =
    generatedTokens != null && generatedTokens > 0 ? generatedTokens / (runMs / 1000) : null

  return {
    runMs,
    outputChars: output.length,
    outputPreview: output.slice(0, 180),
    ttftMs: numberOrNull(stats.TTFT) ?? firstTokenMs,
    tps: wallTps,
    nativeTps,
    wallTps,
    ppTps: numberOrNull(stats.ppTPS),
    promptTokens: numberOrNull(stats.promptTokens),
    generatedTokens,
    draftAccepted: numberOrNull(stats.draftAccepted) ?? 0,
    draftTotal: numberOrNull(stats.draftTotal) ?? 0,
    rawStats: stats
  }
}

async function runMode({ Addon, modelPath, config, prompt, mode, repeats, warmups, debug }) {
  const { addon, loadMs } = await loadAddon({ Addon, modelPath, config, debug })
  const runs = []
  let unloadMs = null

  try {
    for (let i = 0; i < warmups; i++) {
      await runInference(addon, prompt.messages)
    }

    for (let i = 0; i < repeats; i++) {
      const result = await runInference(addon, prompt.messages)
      if (result.outputChars <= 0) throw new Error(`${mode} produced empty output`)
      if (!Number.isFinite(result.generatedTokens) || result.generatedTokens <= 0) {
        throw new Error(`${mode} generatedTokens missing or zero`)
      }
      if (mode === 'mtp' && result.draftTotal <= 0) {
        throw new Error('MTP run produced no draft tokens; verify the model has bundled MTP heads')
      }
      runs.push(result)
    }
  } finally {
    const unloadStart = process.hrtime()
    await addon.unload().catch(() => {})
    unloadMs = elapsedMs(unloadStart)
  }

  return {
    mode,
    loadMs,
    unloadMs,
    runs,
    summary: summarizeRuns(runs, loadMs, unloadMs)
  }
}

function finiteValues(runs, key) {
  return runs.map((run) => run[key]).filter((value) => Number.isFinite(value))
}

function summarizeMetric(runs, key, digits = 3) {
  const values = finiteValues(runs, key)
  return {
    mean: round(average(values), digits),
    stddev: round(stddev(values), digits),
    min: values.length ? round(Math.min(...values), digits) : null,
    max: values.length ? round(Math.max(...values), digits) : null
  }
}

function summarizeRuns(runs, loadMs, unloadMs) {
  const accepted = finiteValues(runs, 'draftAccepted').reduce((sum, value) => sum + value, 0)
  const total = finiteValues(runs, 'draftTotal').reduce((sum, value) => sum + value, 0)

  return {
    loadMs: round(loadMs, 3),
    unloadMs: round(unloadMs, 3),
    runMs: summarizeMetric(runs, 'runMs'),
    ttftMs: summarizeMetric(runs, 'ttftMs'),
    tps: summarizeMetric(runs, 'tps'),
    ppTps: summarizeMetric(runs, 'ppTps'),
    promptTokens: summarizeMetric(runs, 'promptTokens', 1),
    generatedTokens: summarizeMetric(runs, 'generatedTokens', 1),
    draftAccepted: summarizeMetric(runs, 'draftAccepted', 1),
    draftTotal: summarizeMetric(runs, 'draftTotal', 1),
    draftAcceptanceRate: safeRatio(accepted, total, 4),
    draftAcceptedTotal: round(accepted, 1),
    draftTotalTokens: round(total, 1)
  }
}

function compareScenario(baseline, mtp) {
  return {
    tpsSpeedup: safeRatio(mtp.summary.tps.mean, baseline.summary.tps.mean),
    wallSpeedup: safeRatio(baseline.summary.runMs.mean, mtp.summary.runMs.mean),
    ttftRatio: safeRatio(mtp.summary.ttftMs.mean, baseline.summary.ttftMs.mean),
    acceptanceRate: mtp.summary.draftAcceptanceRate
  }
}

function pad(value, width) {
  const s = String(value ?? '')
  return s.length >= width ? s : `${s}${' '.repeat(width - s.length)}`
}

function formatCell(value, digits = 2) {
  if (value == null) return ''
  if (typeof value === 'number') return String(round(value, digits))
  return String(value)
}

function printConsoleTable(scenarios) {
  const headers = [
    ['Prompt', 8],
    ['n_pred', 6],
    ['Base TPS', 9],
    ['MTP TPS', 8],
    ['TPS x', 6],
    ['Base ms', 8],
    ['MTP ms', 7],
    ['Wall x', 6],
    ['Accept', 7],
    ['Drafts', 14]
  ]
  console.log(headers.map(([name, width]) => pad(name, width)).join('  '))
  console.log(headers.map(([, width]) => '-'.repeat(width)).join('  '))

  for (const scenario of scenarios) {
    const baseline = scenario.results.baseline.summary
    const mtp = scenario.results.mtp.summary
    const comparison = scenario.comparison
    const row = [
      [scenario.promptCase, 8],
      [scenario.nPredict, 6],
      [formatCell(baseline.tps.mean), 9],
      [formatCell(mtp.tps.mean), 8],
      [formatCell(comparison.tpsSpeedup, 3), 6],
      [formatCell(baseline.runMs.mean), 8],
      [formatCell(mtp.runMs.mean), 7],
      [formatCell(comparison.wallSpeedup, 3), 6],
      [formatCell(comparison.acceptanceRate, 4), 7],
      [`${mtp.draftAcceptedTotal}/${mtp.draftTotalTokens}`, 14]
    ]
    console.log(row.map(([value, width]) => pad(value, width)).join('  '))
  }
}

function renderMarkdown(report) {
  const lines = []
  lines.push('# MTP Benchmark Report')
  lines.push('')
  lines.push(`- Started: ${report.startedAt}`)
  lines.push(`- Finished: ${report.finishedAt}`)
  lines.push(`- Model: ${report.modelPath}`)
  lines.push(`- Addon source: ${report.addonSource}`)
  lines.push(`- Repeats: ${report.repeats}`)
  lines.push(`- Warmups: ${report.warmups}`)
  lines.push('')
  lines.push(
    '| Prompt | n_predict | Baseline TPS | MTP TPS | TPS Speedup | Baseline ms | MTP ms | Wall Speedup | Acceptance | Drafts |'
  )
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|')
  for (const scenario of report.scenarios) {
    const baseline = scenario.results.baseline.summary
    const mtp = scenario.results.mtp.summary
    const comparison = scenario.comparison
    lines.push(
      `| ${scenario.promptCase} | ${scenario.nPredict}` +
        ` | ${baseline.tps.mean ?? ''} | ${mtp.tps.mean ?? ''}` +
        ` | ${comparison.tpsSpeedup ?? ''}` +
        ` | ${baseline.runMs.mean ?? ''} | ${mtp.runMs.mean ?? ''}` +
        ` | ${comparison.wallSpeedup ?? ''}` +
        ` | ${comparison.acceptanceRate ?? ''}` +
        ` | ${mtp.draftAcceptedTotal}/${mtp.draftTotalTokens} |`
    )
  }
  lines.push('')
  lines.push('## Notes')
  lines.push('')
  lines.push('- Load time is recorded, but speedup is calculated from generation run time only.')
  lines.push(
    '- MTP cases require `draftTotal > 0`; otherwise the benchmark fails fast because speculation is inert.'
  )
  lines.push('- Acceptance is `sum(draftAccepted) / sum(draftTotal)` across measured runs.')
  lines.push('')
  return `${lines.join('\n')}\n`
}

async function main() {
  const args = parseArgs(process.argv)
  if (args.help) {
    printHelp()
    return
  }

  const modelPath = path.resolve(String(args['model-path'] || DEFAULT_MODEL_PATH))
  if (!fs.existsSync(modelPath)) {
    throw new Error(`Model file not found: ${modelPath}`)
  }

  const addonSource = parseAddonSource(args['addon-source'] || 'local')
  const Addon = resolveAddonCtor(addonSource)
  const repeats = parsePositiveInt(args.repeats || '5', 'repeats')
  const warmups = Number(args.warmups || '1')
  if (!Number.isInteger(warmups) || warmups < 0) {
    throw new Error(`Invalid warmups: ${args.warmups}. Expected a non-negative integer.`)
  }

  const nPredictValues = parsePositiveIntList(args['n-predict'], [64, 256, 512], 'n-predict')
  const promptCases = parseCsvList(args['prompt-cases'], ['short', 'medium', 'long'])
  for (const promptCase of promptCases) {
    if (!PROMPTS[promptCase]) {
      throw new Error(
        `Unknown prompt case "${promptCase}". Expected one of: ${Object.keys(PROMPTS).join(', ')}`
      )
    }
  }

  const resultsDir = path.resolve(
    String(args['results-dir'] || path.join(__dirname, 'results/mtp'))
  )
  fs.mkdirSync(resultsDir, { recursive: true })

  const debug = parseOptionalBool(args.debug, 'debug')
  const startedAt = new Date().toISOString()
  const scenarios = []

  console.log(`MTP benchmark model: ${modelPath}`)
  console.log(
    `Cases: prompts=${promptCases.join(',')} n_predict=${nPredictValues.join(',')} repeats=${repeats} warmups=${warmups}`
  )

  for (const promptCase of promptCases) {
    for (const nPredict of nPredictValues) {
      const prompt = {
        id: promptCase,
        messages: PROMPTS[promptCase]
      }

      console.log(`\nRunning prompt=${promptCase} n_predict=${nPredict}`)
      const baseline = await runMode({
        Addon,
        modelPath,
        config: createRuntimeConfig(args, nPredict, 'baseline'),
        prompt,
        mode: 'baseline',
        repeats,
        warmups,
        debug
      })
      console.log(
        `  baseline TPS=${baseline.summary.tps.mean} runMs=${baseline.summary.runMs.mean}`
      )

      const mtp = await runMode({
        Addon,
        modelPath,
        config: createRuntimeConfig(args, nPredict, 'mtp'),
        prompt,
        mode: 'mtp',
        repeats,
        warmups,
        debug
      })
      console.log(
        `  mtp TPS=${mtp.summary.tps.mean} runMs=${mtp.summary.runMs.mean} acceptance=${mtp.summary.draftAcceptanceRate}`
      )

      scenarios.push({
        promptCase,
        nPredict,
        promptChars: prompt.messages.reduce(
          (sum, msg) => sum + String(msg.content || '').length,
          0
        ),
        runtimeConfig: {
          baseline: createRuntimeConfig(args, nPredict, 'baseline'),
          mtp: createRuntimeConfig(args, nPredict, 'mtp')
        },
        results: { baseline, mtp },
        comparison: compareScenario(baseline, mtp)
      })
    }
  }

  const report = {
    type: 'mtp-benchmark',
    startedAt,
    finishedAt: new Date().toISOString(),
    modelPath,
    addonSource,
    repeats,
    warmups,
    scenarios
  }

  const stamp = tsFileStamp()
  const jsonPath = path.join(resultsDir, `mtp-benchmark-${stamp}.json`)
  const mdPath = path.join(resultsDir, `mtp-benchmark-${stamp}.md`)
  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  fs.writeFileSync(mdPath, renderMarkdown(report), 'utf8')

  console.log('\nSummary')
  printConsoleTable(scenarios)
  console.log(`\nWrote JSON: ${jsonPath}`)
  console.log(`Wrote Markdown: ${mdPath}`)
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err)
  process.exit(1)
})
