'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const process = require('bare-process')
const FilesystemDL = require('@qvac/dl-filesystem')

function loadLocalEmbedAddon () {
  return require('../../index')
}

function loadNpmEmbedAddon () {
  return require('@qvac/embed-llamacpp')
}

function createDebugLogger (enabled) {
  return {
    log: (...msgs) => {
      if (enabled) console.log(...msgs)
    },
    warn: (...msgs) => {
      if (enabled) console.warn(...msgs)
    }
  }
}

function parseAddonSource (value) {
  const normalized = String(value || 'local').trim().toLowerCase()
  if (normalized === 'local' || normalized === 'npm') return normalized
  throw new Error(`Invalid --addon-source value "${value}". Expected "local" or "npm".`)
}

function resolveAddonCtor (addonSource) {
  try {
    return addonSource === 'npm' ? loadNpmEmbedAddon() : loadLocalEmbedAddon()
  } catch (error) {
    const message = error.message || String(error)
    throw new Error(
      `Failed to load addon source "${addonSource}": ${message}. ` +
      (addonSource === 'local'
        ? 'Run `npm run build` for local addon artifacts.'
        : 'Run `npm run performance:install` to install npm addon package.')
    )
  }
}

const {
  DEFAULT_RESULTS_DIR,
  DEFAULT_REPEATS,
  DEFAULT_INPUTS_FILE,
  MODELS,
  PARAMETER_SWEEP
} = require('./embed-parameter-sweep.config')

const INPUT_MODES = ['single', 'array']

function createAddonRuntimeLogger (debugEnabled) {
  if (!debugEnabled) {
    return {
      error: () => {},
      warn: () => {},
      info: () => {},
      debug: () => {}
    }
  }

  return {
    error: (...msgs) => console.error(...msgs),
    warn: (...msgs) => console.warn(...msgs),
    info: (...msgs) => console.log(...msgs),
    debug: (...msgs) => console.debug(...msgs)
  }
}

function parseArgs (argv) {
  const parsed = {}
  for (let i = 2; i < argv.length; i++) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[i + 1]
    if (!next || next.startsWith('--')) {
      parsed[key] = true
    } else {
      parsed[key] = next
      i++
    }
  }
  return parsed
}

function elapsedMs (hrStart) {
  const [sec, nano] = process.hrtime(hrStart)
  return sec * 1000 + nano / 1e6
}

function round (num, digits = 4) {
  const scale = Math.pow(10, digits)
  return Math.round(num * scale) / scale
}

function cosineSimilarity (a, b) {
  if (a.length !== b.length) {
    throw new Error(`Vector length mismatch: ${a.length} vs ${b.length}`)
  }
  let dotProduct = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB)
  if (denominator < 1e-12) return 1.0 * Math.sign(dotProduct)
  return dotProduct / denominator
}

function normalizeEmbeddings (rawEmbeddings) {
  if (!Array.isArray(rawEmbeddings) || !Array.isArray(rawEmbeddings[0])) {
    throw new Error('Invalid embedding response structure')
  }
  return rawEmbeddings[0].map((vector) => Array.from(vector))
}

function buildConfigString (runtimeConfig, options = {}) {
  const debugEnabled = !!options.debugEnabled
  const parts = ['verbosity\t0']
  if (runtimeConfig.device != null) parts.push(`-dev\t${runtimeConfig.device}`)
  if (runtimeConfig.batchSize != null) parts.push(`--batch-size\t${runtimeConfig.batchSize}`)
  if (runtimeConfig.flashAttn != null) parts.push(`-fa\t${runtimeConfig.flashAttn}`)
  if (runtimeConfig.ngl != null) parts.push(`-ngl\t${runtimeConfig.ngl}`)
  if (runtimeConfig.noMmap) parts.push('--no-mmap')
  if (!debugEnabled) {
    // Suppress native llama.cpp startup logs in benchmark mode.
    parts.push('--log-disable')
  }
  return parts.join('\n')
}

function resolveModelName (modelDef, quantization) {
  return modelDef.quantizationFiles[quantization] || null
}

function checkModelExists (modelDir, modelName) {
  return fs.existsSync(path.join(modelDir, modelName))
}

function similarityStats (baseline, candidate) {
  if (!baseline || !candidate) return null
  if (baseline.length !== candidate.length) return null
  const scores = []
  for (let i = 0; i < baseline.length; i++) {
    scores.push(cosineSimilarity(baseline[i], candidate[i]))
  }
  if (scores.length === 0) return null
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  let sum = 0
  for (const score of scores) {
    if (score < min) min = score
    if (score > max) max = score
    sum += score
  }
  return {
    avg: round(sum / scores.length, 6),
    min: round(min, 6),
    max: round(max, 6),
    count: scores.length
  }
}

function cartesianProduct (arrays) {
  return arrays.reduce(
    (acc, curr) => acc.flatMap((prefix) => curr.map((x) => [...prefix, x])),
    [[]]
  )
}

function buildCases (modelDef, sweep) {
  const baseQuant = modelDef.quantizations[0]
  const defaults = modelDef.defaults
  if (baseQuant == null) {
    throw new Error(`No baseline quantization configured for model "${modelDef.id}"`)
  }
  const supportedQuants = sweep.quantization
    .filter((quant) => !!resolveModelName(modelDef, quant))

  if (supportedQuants.length === 0) {
    throw new Error(`No supported quantizations found for model "${modelDef.id}"`)
  }

  const cases = []
  for (const inputMode of INPUT_MODES) {
    cases.push({
      caseId: `${modelDef.id}__q=${baseQuant}__baseline-defaults__input=${inputMode}`,
      parameter: 'baseline',
      quantization: baseQuant,
      modelName: resolveModelName(modelDef, baseQuant),
      runtimeConfig: { ...defaults },
      inputMode,
      isBaseline: true
    })
  }

  const combos = cartesianProduct([
    supportedQuants,
    sweep.device,
    sweep.batchSize,
    sweep.noMmap,
    sweep.flashAttn,
  ])

  for (const [quantization, device, batchSize, noMmap, flashAttn] of combos) {
    for (const inputMode of INPUT_MODES) {
      cases.push({
        caseId: `${modelDef.id}__q=${quantization}__dev=${device}__bs=${batchSize}__mmap=${noMmap ? 'off' : 'on'}__fa=${flashAttn}__input=${inputMode}`,
        parameter: 'full-grid',
        quantization,
        modelName: resolveModelName(modelDef, quantization),
        runtimeConfig: {
          ...defaults,
          device,
          batchSize,
          noMmap,
          flashAttn,
        },
        inputMode,
        isBaseline: false
      })
    }
  }

  cases.sort((a, b) => Number(b.isBaseline) - Number(a.isBaseline))
  return cases
}

function average (values) {
  if (!values.length) return null
  let sum = 0
  for (const value of values) sum += value
  return sum / values.length
}

function stddev (values) {
  if (values.length <= 1) return 0
  const avg = average(values)
  let varianceSum = 0
  for (const value of values) {
    const diff = value - avg
    varianceSum += diff * diff
  }
  return Math.sqrt(varianceSum / values.length)
}

function formatDurationMs (ms) {
  if (typeof ms !== 'number' || Number.isNaN(ms) || ms < 0) return '?:??:??'
  const totalSeconds = Math.round(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

function truncateText (text, maxLen) {
  const value = String(text ?? '')
  if (!Number.isInteger(maxLen) || maxLen <= 0) return ''
  if (value.length <= maxLen) return value
  if (maxLen <= 3) return value.slice(0, maxLen)
  return `${value.slice(0, maxLen - 3)}...`
}

function createProgressReporter (totalRuns) {
  const startTime = Date.now()
  let completedRuns = 0
  let lastNonTtyPercent = -1
  let lastRenderedLength = 0
  const canRewriteLine = !!(process.stdout && typeof process.stdout.write === 'function')
  const barWidth = 24

  function render (context) {
    const percent = totalRuns > 0 ? (completedRuns / totalRuns) * 100 : 100
    const elapsedMs = Date.now() - startTime
    const etaMs = completedRuns > 0
      ? (elapsedMs / completedRuns) * (totalRuns - completedRuns)
      : null

    const modelLabel = context && context.modelId ? truncateText(context.modelId, 24) : 'unknown'
    const caseLabel = context && typeof context.caseIndex === 'number' && typeof context.caseCount === 'number'
      ? `${context.caseIndex}/${context.caseCount}`
      : '?/?'
    const repeatLabel = context && typeof context.repeat === 'number' && typeof context.repeats === 'number'
      ? `${context.repeat}/${context.repeats}`
      : '?/?'
    const etaLabel = etaMs == null ? '--:--:--' : formatDurationMs(etaMs)

    if (!canRewriteLine) {
      const flooredPercent = Math.floor(percent)
      if (flooredPercent === lastNonTtyPercent && completedRuns !== totalRuns) return
      lastNonTtyPercent = flooredPercent
      console.log(
        `[progress] ${completedRuns}/${totalRuns} (${percent.toFixed(1)}%)` +
        ` | model=${modelLabel} case=${caseLabel} repeat=${repeatLabel} | eta=${etaLabel}`
      )
      return
    }

    const filled = Math.round((percent / 100) * barWidth)
    const bar = `${'#'.repeat(filled)}${'-'.repeat(Math.max(0, barWidth - filled))}`
    let line =
      `[progress] [${bar}] ${completedRuns}/${totalRuns} (${percent.toFixed(1)}%)` +
      ` | m=${modelLabel} c=${caseLabel} r=${repeatLabel} eta=${etaLabel}`
    const columns = process.stdout && Number.isInteger(process.stdout.columns) ? process.stdout.columns : null
    if (columns && columns > 0 && line.length >= columns) {
      line = truncateText(line, columns - 1)
    }
    const clearPadding = lastRenderedLength > line.length ? ' '.repeat(lastRenderedLength - line.length) : ''
    process.stdout.write(`\r${line}${clearPadding}`)
    lastRenderedLength = line.length
    if (completedRuns === totalRuns) {
      process.stdout.write('\n')
    }
  }

  return {
    tick (context) {
      completedRuns += 1
      render(context)
    },
    start () {
      render({})
    }
  }
}

function aggregateRunMetrics (runMetrics) {
  const loadMsValues = runMetrics.map((x) => x.loadMs)
  const runMsValues = runMetrics.map((x) => x.runMs)
  const unloadMsValues = runMetrics.map((x) => x.unloadMs)
  const tpsValues = runMetrics.map((x) => x.tps).filter((x) => x != null)

  return {
    repeats: runMetrics.length,
    loadMs: round(average(loadMsValues), 3),
    runMs: round(average(runMsValues), 3),
    unloadMs: round(average(unloadMsValues), 3),
    loadMsStd: round(stddev(loadMsValues), 3),
    runMsStd: round(stddev(runMsValues), 3),
    unloadMsStd: round(stddev(unloadMsValues), 3),
    tps: round(average(tpsValues), 3)
  }
}

async function runCaseOnce ({ addonCtor, addonSource, modelDir, modelName, runtimeConfig, inputs, debugEnabled }) {
  const loader = new FilesystemDL({ dirPath: modelDir })
  const configString = buildConfigString(runtimeConfig, { debugEnabled })
  const addonRuntimeLogger = createAddonRuntimeLogger(debugEnabled)

  let model = null
  let loadMs = null
  let runMs = null
  let unloadMs = null
  let embeddings = null
  let nativeTps = null
  let primaryError = null
  const cleanupErrors = []

  try {
    model = new addonCtor({
      modelName,
      loader,
      logger: addonRuntimeLogger,
      diskPath: modelDir,
      opts: { stats: true }
    }, configString)

    const loadStart = process.hrtime()
    await model.load()
    loadMs = elapsedMs(loadStart)

    const response = await model.run(inputs)
    const rawEmbeddings = await response.await()
    const runtimeStats = response.stats
    runMs = runtimeStats.total_time_ms
    embeddings = normalizeEmbeddings(rawEmbeddings)
    nativeTps = runtimeStats.tokens_per_second
  } catch (err) {
    primaryError = err
  } finally {
    try {
      if (model) {
        const unloadStart = process.hrtime()
        await model.unload()
        unloadMs = elapsedMs(unloadStart)
      }
    } catch (unloadError) {
      cleanupErrors.push(`unload_error=${unloadError && unloadError.message ? unloadError.message : String(unloadError)}`)
    }
    try {
      await loader.close()
    } catch (closeError) {
      cleanupErrors.push(`loader_close_error=${closeError && closeError.message ? closeError.message : String(closeError)}`)
    }
  }

  if (primaryError || cleanupErrors.length > 0) {
    const primary = primaryError ? (primaryError.message || String(primaryError)) : null
    const joined = [primary, ...cleanupErrors].filter(Boolean).join('; ')
    throw new Error(`Case failed: ${joined}`)
  }

  return {
    metrics: {
      loadMs: round(loadMs, 3),
      runMs: round(runMs, 3),
      unloadMs: round(unloadMs, 3),
      tps: round(nativeTps, 3)
    },
    embeddings
  }
}

async function runCase ({ addonCtor, addonSource, modelDir, modelName, runtimeConfig, inputs, repeats, onRepeatComplete, debugEnabled }) {
  const runMetrics = []
  let firstEmbeddings = null
  const errors = []

  for (let repeat = 1; repeat <= repeats; repeat++) {
    try {
      const result = await runCaseOnce({
        addonCtor,
        addonSource,
        modelDir,
        modelName,
        runtimeConfig,
        inputs,
        debugEnabled
      })
      runMetrics.push(result.metrics)
      if (!firstEmbeddings) {
        firstEmbeddings = result.embeddings
      }
    } catch (error) {
      const message = error.message || String(error)
      errors.push({
        repeat,
        message
      })
    } finally {
      if (typeof onRepeatComplete === 'function') {
        onRepeatComplete({ repeat, repeats })
      }
    }
  }

  return {
    metrics: aggregateRunMetrics(runMetrics),
    embeddings: firstEmbeddings,
    errors,
    repeatsAttempted: repeats,
    repeatsSucceeded: runMetrics.length
  }
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
  lines.push('# Embed Parameter Sweep Benchmark Report')
  lines.push('')
  lines.push(`- Started: ${report.startedAt}`)
  lines.push(`- Finished: ${report.finishedAt}`)
  lines.push(`- Repeats per case: ${report.repeats}`)
  lines.push(`- Sweep mode: full-grid`)
  lines.push('')
  for (const model of report.models) {
    lines.push(`## Model: ${model.modelId}`)
    lines.push('| Quantization | Device | Batch Size | Input | No Mmap | Flash Attn | Status | Load ms (avg) | Run ms (avg) | Unload ms (avg) | TPS (avg) | Avg CosSim | Error |')
    lines.push('|---|---|---:|---|---|---|---|---:|---:|---:|---:|---:|---|')
    for (const item of model.cases) {
      const metrics = item.metrics || {}
      const runtimeConfig = item.runtimeConfig
      const cos = item.similarity ? item.similarity.avg : ''
      const quantizationCell = item.isBaseline ? 'default' : item.quantization
      const deviceCell = item.isBaseline ? 'default' : String(runtimeConfig.device)
      const batchSizeCell = item.isBaseline ? 'default' : String(runtimeConfig.batchSize)
      const inputCell = item.inputMode || 'single'
      const noMmapCell = item.isBaseline
        ? 'default'
        : (runtimeConfig.noMmap ? 'on' : 'off')
      const flashAttnCell = item.isBaseline
        ? 'default'
        : String(runtimeConfig.flashAttn)
      const statusCell = item.status
      const errorCell = item.error ? truncateText(item.error.message, 120) : ''
      lines.push(
        `| ${quantizationCell} | ${deviceCell} | ${batchSizeCell} | ${inputCell} | ${noMmapCell} | ${flashAttnCell}` +
        ` | ${statusCell} | ${metrics.loadMs ?? ''}` +
        ` | ${metrics.runMs ?? ''}` +
        ` | ${metrics.unloadMs ?? ''}` +
        ` | ${metrics.tps ?? ''}` +
        ` | ${cos} | ${errorCell} |`
      )
    }
    lines.push('')
  }
  return `${lines.join('\n')}\n`
}

function toJsonLines (report) {
  const lines = []
  for (const model of report.models) {
    for (const item of model.cases) {
      lines.push(JSON.stringify({
        startedAt: report.startedAt,
        finishedAt: report.finishedAt,
        repeats: report.repeats,
        modelId: model.modelId,
        source: model.source,
        modelDir: model.modelDir,
        caseId: item.caseId,
        parameter: item.parameter,
        quantization: item.quantization,
        modelName: item.modelName,
        inputMode: item.inputMode,
        runtimeConfig: item.runtimeConfig,
        isBaseline: item.isBaseline,
        metrics: item.metrics,
        similarity: item.similarity,
        status: item.status,
        repeatsAttempted: item.repeatsAttempted,
        repeatsSucceeded: item.repeatsSucceeded,
        error: item.error
      }))
    }
  }
  return `${lines.join('\n')}\n`
}

async function main () {
  const args = parseArgs(process.argv)
  const debugEnabled = Boolean(args.debug)
  const debugLogger = createDebugLogger(debugEnabled)
  const addonSource = parseAddonSource(args['addon-source'])
  const addonCtor = resolveAddonCtor(addonSource)
  const repeats = args.repeats ? Number(args.repeats) : DEFAULT_REPEATS
  const resultsDir = args['results-dir'] ? path.resolve(args['results-dir']) : DEFAULT_RESULTS_DIR
  const inputsFilePath = args['inputs-file']
    ? path.resolve(args['inputs-file'])
    : DEFAULT_INPUTS_FILE
  if (!fs.existsSync(inputsFilePath)) {
    throw new Error(
      `Missing inputs file: ${inputsFilePath}. ` +
      'Provide --inputs-file <path> or place a JSON object { "<batchSize>": string[5], ... } at benchmarks/performance/inputs.json.'
    )
  }
  const inputsByBatchSize = JSON.parse(fs.readFileSync(inputsFilePath, 'utf8'))
  const selectedModelIds = args.models
    ? String(args.models).split(',').map((x) => x.trim()).filter(Boolean)
    : MODELS.map((m) => m.id)

  const selectedModels = MODELS.filter((m) => selectedModelIds.includes(m.id))
  if (selectedModels.length === 0) {
    throw new Error(`No matching models for --models=${selectedModelIds.join(',')}`)
  }

  fs.mkdirSync(resultsDir, { recursive: true })
  const report = {
    startedAt: new Date().toISOString(),
    finishedAt: null,
    repeats,
    selectedModelIds,
    models: []
  }

  const plannedRunsByModel = selectedModels.map((modelDef) => {
    const cases = buildCases(modelDef, PARAMETER_SWEEP)
    return { modelDef, cases }
  })
  const totalPlannedRuns = plannedRunsByModel.reduce((acc, item) => acc + (item.cases.length * repeats), 0)
  const progress = createProgressReporter(totalPlannedRuns)

  debugLogger.log(`Running full-grid parameter sweep for: ${selectedModels.map((m) => m.id).join(', ')}`)
  debugLogger.log(`Addon source: ${addonSource}`)
  debugLogger.log(`Repeats per case: ${repeats}`)
  debugLogger.log(`Total planned runs: ${totalPlannedRuns}`)
  progress.start()

  for (const plan of plannedRunsByModel) {
    const modelDef = plan.modelDef
    const cases = plan.cases
    debugLogger.log(`\n=== ${modelDef.id} ===`)
    debugLogger.log(`Cases to run: ${cases.length}`)
    const baselineEmbeddingsByInputMode = new Map()
    const caseResults = []

    for (let caseIndex = 0; caseIndex < cases.length; caseIndex++) {
      const testCase = cases[caseIndex]
      try {
        if (!testCase.modelName) {
          throw new Error(
            `Quantization "${testCase.quantization}" is not configured for model "${modelDef.id}" (case ${testCase.caseId})`
          )
        }
        if (!checkModelExists(modelDef.modelDir, testCase.modelName)) {
          throw new Error(
            `Missing model file for case ${testCase.caseId}: ${path.join(modelDef.modelDir, testCase.modelName)}. ` +
            'Run model preparation first (npm run performance:prepare-models).'
          )
        }

        debugLogger.log(`Running: ${testCase.caseId}`)
        const inputsRaw = inputsByBatchSize[testCase.runtimeConfig.batchSize]
        const inputs = testCase.inputMode === 'single' ? inputsRaw[0] : inputsRaw
        const result = await runCase({
          addonCtor,
          addonSource,
          modelDir: modelDef.modelDir,
          modelName: testCase.modelName,
          runtimeConfig: testCase.runtimeConfig,
          inputs,
          repeats,
          debugEnabled,
          onRepeatComplete: ({ repeat, repeats: repeatsForCase }) => {
            progress.tick({
              modelId: modelDef.id,
              caseIndex: caseIndex + 1,
              caseCount: cases.length,
              repeat,
              repeats: repeatsForCase
            })
          }
        })

        if (testCase.parameter === 'baseline' && result.embeddings) {
          baselineEmbeddingsByInputMode.set(testCase.inputMode, result.embeddings)
        }

        const similarity = testCase.parameter === 'baseline'
          ? (
              result.embeddings
                ? { avg: 1, min: 1, max: 1, count: result.embeddings.length }
                : null
            )
          : similarityStats(
              baselineEmbeddingsByInputMode.get(testCase.inputMode),
              result.embeddings
            )

        const hasRepeatErrors = Array.isArray(result.errors) && result.errors.length > 0
        const status = hasRepeatErrors
          ? (result.repeatsSucceeded > 0 ? 'partial-failure' : 'failed')
          : 'ok'
        const error = hasRepeatErrors
          ? (() => {
              const uniqueMessages = [...new Set(result.errors.map((entry) => entry.message))]
              const detail = uniqueMessages.length === 1
                ? uniqueMessages[0]
                : `${uniqueMessages.length} distinct errors (first: ${uniqueMessages[0]})`
              return {
                message: `${result.errors.length}/${result.repeatsAttempted} repeats failed: ${detail}`,
                repeats: result.errors
              }
            })()
          : null

        caseResults.push({
          ...testCase,
          metrics: result.metrics,
          similarity,
          status,
          repeatsAttempted: result.repeatsAttempted,
          repeatsSucceeded: result.repeatsSucceeded,
          error
        })
      } catch (error) {
      const message = error.message || String(error)
        debugLogger.warn(`Case failed: ${testCase.caseId}: ${message}`)
        for (let repeat = 1; repeat <= repeats; repeat++) {
          progress.tick({
            modelId: modelDef.id,
            caseIndex: caseIndex + 1,
            caseCount: cases.length,
            repeat,
            repeats
          })
        }
        caseResults.push({
          ...testCase,
          metrics: null,
          similarity: null,
          status: 'failed',
          repeatsAttempted: repeats,
          repeatsSucceeded: 0,
          error: {
            message
          }
        })
      }
    }

    report.models.push({
      modelId: modelDef.id,
      source: modelDef.source,
      modelDir: modelDef.modelDir,
      cases: caseResults
    })
  }

  report.finishedAt = new Date().toISOString()
  const stamp = tsFileStamp()
  const jsonlPath = path.join(resultsDir, `embed-parameter-sweep-${stamp}.jsonl`)
  const mdPath = path.join(resultsDir, `embed-parameter-sweep-${stamp}.md`)
  fs.writeFileSync(jsonlPath, toJsonLines(report))
  fs.writeFileSync(mdPath, toMarkdown(report))
  debugLogger.log('\nDone.')
}

main().catch((error) => {
  console.error('Parameter sweep failed:')
  console.error(error.stack || String(error))
  process.exit(1)
})
