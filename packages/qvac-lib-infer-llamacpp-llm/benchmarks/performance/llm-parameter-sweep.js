'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const process = require('bare-process')
const FilesystemDL = require('@qvac/dl-filesystem')

function loadLocalLlmAddon () {
  return require('../../index')
}

function loadNpmLlmAddon () {
  return require('@qvac/llm-llamacpp')
}

function createDebugLogger (enabled) {
  return {
    log: (...msgs) => {
      if (enabled) console.log(...msgs)
    },
    warn: (...msgs) => {
      if (enabled) console.warn(...msgs)
    },
    error: (...msgs) => {
      if (enabled) console.error(...msgs)
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
    return addonSource === 'npm' ? loadNpmLlmAddon() : loadLocalLlmAddon()
  } catch (error) {
    const message = error && error.message ? error.message : String(error)
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
  DEFAULT_PROMPTS_FILE,
  MODELS,
  PARAMETER_SWEEP
} = require('./llm-parameter-sweep.config')

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

function ensureDir (dirPath) {
  fs.mkdirSync(dirPath, { recursive: true })
}

function elapsedMs (hrStart) {
  const [sec, nano] = process.hrtime(hrStart)
  return sec * 1000 + nano / 1e6
}

function round (num, digits = 4) {
  if (typeof num !== 'number' || Number.isNaN(num)) return null
  const scale = Math.pow(10, digits)
  return Math.round(num * scale) / scale
}

function parsePositiveInt (value, name) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${name}: ${value}. Expected a positive integer.`)
  }
  return parsed
}

function exactMatch (baseline, candidate) {
  if (!baseline || !candidate) return null
  return baseline === candidate ? 1.0 : 0.0
}

function memorySnapshot () {
  if (typeof process.memoryUsage !== 'function') {
    return { rssMb: null, heapUsedMb: null, externalMb: null }
  }
  const mem = process.memoryUsage()
  return {
    rssMb: round(mem.rss / (1024 * 1024), 2),
    heapUsedMb: round(mem.heapUsed / (1024 * 1024), 2),
    externalMb: round(mem.external / (1024 * 1024), 2)
  }
}

function buildConfigObject (runtimeConfig) {
  // Convert runtime config to LLM addon config format (kebab-case keys, string values)
  const config = {}
  for (const [key, value] of Object.entries(runtimeConfig)) {
    if (value === null || value === undefined) {
      continue
    }
    // Handle boolean flags: no-mmap, no-kv-offload (true = include flag, false = omit)
    if (key === 'no-mmap' || key === 'no-kv-offload') {
      if (value === true) {
        config[key] = ''
      }
      // If false, don't include it (defaults to disabled/offload enabled)
    } else if (key === 'flash-attn') {
      // flash-attn: 'on' = include flag, 'off'/'auto' = omit (use default)
      if (value === 'on' || value === true) {
        config[key] = ''
      }
      // If 'off' or other values, don't include it (defaults to auto/off)
    } else {
      // All other values: stringify
      config[key] = String(value)
    }
  }
  return config
}

function resolveModelName (modelDef, quantization) {
  return modelDef.quantizationFiles[quantization] || null
}

function checkModelExists (modelDir, modelName) {
  return fs.existsSync(path.join(modelDir, modelName))
}

function cartesianProduct (arrays) {
  return arrays.reduce(
    (acc, curr) => acc.flatMap((prefix) => curr.map((x) => [...prefix, x])),
    [[]]
  )
}

function uniqueValuesWithDefault (values, defaultValue) {
  const out = []
  const seen = new Set()
  for (const value of [defaultValue, ...(values || [])]) {
    const key = typeof value === 'string' ? `s:${value}` : `j:${JSON.stringify(value)}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(value)
  }
  return out
}

function buildCases (modelDef, sweep) {
  const baseQuant = modelDef.defaultQuantization
  const defaults = modelDef.defaults || {}
  const supportedQuants = uniqueValuesWithDefault(sweep.quantization, baseQuant)
    .filter((quant) => !!resolveModelName(modelDef, quant))

  if (supportedQuants.length === 0) {
    throw new Error(`No supported quantizations found for model "${modelDef.id}"`)
  }

  const devices = uniqueValuesWithDefault(sweep.device, defaults.device)
  const ctxSizes = uniqueValuesWithDefault(sweep['ctx-size'], defaults['ctx-size'])
  const batchSizes = uniqueValuesWithDefault(sweep['batch-size'], defaults['batch-size'])
  const ubatchSizes = uniqueValuesWithDefault(sweep['ubatch-size'], defaults['ubatch-size'])
  const noMmapValues = uniqueValuesWithDefault(sweep['no-mmap'], defaults['no-mmap'] ?? false)
  const flashAttnValues = uniqueValuesWithDefault(sweep['flash-attn'], defaults['flash-attn'] ?? 'off')
  const noKvOffloadValues = uniqueValuesWithDefault(sweep['no-kv-offload'], defaults['no-kv-offload'] ?? false)
  const threadsValues = uniqueValuesWithDefault(sweep.threads, defaults.threads)
  const cacheTypeKValues = uniqueValuesWithDefault(sweep['cache-type-k'], defaults['cache-type-k'])
  const cacheTypeVValues = uniqueValuesWithDefault(sweep['cache-type-v'], defaults['cache-type-v'])

  const cases = []
  cases.push({
    caseId: `${modelDef.id}__q=${baseQuant}__baseline-defaults`,
    parameter: 'baseline',
    value: 'default',
    quantization: baseQuant,
    modelName: resolveModelName(modelDef, baseQuant),
    runtimeConfig: { ...defaults },
    isBaseline: true
  })

  if (devices.length > 0 && ctxSizes.length > 0 && batchSizes.length > 0 && ubatchSizes.length > 0 &&
      noMmapValues.length > 0 && flashAttnValues.length > 0 && noKvOffloadValues.length > 0 &&
      threadsValues.length > 0 && cacheTypeKValues.length > 0 && cacheTypeVValues.length > 0) {
    const combos = cartesianProduct([
      supportedQuants,
      devices,
      ctxSizes,
      batchSizes,
      ubatchSizes,
      noMmapValues,
      flashAttnValues,
      noKvOffloadValues,
      threadsValues,
      cacheTypeKValues,
      cacheTypeVValues
    ])

    for (const [quantization, device, ctxSize, batchSize, ubatchSize, noMmap, flashAttn, noKvOffload, threads, cacheTypeK, cacheTypeV] of combos) {
      const runtimeConfig = {
        ...defaults,
        device,
        'ctx-size': ctxSize,
        'batch-size': batchSize,
        'ubatch-size': ubatchSize,
        'no-mmap': noMmap,
        'flash-attn': flashAttn,
        'no-kv-offload': noKvOffload,
        threads,
        'cache-type-k': cacheTypeK,
        'cache-type-v': cacheTypeV
      }

      const caseId = `${modelDef.id}__q=${quantization}__dev=${device}__ctx=${ctxSize}__bs=${batchSize}__ubs=${ubatchSize}__mmap=${noMmap ? 'off' : 'on'}__fa=${flashAttn}__kvo=${noKvOffload ? 'off' : 'on'}__t=${threads}__ck=${cacheTypeK}__cv=${cacheTypeV}`

      cases.push({
        caseId,
        parameter: 'full-grid',
        value: 'combination',
        quantization,
        modelName: resolveModelName(modelDef, quantization),
        runtimeConfig,
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

function estimateTokenCount (text) {
  const value = String(text ?? '').trim()
  if (!value) return 0
  return value.split(/\s+/).length
}

function estimateMessagesTokenCount (messages) {
  if (!Array.isArray(messages)) return 0
  let total = 0
  for (const msg of messages) {
    total += estimateTokenCount(msg && msg.content ? msg.content : '')
  }
  return total
}

function expandUserMessageToTargetTokens (prompt, targetTokens) {
  if (!prompt || !Array.isArray(prompt.messages) || !Number.isFinite(targetTokens) || targetTokens <= 0) {
    return prompt
  }

  const cloned = {
    ...prompt,
    messages: prompt.messages.map((m) => ({ ...m }))
  }

  let userIndex = -1
  for (let i = cloned.messages.length - 1; i >= 0; i--) {
    if (cloned.messages[i] && cloned.messages[i].role === 'user') {
      userIndex = i
      break
    }
  }
  if (userIndex === -1) return cloned

  let currentTotal = estimateMessagesTokenCount(cloned.messages)
  if (currentTotal >= targetTokens) return cloned

  const fillerUnit = ' Continue with concrete details, examples, trade-offs, and constraints.'
  while (currentTotal < targetTokens) {
    cloned.messages[userIndex].content += fillerUnit
    currentTotal += estimateTokenCount(fillerUnit)
  }
  return cloned
}

function isAdaptivePromptId (promptId) {
  return promptId === 'ctx-filling' || promptId === 'batch-spanning'
}

function buildPromptForRuntimeConfig (prompt, runtimeConfig) {
  if (!prompt || !runtimeConfig) return prompt

  if (prompt.id === 'ctx-filling') {
    const ctxSize = Number(runtimeConfig['ctx-size'])
    if (Number.isFinite(ctxSize) && ctxSize > 256) {
      const targetTokens = Math.max(256, ctxSize - 128)
      return expandUserMessageToTargetTokens(prompt, targetTokens)
    }
  }

  if (prompt.id === 'batch-spanning') {
    const batchSize = Number(runtimeConfig['batch-size'])
    if (Number.isFinite(batchSize) && batchSize > 0) {
      const targetTokens = Math.max(512, batchSize * 3)
      return expandUserMessageToTargetTokens(prompt, targetTokens)
    }
  }

  return prompt
}

function getAdaptiveBaselineKey (promptId, runtimeConfig) {
  if (promptId === 'ctx-filling') {
    return `ctx-filling:${String(runtimeConfig['ctx-size'])}`
  }
  if (promptId === 'batch-spanning') {
    return `batch-spanning:${String(runtimeConfig['batch-size'])}`
  }
  return null
}

function validatePromptObject (prompt, contextLabel) {
  if (!prompt || typeof prompt !== 'object') {
    throw new Error(`${contextLabel} must be an object`)
  }
  if (typeof prompt.id !== 'string' || !prompt.id.trim()) {
    throw new Error(`${contextLabel} must have a non-empty string 'id'`)
  }
  if (!Array.isArray(prompt.messages)) {
    throw new Error(`${contextLabel} must have a 'messages' array`)
  }
  for (let j = 0; j < prompt.messages.length; j++) {
    const msg = prompt.messages[j]
    if (!msg || typeof msg !== 'object') {
      throw new Error(`${contextLabel} message at index ${j} must be an object`)
    }
    if (typeof msg.role !== 'string' || !msg.role.trim()) {
      throw new Error(`${contextLabel} message at index ${j} must have a non-empty string 'role'`)
    }
    if (typeof msg.content !== 'string') {
      throw new Error(`${contextLabel} message at index ${j} must have a string 'content'`)
    }
  }
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
  const ttftMsValues = runMetrics.map((x) => x.ttftMs).filter((x) => x != null)
  const tpsValues = runMetrics.map((x) => x.tps).filter((x) => x != null)
  const promptTokensValues = runMetrics.map((x) => x.promptTokens).filter((x) => x != null)
  const generatedTokensValues = runMetrics.map((x) => x.generatedTokens).filter((x) => x != null)
  const rssValues = runMetrics.map((x) => x?.runtimeMemory?.rssMb).filter((x) => x != null)
  const heapValues = runMetrics.map((x) => x?.runtimeMemory?.heapUsedMb).filter((x) => x != null)
  const extValues = runMetrics.map((x) => x?.runtimeMemory?.externalMb).filter((x) => x != null)

  return {
    repeats: runMetrics.length,
    loadMs: round(average(loadMsValues), 3),
    runMs: round(average(runMsValues), 3),
    unloadMs: round(average(unloadMsValues), 3),
    loadMsStd: round(stddev(loadMsValues), 3),
    runMsStd: round(stddev(runMsValues), 3),
    unloadMsStd: round(stddev(unloadMsValues), 3),
    ttftMs: round(average(ttftMsValues), 3),
    ttftMsStd: round(stddev(ttftMsValues), 3),
    tps: round(average(tpsValues), 3),
    tpsStd: round(stddev(tpsValues), 3),
    promptTokens: round(average(promptTokensValues), 0),
    generatedTokens: round(average(generatedTokensValues), 0),
    runtimeMemory: {
      rssMb: round(average(rssValues), 2),
      heapUsedMb: round(average(heapValues), 2),
      externalMb: round(average(extValues), 2)
    }
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
  lines.push('# LLM Parameter Sweep Benchmark Report')
  lines.push('')
  lines.push(`- Started: ${report.startedAt}`)
  lines.push(`- Finished: ${report.finishedAt}`)
  lines.push(`- Repeats per case: ${report.repeats}`)
  lines.push('- Sweep mode: full-grid')
  lines.push(`- Prompts: ${report.promptsCount}`)
  lines.push('')
  lines.push('> Runtime memory currently reports process-level JS memory only.')
  lines.push('')
  for (const model of report.models) {
    lines.push(`## Model: ${model.modelId}`)
    lines.push('| Quantization | Device | Ctx Size | Batch Size | Ubatch Size | No Mmap | Flash Attn | Threads | Cache K | Cache V | Load ms (avg) | TTFT ms (avg) | TPS (avg) | Unload ms (avg) | Memory RSS MB (avg) | Quality Match |')
    lines.push('|---|---|---:|---:|---:|---|---|---:|---|---|---:|---:|---:|---:|---:|---:|')
    for (const item of model.cases) {
      const quality = item.qualityMatch != null ? item.qualityMatch.toFixed(3) : ''
      const quantizationCell = item.isBaseline ? 'default' : (item.quantization ?? '')
      const deviceCell = item.isBaseline ? 'default' : (item.runtimeConfig && item.runtimeConfig.device != null ? String(item.runtimeConfig.device) : '')
      const ctxSizeCell = item.isBaseline ? 'default' : (item.runtimeConfig && item.runtimeConfig['ctx-size'] != null ? String(item.runtimeConfig['ctx-size']) : '')
      const batchSizeCell = item.isBaseline ? 'default' : (item.runtimeConfig && item.runtimeConfig['batch-size'] != null ? String(item.runtimeConfig['batch-size']) : '')
      const ubatchSizeCell = item.isBaseline ? 'default' : (item.runtimeConfig && item.runtimeConfig['ubatch-size'] != null ? String(item.runtimeConfig['ubatch-size']) : '')
      const noMmapCell = item.isBaseline
        ? 'default'
        : (item.runtimeConfig && item.runtimeConfig['no-mmap'] != null
            ? (item.runtimeConfig['no-mmap'] === '' ? 'on' : 'off')
            : '')
      const flashAttnCell = item.isBaseline
        ? 'default'
        : (item.runtimeConfig && item.runtimeConfig['flash-attn'] != null
            ? (item.runtimeConfig['flash-attn'] === '' ? 'on' : 'off')
            : '')
      const threadsCell = item.isBaseline ? 'default' : (item.runtimeConfig && item.runtimeConfig.threads != null ? String(item.runtimeConfig.threads) : '')
      const cacheKCell = item.isBaseline ? 'default' : (item.runtimeConfig && item.runtimeConfig['cache-type-k'] != null ? String(item.runtimeConfig['cache-type-k']) : '')
      const cacheVCell = item.isBaseline ? 'default' : (item.runtimeConfig && item.runtimeConfig['cache-type-v'] != null ? String(item.runtimeConfig['cache-type-v']) : '')
      const memoryRssMb = item.metrics && item.metrics.runtimeMemory
        ? item.metrics.runtimeMemory.rssMb
        : ''
      lines.push(
        `| ${quantizationCell} | ${deviceCell} | ${ctxSizeCell} | ${batchSizeCell} | ${ubatchSizeCell} | ${noMmapCell} | ${flashAttnCell} | ${threadsCell} | ${cacheKCell} | ${cacheVCell}` +
        ` | ${item.metrics.loadMs ?? ''} | ${item.metrics.ttftMs ?? ''} | ${item.metrics.tps ?? ''} | ${item.metrics.unloadMs ?? ''}` +
        ` | ${memoryRssMb ?? ''} | ${quality} |`
      )
    }
    lines.push('')
  }
  return `${lines.join('\n')}\n`
}

function loadPromptsFromFile (filePath) {
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  if (!Array.isArray(parsed)) {
    throw new Error(`Invalid prompts JSON at ${filePath}; expected array`)
  }
  for (let i = 0; i < parsed.length; i++) {
    validatePromptObject(parsed[i], `Prompt at index ${i}`)
  }
  return parsed
}

async function main () {
  const args = parseArgs(process.argv)
  const debugEnabled = Boolean(args.debug)
  const debugLogger = createDebugLogger(debugEnabled)
  const addonSource = parseAddonSource(args['addon-source'])
  const AddonCtor = resolveAddonCtor(addonSource)
  const repeats = args.repeats ? parsePositiveInt(args.repeats, 'repeats') : DEFAULT_REPEATS
  const resultsDir = args['results-dir'] ? path.resolve(args['results-dir']) : DEFAULT_RESULTS_DIR
  const promptsFilePath = args['prompts-file']
    ? path.resolve(args['prompts-file'])
    : DEFAULT_PROMPTS_FILE
  if (!fs.existsSync(promptsFilePath)) {
    throw new Error(
      `Missing prompts file: ${promptsFilePath}. ` +
      'Run `npm run prepare:prompts` to generate test prompts, or pass --prompts-file <path>.'
    )
  }
  const prompts = loadPromptsFromFile(promptsFilePath)
  const selectedModelIds = args.models
    ? String(args.models).split(',').map((x) => x.trim()).filter(Boolean)
    : MODELS.map((m) => m.id)

  const selectedModels = MODELS.filter((m) => selectedModelIds.includes(m.id))
  if (selectedModels.length === 0) {
    throw new Error(`No matching models for --models=${selectedModelIds.join(',')}`)
  }

  ensureDir(resultsDir)

  const progressFile = path.join(resultsDir, 'llm-parameter-sweep.progress.json')
  let completedRuns = new Set()
  try {
    const progressData = JSON.parse(fs.readFileSync(progressFile, 'utf8'))
    completedRuns = new Set(progressData.completedRuns || [])
    debugLogger.log(`Resuming: ${completedRuns.size} runs already completed`)
  } catch {
    // No progress file, start fresh
  }

  let saveProgressTimeout = null
  const saveProgress = () => {
    if (saveProgressTimeout) {
      clearTimeout(saveProgressTimeout)
    }
    saveProgressTimeout = setTimeout(() => {
      try {
        fs.writeFileSync(progressFile, JSON.stringify({ completedRuns: Array.from(completedRuns) }, null, 2))
      } catch (writeError) {
        if (debugEnabled) {
          debugLogger.warn(`Failed to save progress: ${writeError.message || String(writeError)}`)
        }
      }
      saveProgressTimeout = null
    }, 1000)
  }

  const flushProgress = () => {
    if (saveProgressTimeout) {
      clearTimeout(saveProgressTimeout)
      saveProgressTimeout = null
    }
    try {
      fs.writeFileSync(progressFile, JSON.stringify({ completedRuns: Array.from(completedRuns) }, null, 2))
    } catch (writeError) {
      if (debugEnabled) {
        debugLogger.warn(`Failed to flush progress: ${writeError.message || String(writeError)}`)
      }
    }
  }

  moduleFlushProgress = flushProgress

  const report = {
    startedAt: new Date().toISOString(),
    finishedAt: null,
    repeats,
    promptsCount: prompts.length,
    selectedModelIds,
    models: []
  }

  const plannedRunsByModel = selectedModels.map((modelDef) => {
    const cases = buildCases(modelDef, PARAMETER_SWEEP)
    return { modelDef, cases }
  })
  const totalPlannedRuns = plannedRunsByModel.reduce((acc, item) => acc + (item.cases.length * prompts.length * repeats), 0)
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
    const baselineOutputs = {}
    const adaptiveBaselineOutputs = {}
    const caseResults = []

    for (let caseIndex = 0; caseIndex < cases.length; caseIndex++) {
      // Wrap each case in try-catch to prevent one case from crashing the entire benchmark
      const testCase = cases[caseIndex]
      let loader = null
      let model = null
      let modelLoaded = false
      try {
        if (!testCase.modelName) {
          throw new Error(
          `Quantization "${testCase.quantization}" is not configured for model "${modelDef.id}" (case ${testCase.caseId})`
          )
        }
        if (!checkModelExists(modelDef.modelDir, testCase.modelName)) {
          throw new Error(
          `Missing model file for case ${testCase.caseId}: ${path.join(modelDef.modelDir, testCase.modelName)}. ` +
          'Run model preparation first (npm run prepare:models:addon).'
          )
        }

        debugLogger.log(`Running: ${testCase.caseId}`)

        loader = new FilesystemDL({ dirPath: modelDef.modelDir })
        const config = buildConfigObject(testCase.runtimeConfig)
        const addonRuntimeLogger = createAddonRuntimeLogger(debugEnabled)

        // Load model once for this case
        model = new AddonCtor({
          modelName: testCase.modelName,
          loader,
          logger: addonRuntimeLogger,
          diskPath: modelDef.modelDir,
          opts: { stats: true }
        }, config)

        const loadStart = process.hrtime()
        let loadMs = null
        try {
          await model.load()
          loadMs = elapsedMs(loadStart)
          modelLoaded = true
          debugLogger.log(`Model loaded for case ${testCase.caseId} in ${loadMs.toFixed(1)}ms`)
        } catch (loadError) {
          const errorMsg = loadError && loadError.message ? loadError.message : String(loadError)
          if (errorMsg.includes('VRAM') || errorMsg.includes('gpu-layers') || errorMsg.includes('failed to create context') || errorMsg.includes('UnableToLoadModel')) {
            // VRAM error - mark all prompts as failed and skip this case
            const promptResults = prompts.map(p => ({
              promptId: p.id,
              metrics: null,
              output: null,
              qualityMatch: null,
              error: `VRAM_ERROR: ${errorMsg}`,
              errorStack: loadError && loadError.stack ? loadError.stack : null,
              vramError: true
            }))
            for (const p of prompts) {
              for (let r = 1; r <= repeats; r++) {
                const runKey = `${modelDef.id}:${testCase.caseId}:${p.id}:${r}`
                completedRuns.add(runKey)
              }
            }
            saveProgress()
            caseResults.push({
              ...testCase,
              metrics: null,
              qualityMatch: null,
              hasErrors: true,
              promptResults
            })
            // Clean up loader before continuing
            try {
              await loader.close().catch(() => {})
            } catch {
              // Ignore cleanup errors
            }
            continue // Skip to next case
          }
          throw loadError
        }

        const promptResults = []

        for (let promptIndex = 0; promptIndex < prompts.length; promptIndex++) {
          const prompt = prompts[promptIndex]
          const effectivePrompt = buildPromptForRuntimeConfig(prompt, testCase.runtimeConfig)

          // Run repeats for this prompt
          const runMetrics = []
          let firstOutput = null
          let promptError = null

          for (let repeat = 1; repeat <= repeats; repeat++) {
            // Create unique run identifier for progress tracking
            const runKey = `${modelDef.id}:${testCase.caseId}:${prompt.id}:${repeat}`

            // Skip if already completed successfully
            if (completedRuns.has(runKey)) {
              debugLogger.log(`Skipping already completed: ${runKey}`)
              // Note: We can't load the actual metrics/output without a results file
              // So we'll just skip this repeat and continue
              continue
            }

            try {
              const runStart = process.hrtime()
              let timeToFirstToken = null
              const chunks = []
              const response = await model.run(effectivePrompt.messages)
              await response.onUpdate((data) => {
                if (timeToFirstToken === null) {
                  timeToFirstToken = elapsedMs(runStart)
                }
                chunks.push(data)
              }).await()
              const runMs = elapsedMs(runStart)
              const outputText = chunks.join('')
              const stats = response.stats || {}
              const ttftMs = stats.TTFT ?? timeToFirstToken

              const runS = runMs ? runMs / 1000 : null
              const metrics = {
                loadMs: null, // Model already loaded
                runMs: round(runMs, 3),
                unloadMs: null, // Will unload after all prompts
                ttftMs: round(ttftMs, 3),
                tps: round(runS && stats.TPS ? stats.TPS : null, 3),
                promptTokens: stats.promptTokens ?? null,
                generatedTokens: stats.generatedTokens ?? null,
                runtimeMemory: memorySnapshot()
              }

              runMetrics.push(metrics)
              if (!firstOutput) {
                firstOutput = outputText
              }

              progress.tick({
                modelId: modelDef.id,
                caseIndex: caseIndex + 1,
                caseCount: cases.length,
                promptIndex: promptIndex + 1,
                promptCount: prompts.length,
                repeat,
                repeats
              })

              // Mark as completed
              completedRuns.add(runKey)
              saveProgress()

              // Add small delay between repeats (model stays loaded)
              if (repeat < repeats) {
                await new Promise(resolve => setTimeout(resolve, 50))
              }
            } catch (error) {
              promptError = error
              const errorMsg = error && error.message ? error.message : String(error)
              debugLogger.warn(`Case failed for prompt ${prompt.id} repeat ${repeat}: ${errorMsg}`)

              const isContextOverflow = errorMsg && /context|ctx[- ]?size|overflow/i.test(errorMsg)
              if (isContextOverflow) {
                await new Promise(resolve => setTimeout(resolve, 15000))
              }

              // Check if it's a VRAM error - mark as completed (won't work with this config)
              const isVramError = errorMsg.includes('VRAM_ERROR') || errorMsg.includes('VRAM') || errorMsg.includes('gpu-layers') || errorMsg.includes('failed to create context') || errorMsg.includes('UnableToLoadModel')

              // For VRAM errors, mark all remaining repeats as completed (won't work with this config)
              if (isVramError) {
                for (let r = repeat; r <= repeats; r++) {
                  const rk = `${modelDef.id}:${testCase.caseId}:${prompt.id}:${r}`
                  completedRuns.add(rk)
                }
                saveProgress()
              }

              // Break out of repeat loop on error (can't continue with this prompt)
              break
            }
          }

          // Aggregate metrics across repeats (if any succeeded)
          if (runMetrics.length > 0) {
            const aggregated = aggregateRunMetrics(runMetrics)
            // Store load/unload times from first successful run (they're per-case, not per-repeat)
            aggregated.loadMs = null // Will be set after unload
            aggregated.unloadMs = null // Will be set after unload

            if (testCase.parameter === 'baseline') {
              baselineOutputs[prompt.id] = firstOutput
            }

            let qualityMatch = null
            if (isAdaptivePromptId(prompt.id)) {
              const adaptiveKey = getAdaptiveBaselineKey(prompt.id, testCase.runtimeConfig)
              if (adaptiveKey) {
                if (!Object.prototype.hasOwnProperty.call(adaptiveBaselineOutputs, adaptiveKey)) {
                  adaptiveBaselineOutputs[adaptiveKey] = firstOutput
                  qualityMatch = 1.0
                } else {
                  qualityMatch = exactMatch(adaptiveBaselineOutputs[adaptiveKey], firstOutput)
                }
              }
            } else {
              if (testCase.parameter === 'baseline') {
                qualityMatch = 1.0
              } else {
                qualityMatch = baselineOutputs[prompt.id]
                  ? exactMatch(baselineOutputs[prompt.id], firstOutput)
                  : null
              }
            }

            promptResults.push({
              promptId: prompt.id,
              metrics: aggregated,
              output: firstOutput,
              qualityMatch
            })
          } else if (promptError) {
            // All repeats failed
            const errorMsg = promptError && promptError.message ? promptError.message : String(promptError)
            const isVramError = errorMsg.includes('VRAM_ERROR') || errorMsg.includes('VRAM') || errorMsg.includes('gpu-layers') || errorMsg.includes('failed to create context') || errorMsg.includes('UnableToLoadModel')

            promptResults.push({
              promptId: prompt.id,
              metrics: null,
              output: null,
              qualityMatch: null,
              error: errorMsg,
              errorStack: promptError && promptError.stack ? promptError.stack : null,
              vramError: isVramError
            })
          }

          // Add small delay between prompts (model stays loaded)
          if (promptIndex < prompts.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 50))
          }
        }

        // Unload model after all prompts for this case are done
        let unloadMs = null
        if (modelLoaded && model) {
          try {
            const unloadStart = process.hrtime()
            await model.unload().catch(() => {})
            unloadMs = elapsedMs(unloadStart)
          } catch (unloadError) {
            debugLogger.warn(`Failed to unload model: ${unloadError.message || String(unloadError)}`)
          }
        }

        // Update metrics with load/unload times (per-case, not per-prompt/repeat)
        for (const promptResult of promptResults) {
          if (promptResult.metrics != null) {
            promptResult.metrics.loadMs = loadMs
            promptResult.metrics.unloadMs = round(unloadMs, 3)
          }
        }

        // Close loader after all prompts
        try {
          await loader.close().catch(() => {})
        } catch (closeError) {
          debugLogger.warn(`Failed to close loader: ${closeError.message || String(closeError)}`)
        }

        // Add delay after case completion to allow cleanup
        await new Promise(resolve => setTimeout(resolve, 200))

        // Aggregate metrics across prompts (average) - only for successful runs
        const successfulResults = promptResults.filter(p => p.metrics != null && !p.error)
        const firstSuccess = successfulResults.length > 0 ? successfulResults[0] : null
        const aggregatedMetrics = successfulResults.length > 0
          ? {
              repeats: firstSuccess?.metrics?.repeats ?? null,
              loadMs: firstSuccess?.metrics?.loadMs ?? null, // Load time is per-case, not per-prompt
              runMs: round(average(successfulResults.map(p => p.metrics?.runMs).filter(x => x != null)), 3),
              unloadMs: firstSuccess?.metrics?.unloadMs ?? null, // Unload time is per-case, not per-prompt
              ttftMs: round(average(successfulResults.map(p => p.metrics?.ttftMs).filter(x => x != null)), 3),
              tps: round(average(successfulResults.map(p => p.metrics?.tps).filter(x => x != null)), 3),
              promptTokens: round(average(successfulResults.map(p => p.metrics?.promptTokens).filter(x => x != null)), 0),
              generatedTokens: round(average(successfulResults.map(p => p.metrics?.generatedTokens).filter(x => x != null)), 0),
              runtimeMemory: {
                rssMb: round(average(successfulResults.map(p => p.metrics?.runtimeMemory?.rssMb).filter(x => x != null)), 2),
                heapUsedMb: round(average(successfulResults.map(p => p.metrics?.runtimeMemory?.heapUsedMb).filter(x => x != null)), 2),
                externalMb: round(average(successfulResults.map(p => p.metrics?.runtimeMemory?.externalMb).filter(x => x != null)), 2)
              }
            }
          : null

        const avgQualityMatch = round(average(promptResults.filter(p => !p.error).map(p => p.qualityMatch).filter(x => x != null)), 6)
        const hasErrors = promptResults.some(p => p.error != null)

        caseResults.push({
          ...testCase,
          metrics: aggregatedMetrics,
          qualityMatch: avgQualityMatch,
          hasErrors,
          promptResults
        })
      } catch (caseError) {
        // If case setup failed (e.g., model load), clean up and continue
        // Note: model might not be defined if error occurred before model creation
        try {
          if (model && modelLoaded) {
            await model.unload().catch(() => {})
          }
        } catch {
          // Ignore cleanup errors
        }
        try {
          if (loader) {
            await loader.close().catch(() => {})
          }
        } catch {
          // Ignore cleanup errors
        }
        debugLogger.error(`Case ${testCase.caseId} failed completely: ${caseError.message || String(caseError)}`)
        caseResults.push({
          ...testCase,
          metrics: null,
          qualityMatch: null,
          hasErrors: true,
          error: caseError.message || String(caseError),
          errorStack: caseError.stack || null,
          promptResults: []
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
  const jsonPath = path.join(resultsDir, `llm-parameter-sweep-${stamp}.json`)
  const mdPath = path.join(resultsDir, `llm-parameter-sweep-${stamp}.md`)

  isShuttingDown = true
  flushProgress()

  try {
    fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2))
    fs.writeFileSync(mdPath, toMarkdown(report))
    debugLogger.log('\nDone.')
    debugLogger.log(`JSON: ${jsonPath}`)
    debugLogger.log(`MD:   ${mdPath}`)
  } catch (writeError) {
    console.error('Failed to write report files:', writeError)
  }
}

let isShuttingDown = false
let moduleFlushProgress = null

process.on('uncaughtException', (error) => {
  if (isShuttingDown) {
    return
  }
  if (typeof moduleFlushProgress === 'function') {
    moduleFlushProgress()
  }
  console.error('Uncaught exception in parameter sweep:')
  console.error(error && error.stack ? error.stack : String(error))
  console.error('Progress should be saved. Run again to resume.')
  process.exit(130)
})

process.on('unhandledRejection', (reason, promise) => {
  if (isShuttingDown) {
    return
  }
  console.error('Unhandled rejection in parameter sweep:')
  console.error(reason)
  // Convert to exception so it's handled by uncaughtException
  throw reason
})

main().catch((error) => {
  isShuttingDown = true
  if (typeof moduleFlushProgress === 'function') {
    moduleFlushProgress()
  }
  console.error('Parameter sweep failed:')
  console.error(error && error.stack ? error.stack : String(error))
  console.error('Progress should be saved. Run again to resume.')
  process.exit(130)
})
