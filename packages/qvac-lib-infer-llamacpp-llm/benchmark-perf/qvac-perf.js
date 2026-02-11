'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const os = require('bare-os')
const FilesystemDL = require('@qvac/dl-filesystem')
const bareProcess = require('bare-process')
const LlmLlamacpp = require('../index.js')
const { ensureModel } = require('./helpers')

const DEFAULT_CONFIG_PATH = path.resolve(__dirname, 'perf-config.json')

const nowMs = () => Date.now()

const log = (message) => {
  const ts = new Date().toISOString()
  console.log(`[${ts}] ${message}`)
}

const hrtimeMs = (start) => {
  if (bareProcess?.hrtime) {
    const [s, ns] = bareProcess.hrtime(start)
    return s * 1e3 + ns / 1e6
  }
  return nowMs() - start
}

const captureMemory = () => {
  if (!bareProcess?.memoryUsage) {
    return null
  }
  const usage = bareProcess.memoryUsage()
  return {
    rssBytes: usage.rss,
    heapUsedBytes: usage.heapUsed,
    externalBytes: usage.external
  }
}

const stringifyPrompt = (messages) => {
  return messages.map(msg => `${msg.role}: ${msg.content}`).join('\n') + '\nassistant:'
}

const normalizeAddonSpec = (spec) => {
  if (!spec) return spec
  const isPath = spec.startsWith('/') || spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('~/')
  if (isPath) return spec
  if (spec.startsWith('@')) {
    const versionIndex = spec.indexOf('@', 1)
    return versionIndex === -1 ? spec : spec.slice(0, versionIndex)
  }
  const versionIndex = spec.lastIndexOf('@')
  return versionIndex > 0 ? spec.slice(0, versionIndex) : spec
}

const parseArgs = (argv) => {
  const args = {
    config: DEFAULT_CONFIG_PATH,
    params: null,
    reps: null,
    output: null,
    addon: null,
    hfToken: null,
    quick: false
  }
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--config') args.config = argv[++i]
    else if (arg === '--params') args.params = argv[++i]
    else if (arg === '--reps') args.reps = Number(argv[++i])
    else if (arg === '--output') args.output = argv[++i]
    else if (arg === '--addon') args.addon = normalizeAddonSpec(argv[++i])
    else if (arg === '--hf-token') args.hfToken = argv[++i]
    else if (arg === '--quick') args.quick = true
  }
  return args
}

const readConfig = (configPath) => {
  return JSON.parse(fs.readFileSync(configPath, 'utf-8'))
}

const ensureDir = (dirPath) => {
  fs.mkdirSync(dirPath, { recursive: true })
}

const appendJsonl = (filePath, obj) => {
  fs.appendFileSync(filePath, `${JSON.stringify(obj)}\n`)
}

const resolveParamsToRun = (config, paramsArg) => {
  if (!paramsArg || paramsArg === 'all') return Object.keys(config.params)
  return paramsArg.split(',').map(p => p.trim()).filter(Boolean)
}

const getSupportedQuantizations = (config, platform) => {
  const all = config.params?.quantization || []
  if (platform === 'darwin') {
    return all.includes('F16') ? ['F16'] : []
  }
  return all
}

const resolveParamValue = (value, config) => {
  if (value === '{max}') {
    return String(os.cpus().length)
  }
  return value
}

const pickQuickValues = (values, baselineValue) => {
  const picked = []
  const addValue = (value) => {
    if (!picked.some(v => v === value)) picked.push(value)
  }
  addValue(baselineValue)
  for (const raw of values || []) {
    const normalized = raw === null ? undefined : raw
    if (normalized !== baselineValue) {
      addValue(normalized)
      break
    }
  }
  return picked.filter(v => v !== undefined || baselineValue === undefined)
}

const createRunId = () => {
  const rand = Math.random().toString(36).slice(2)
  return `${Date.now()}-${rand}`
}

const resolveOutputPath = (outputArg, modelId) => {
  if (outputArg) return outputArg
  const resultsDir = path.resolve(__dirname, 'results')
  ensureDir(resultsDir)
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const modelTag = modelId ? `_${modelId}` : ''
  return path.join(resultsDir, `qvac_${os.hostname?.() || 'machine'}${modelTag}_${timestamp}.jsonl`)
}

const buildAddonConfig = (baseline, paramName, paramValue, prompt) => {
  const config = { ...baseline, [paramName]: paramValue }
  if (typeof paramValue === 'undefined') {
    delete config[paramName]
  }
  if (prompt.n_predict) {
    config.n_predict = String(prompt.n_predict)
  }
  delete config.quantization
  delete config.modelId
  return config
}

const getBackend = (addon) => {
  if (addon && typeof addon.getApiDefinition === 'function') {
    return addon.getApiDefinition()
  }
  return os.platform() === 'darwin' ? 'metal' : 'vulkan'
}

const resolveAddonModule = (addonSpec) => {
  if (!addonSpec) {
    return LlmLlamacpp
  }
  try {
    return require(addonSpec)
  } catch (error) {
    return require(path.resolve(addonSpec))
  }
}

const runOnce = async ({
  baseline,
  modelConfig,
  prompt,
  paramName,
  paramValue,
  repIndex,
  outputPath,
  addonSpec
}) => {
  // Always clean up addon + loader, even on error, to avoid stuck event loops.
  let loader = null
  let addon = null
  // Track which stage failed so results don't mask the root cause.
  let errorStage = 'init'
  let modelName = null
  let backend = null
  const resolvedValue = resolveParamValue(paramValue, baseline)
  const config = buildAddonConfig(baseline, paramName, resolvedValue, prompt)
  const quantization = paramName === 'quantization' ? resolvedValue : baseline.quantization
  const variantConfig = modelConfig.qvac?.[quantization]
  if (!variantConfig) {
    throw new Error(`Missing QVAC model variant config for ${quantization}`)
  }

  log(`Starting run: model=${modelConfig.id} ${paramName}=${resolvedValue} prompt=${prompt.id} rep=${repIndex}`)
  const runId = createRunId()
  let modelLoadMs = null
  let modelUnloadMs = null
  let memoryLoad = null
  let memoryEnd = null
  let memoryUnload = null
  let stats = {}
  let outputText = ''
  let promptText = stringifyPrompt(prompt.messages)
  let ttftMs = null
  try {
    errorStage = 'ensureModel'
    const [resolvedModelName, modelDir] = await ensureModel({
      modelName: variantConfig.modelName,
      downloadUrl: variantConfig.downloadUrl
    })
    modelName = resolvedModelName

    loader = new FilesystemDL({ dirPath: modelDir })
    const AddonClass = resolveAddonModule(addonSpec)
    addon = new AddonClass({
      loader,
      modelName,
      diskPath: modelDir,
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      opts: { stats: true }
    }, config)

    backend = getBackend(addon)

    errorStage = 'load'
    log(`Loading model: ${modelName}`)
    const loadStart = bareProcess?.hrtime
      ? bareProcess.hrtime()
      : nowMs()
    await addon.load()
    modelLoadMs = hrtimeMs(loadStart)
    log(`Model loaded in ${modelLoadMs.toFixed(1)}ms`)

    memoryLoad = captureMemory()

    errorStage = 'run'
    const start = nowMs()
    let timeToFirstToken = null
    const chunks = []
    log(`Running inference: prompt=${prompt.id}`)
    const response = await addon.run(prompt.messages)
    await response.onUpdate(data => {
      if (timeToFirstToken === null) {
        timeToFirstToken = nowMs() - start
      }
      chunks.push(data)
    }).await()

    stats = response.stats || {}
    memoryEnd = captureMemory()
    ttftMs = stats.TTFT ?? timeToFirstToken
    outputText = chunks.join('')

    errorStage = 'unload'
    log(`Unloading model: ${modelName}`)
    const unloadStart = bareProcess?.hrtime
      ? bareProcess.hrtime()
      : nowMs()
    await addon.unload()
    modelUnloadMs = hrtimeMs(unloadStart)
    memoryUnload = captureMemory()

    const result = {
      runId,
      timestamp: new Date().toISOString(),
      machine: os.hostname?.() || 'unknown',
      arch: os.arch(),
      platform: os.platform(),
      backend,
      gpu: null,
      impl: 'qvac',
      model: modelName,
      modelId: modelConfig.id,
      config: { ...config, quantization, modelId: modelConfig.id },
      perfParam: paramName,
      perfValue: resolvedValue,
      promptId: prompt.id,
      promptText,
      promptTokens: stats.promptTokens ?? null,
      modelLoadMs,
      modelUnloadMs,
      ttftMs,
      tps: stats.TPS ?? null,
      generatedTokens: stats.generatedTokens ?? null,
      promptTokensPerTtft: (stats.promptTokens !== null && stats.promptTokens !== undefined && ttftMs)
        ? stats.promptTokens / ttftMs
        : null,
      memory: {
        load: memoryLoad,
        end: memoryEnd,
        unload: memoryUnload
      },
      outputText,
      rep: repIndex
    }

    appendJsonl(outputPath, result)
    log(`Completed run: model=${modelConfig.id} ${paramName}=${resolvedValue} prompt=${prompt.id} rep=${repIndex}`)
  } catch (error) {
    appendJsonl(outputPath, {
      runId,
      timestamp: new Date().toISOString(),
      machine: os.hostname?.() || 'unknown',
      arch: os.arch(),
      platform: os.platform(),
      backend,
      impl: 'qvac',
      model: modelName || variantConfig.modelName,
      modelId: modelConfig.id,
      config: { ...config, quantization, modelId: modelConfig.id },
      perfParam: paramName,
      perfValue: resolvedValue,
      promptId: prompt.id,
      promptText,
      rep: repIndex,
      errorStage,
      error: error?.message || String(error),
      errorStack: error?.stack || null
    })
    log(`Run failed: model=${modelConfig.id} ${paramName}=${resolvedValue} prompt=${prompt.id} rep=${repIndex} stage=${errorStage}`)
  } finally {
    if (addon?.unload) {
      await addon.unload().catch(() => {})
    }
    if (loader?.close) {
      await loader.close().catch(() => {})
    }
  }
}

const run = async () => {
  const argv = bareProcess?.argv || (typeof process !== 'undefined' ? process.argv : [])
  const args = parseArgs(argv)
  if (args.hfToken) {
    if (bareProcess?.env) bareProcess.env.HF_TOKEN = args.hfToken
    if (typeof process !== 'undefined' && process.env) process.env.HF_TOKEN = args.hfToken
  }
  const config = readConfig(args.config)
  const paramsToRun = resolveParamsToRun(config, args.params)
  const reps = args.quick ? 1 : (Number.isFinite(args.reps) ? args.reps : config.reps)
  const outputPath = resolveOutputPath(args.output, config.baseline.modelId)
  const addonSpec = args.addon
  const platform = os.platform()
  const supportedQuantizations = getSupportedQuantizations(config, platform)
  let modelsToRun = config.models || []
  if (modelsToRun.length === 0) {
    throw new Error('perf-config.json must include at least one model in "models"')
  }
  if (args.quick) {
    const baselineModelId = config.baseline?.modelId
    const baselineModel = modelsToRun.find(model => model.id === baselineModelId)
    modelsToRun = baselineModel ? [baselineModel] : [modelsToRun[0]]
    config.prompts = config.prompts?.length ? [config.prompts[0]] : []
  }

  for (const modelConfig of modelsToRun) {
    for (const paramName of paramsToRun) {
      let values = config.params[paramName]
      if (!values) {
        console.warn(`Unknown param: ${paramName}, skipping`)
        continue
      }
      if (paramName === 'quantization') {
        values = supportedQuantizations
        if (!values.length) {
          console.warn(`No supported quantizations for platform ${platform}, skipping`)
          continue
        }
      }
      const baselineQuantization = supportedQuantizations.includes(config.baseline.quantization)
        ? config.baseline.quantization
        : (supportedQuantizations[0] || config.baseline.quantization)
      if (args.quick) {
        const baselineValue = paramName === 'quantization'
          ? baselineQuantization
          : config.baseline[paramName]
        values = pickQuickValues(values, baselineValue)
      }
      for (const rawValue of values) {
        const value = rawValue === null ? undefined : rawValue
        for (const prompt of config.prompts) {
          for (let rep = 1; rep <= reps; rep++) {
            await runOnce({
              baseline: { ...config.baseline, quantization: baselineQuantization, modelId: modelConfig.id },
              modelConfig,
              prompt,
              paramName,
              paramValue: value,
              repIndex: rep,
              outputPath,
              addonSpec
            })
          }
        }
      }
    }
  }

  log('All QVAC runs completed')
  if (bareProcess?.exit) {
    bareProcess.exit(0)
  } else if (typeof process !== 'undefined' && process.exit) {
    process.exit(0)
  }
}

run().catch(err => {
  console.error('❌ Error:', err)
  if (bareProcess?.exit) bareProcess.exit(1)
})
