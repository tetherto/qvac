'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const { round, average, stddev, cartesianProduct } = require('./math')
const { stripSurroundingQuotes, normalizeArgValue } = require('./utils')

const PROMPT_CASES = ['long', 'ctx-filling', 'span-fill']
const PROMPTS_PER_CASE = 1

const SWEEP_OVERRIDE_KEYS = [
  'quantization',
  'device',
  'ctx-size',
  'threads',
  'batch-size',
  'ubatch-size',
  'flash-attn',
  'cache-type-k',
  'cache-type-v'
]

function splitCsvArg (value, key) {
  const normalizedInput = normalizeArgValue(value)
  if (normalizedInput === true || normalizedInput == null || normalizedInput === '') {
    throw new Error(`Missing value for --${key}. Expected comma-separated values.`)
  }
  const parts = String(normalizedInput)
    .split(',')
    .map((v) => stripSurroundingQuotes(v).trim())
    .filter(Boolean)
  if (parts.length === 0) {
    throw new Error(`Empty value for --${key}. Expected comma-separated values.`)
  }
  return parts
}

function buildSweepFromArgs (baseSweep, args) {
  const nextSweep = {}
  for (const [key, values] of Object.entries(baseSweep)) {
    nextSweep[key] = Array.isArray(values) ? values.slice() : values
  }

  for (const key of SWEEP_OVERRIDE_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(args, key)) continue
    const rawValues = splitCsvArg(args[key], key)
    nextSweep[key] = rawValues.map((v) => String(v))
  }

  return nextSweep
}

function ensureDir (dirPath) {
  fs.mkdirSync(dirPath, { recursive: true })
}

function resolveModelName (modelDef, quantization) {
  return modelDef.quantizationFiles[quantization] || null
}

function checkModelExists (modelDir, modelName) {
  return fs.existsSync(path.join(modelDir, modelName))
}

function buildCases (modelDef, sweep) {
  const baseQuant = Array.isArray(modelDef.quantizations) ? modelDef.quantizations[0] : null
  const defaults = modelDef.defaults || {}
  if (baseQuant == null) {
    throw new Error(`No baseline quantization configured for model "${modelDef.id}"`)
  }
  const supportedQuants = (sweep.quantization || [])
    .filter((quant) => !!resolveModelName(modelDef, quant))

  if (supportedQuants.length === 0) {
    throw new Error(`No supported quantizations found for model "${modelDef.id}"`)
  }

  const devices = sweep.device || []
  const ctxSizes = sweep['ctx-size'] || []
  const batchSizes = sweep['batch-size'] || []
  const ubatchSizes = sweep['ubatch-size'] || []
  const flashAttnValues = sweep['flash-attn'] || []
  const threadsValues = sweep.threads || []
  const cacheTypeKValues = sweep['cache-type-k'] || []
  const cacheTypeVValues = sweep['cache-type-v'] || []

  const cases = []
  for (const promptCase of PROMPT_CASES) {
    cases.push({
      caseId: `${modelDef.id}__q=${baseQuant}__baseline-defaults__pc=${promptCase}`,
      parameter: 'baseline',
      value: 'default',
      promptCase,
      quantization: baseQuant,
      modelName: resolveModelName(modelDef, baseQuant),
      runtimeConfig: { ...defaults },
      isBaseline: true
    })
  }

  if (devices.length > 0 && ctxSizes.length > 0 && batchSizes.length > 0 && ubatchSizes.length > 0 &&
      flashAttnValues.length > 0 &&
      threadsValues.length > 0 && cacheTypeKValues.length > 0 && cacheTypeVValues.length > 0) {
    const combos = cartesianProduct([
      supportedQuants,
      devices,
      ctxSizes,
      batchSizes,
      ubatchSizes,
      flashAttnValues,
      threadsValues,
      cacheTypeKValues,
      cacheTypeVValues
    ])

    for (const [quantization, device, ctxSize, batchSize, ubatchSize, flashAttn, threads, cacheTypeK, cacheTypeV] of combos) {
      if (Number(ubatchSize) > Number(batchSize)) {
        continue // Skip combinations where ubatchSize is greater than batchSize
      }
      const runtimeConfig = {
        ...defaults,
        device,
        'ctx-size': ctxSize,
        'batch-size': batchSize,
        'ubatch-size': ubatchSize,
        'flash-attn': flashAttn,
        threads,
        'cache-type-k': cacheTypeK,
        'cache-type-v': cacheTypeV
      }

      const caseId = `${modelDef.id}__q=${quantization}__dev=${device}__ctx=${ctxSize}__bs=${batchSize}__ubs=${ubatchSize}__fa=${flashAttn}__t=${threads}__ck=${cacheTypeK}__cv=${cacheTypeV}`

      for (const promptCase of PROMPT_CASES) {
        cases.push({
          caseId: `${caseId}__pc=${promptCase}`,
          parameter: 'full-grid',
          value: 'combination',
          promptCase,
          quantization,
          modelName: resolveModelName(modelDef, quantization),
          runtimeConfig,
          isBaseline: false
        })
      }
    }
  }

  cases.sort((a, b) => Number(b.isBaseline) - Number(a.isBaseline))
  return cases
}

function isAdaptivePromptId (promptId) {
  return String(promptId || '').startsWith('ctx-filling__ctx=') ||
    String(promptId || '').startsWith('batch-spanning__ctx=')
}

function selectPromptForCase (allPrompts, runtimeConfig, promptCase) {
  const byId = new Map(allPrompts.map((p) => [p.id, p]))
  const ctx = String(runtimeConfig['ctx-size'])
  const batch = String(runtimeConfig['batch-size'])
  const ctxId = `ctx-filling__ctx=${ctx}`
  const batchId = `batch-spanning__ctx=${ctx}__bs=${batch}`
  const promptId = promptCase === 'ctx-filling'
    ? ctxId
    : (promptCase === 'span-fill' ? batchId : 'long')
  if (!byId.has(promptId)) {
    throw new Error(
      `Missing required prompt id "${promptId}" in prompt file. ` +
      'Run `npm run prepare:prompts` (or pass --prompts-file with exact variants).'
    )
  }
  return byId.get(promptId)
}

function getAdaptiveBaselineKey (promptId) {
  return isAdaptivePromptId(promptId) ? String(promptId) : null
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

function aggregateRunMetrics (runMetrics) {
  const loadMsValues = runMetrics.map((x) => x.loadMs).filter((x) => x != null)
  const runMsValues = runMetrics.map((x) => x.runMs).filter((x) => x != null)
  const unloadMsValues = runMetrics.map((x) => x.unloadMs).filter((x) => x != null)
  const ttftMsValues = runMetrics.map((x) => x.ttftMs).filter((x) => x != null)
  const tpsValues = runMetrics.map((x) => x.tps).filter((x) => x != null)
  const firstPromptTokens = runMetrics.find((x) => x.promptTokens != null)?.promptTokens ?? null
  const firstGeneratedTokens = runMetrics.find((x) => x.generatedTokens != null)?.generatedTokens ?? null

  return {
    repeats: runMetrics.length,
    loadMsMean: round(average(loadMsValues), 3),
    runMsMean: round(average(runMsValues), 3),
    unloadMsMean: round(average(unloadMsValues), 3),
    loadMsStd: round(stddev(loadMsValues), 3),
    runMsStd: round(stddev(runMsValues), 3),
    unloadMsStd: round(stddev(unloadMsValues), 3),
    ttftMsMean: round(average(ttftMsValues), 3),
    ttftMsStd: round(stddev(ttftMsValues), 3),
    tpsMean: round(average(tpsValues), 3),
    tpsStd: round(stddev(tpsValues), 3),
    promptTokens: firstPromptTokens,
    generatedTokens: firstGeneratedTokens
  }
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

function loadPreviousCaseRecords (resultsDir, currentJsonlPath) {
  const recordsByCaseKey = new Map()
  let files = []
  try {
    files = fs.readdirSync(resultsDir)
      .filter((name) => /^llm-parameter-sweep-\d{8}-\d{6}\.jsonl$/.test(name))
      .sort()
  } catch {
    return recordsByCaseKey
  }

  for (const name of files) {
    const absPath = path.join(resultsDir, name)
    if (absPath === currentJsonlPath) continue
    let raw = ''
    try {
      raw = fs.readFileSync(absPath, 'utf8')
    } catch {
      continue
    }
    const lines = raw.split('\n').filter(Boolean)
    for (const line of lines) {
      let parsed = null
      try {
        parsed = JSON.parse(line)
      } catch {
        continue
      }
      if (!parsed || !parsed.modelId || !parsed.caseId) continue
      recordsByCaseKey.set(`${parsed.modelId}:${parsed.caseId}`, parsed)
    }
  }
  return recordsByCaseKey
}

function seedBaselineCachesFromRecord (record, baselineOutputs, adaptiveBaselineOutputs) {
  if (!record || !record.isBaseline) return
  const promptResults = Array.isArray(record.promptResults) ? record.promptResults : []
  for (const promptResult of promptResults) {
    if (!promptResult || !promptResult.promptId) continue
    const promptId = String(promptResult.promptId)
    const outputText = typeof promptResult.outputText === 'string'
      ? promptResult.outputText
      : null
    if (outputText == null) continue
    baselineOutputs[promptId] = outputText
    const adaptiveKey = getAdaptiveBaselineKey(promptId)
    if (adaptiveKey) {
      adaptiveBaselineOutputs[adaptiveKey] = outputText
    }
  }
}

module.exports = {
  PROMPT_CASES,
  PROMPTS_PER_CASE,
  SWEEP_OVERRIDE_KEYS,
  splitCsvArg,
  buildSweepFromArgs,
  ensureDir,
  resolveModelName,
  checkModelExists,
  buildCases,
  isAdaptivePromptId,
  selectPromptForCase,
  getAdaptiveBaselineKey,
  validatePromptObject,
  aggregateRunMetrics,
  loadPromptsFromFile,
  loadPreviousCaseRecords,
  seedBaselineCachesFromRecord
}
