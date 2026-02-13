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
    quick: false,
    compare: false // PyTorch-compatible mode: applies constraints for fair comparison
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
    else if (arg === '--compare') args.compare = true
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

const getSupportedQuantizations = (config, platform, compareMode) => {
  const all = config.params?.quantization || []
  // In compare mode, limit macOS to F16 to match PyTorch's limitation for fair comparison
  // In QVAC-only mode, allow all quantizations that QVAC supports (QVAC can run Q4/Q8 on macOS GPU)
  if (compareMode && platform === 'darwin') {
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

const buildAddonConfig = (baseline, paramName, paramValue, prompt, compareMode) => {
  const config = { ...baseline, [paramName]: paramValue }
  if (typeof paramValue === 'undefined') {
    delete config[paramName]
  }
  
  // In compare mode, apply PyTorch-compatible constraints
  if (compareMode) {
    // Sync cache-type-k and cache-type-v: PyTorch requires them to match
    if (paramName === 'cache-type-k') {
      config['cache-type-v'] = paramValue
    } else if (paramName === 'cache-type-v') {
      config['cache-type-k'] = paramValue
    }
    // Cap ubatch-size to batch-size when batch-size is being swept
    if (paramName === 'batch-size') {
      const batchSize = paramValue ? Number(paramValue) : Number(baseline['batch-size'] || '1')
      const ubatchSize = Number(config['ubatch-size'] || String(batchSize))
      if (ubatchSize > batchSize) {
        config['ubatch-size'] = String(batchSize)
      }
    }
  }
  if (prompt.n_predict) {
    config.n_predict = String(prompt.n_predict)
  }
  delete config.quantization
  delete config.modelId
  
  // For boolean flags (no-mmap, no-kv-offload), empty string means "enabled"
  // The C++ code at LlamaModel.cpp:390-396 pushes --flag only (no value) when value is empty
  const booleanFlags = ['no-mmap', 'no-kv-offload']
  for (const flag of booleanFlags) {
    if (config[flag] === null || config[flag] === undefined) {
      delete config[flag]
    }
    // If flag is '', leave it as '' (C++ code will treat empty string as enabled flag)
  }
  
  // Handle flash-attn: llama.cpp's parser requires a value (not a void flag)
  // Empty string causes parsing errors, so we delete it and let llama.cpp use default behavior
  if (config['flash-attn'] === null || config['flash-attn'] === undefined || config['flash-attn'] === '') {
    delete config['flash-attn']
  }
  
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
  addonSpec,
  compareMode = false
}) => {
  // Always clean up addon + loader, even on error, to avoid stuck event loops.
  let loader = null
  let addon = null
  // Track which stage failed so results don't mask the root cause.
  let errorStage = 'init'
  let modelName = null
  let backend = null
  const resolvedValue = resolveParamValue(paramValue, baseline)
  const config = buildAddonConfig(baseline, paramName, resolvedValue, prompt, compareMode)
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
    const errorMsg = error?.message || String(error)
    const errorStack = error?.stack || null
    
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
      error: errorMsg,
      errorStack
    })
    log(`Run failed: model=${modelConfig.id} ${paramName}=${resolvedValue} prompt=${prompt.id} rep=${repIndex} stage=${errorStage}`)
    
    // Context overflow errors require a long delay before cleanup to prevent segfaults
    // Pattern from integration tests (config-parameters.test.js:162)
    const isContextOverflow = errorMsg && /context|ctx[- ]?size|overflow/i.test(errorMsg)
    if (isContextOverflow) {
      await new Promise(resolve => setTimeout(resolve, 15000))
    }
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
  const compareMode = args.compare
  const supportedQuantizations = getSupportedQuantizations(config, platform, compareMode)
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

  // Track progress to resume after crashes
  const progressFile = outputPath.replace('.jsonl', '.progress.json')
  let completedRuns = new Set()
  try {
    const progressData = JSON.parse(fs.readFileSync(progressFile, 'utf8'))
    completedRuns = new Set(progressData.completedRuns || [])
    log(`Resuming: ${completedRuns.size} runs already completed`)
  } catch {
    // No progress file, start fresh
  }
  
  // Helper to save progress (called only after state changes: success or failure)
  const saveProgress = () => {
    try {
      fs.writeFileSync(progressFile, JSON.stringify({ completedRuns: Array.from(completedRuns) }, null, 2))
    } catch {
      // Ignore write errors - progress tracking is best-effort
    }
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
            // Create unique run identifier
            const runKey = `${modelConfig.id}:${paramName}:${resolveParamValue(value, config.baseline)}:${prompt.id}:${rep}`
            
            // Skip if already completed successfully
            if (completedRuns.has(runKey)) {
              log(`Skipping already completed: ${runKey}`)
              continue
            }
            // If it was started but not completed, it likely crashed - retry it
            if (completedRuns.has(runKey + ':started')) {
              log(`Retrying previously crashed run: ${runKey}`)
              completedRuns.delete(runKey + ':started')
            }
            // If it was marked as failed, skip it to avoid infinite retry loops
            // To retry failed runs instead, change this to: completedRuns.delete(runKey + ':failed')
            if (completedRuns.has(runKey + ':failed')) {
              log(`Skipping previously failed run: ${runKey}`)
              continue
            }

            // Mark as started (before attempting) so we can detect if it crashes
            // This way, if the process segfaults, we know this run was attempted
            completedRuns.add(runKey + ':started')

            try {
              await runOnce({
                baseline: { ...config.baseline, quantization: baselineQuantization, modelId: modelConfig.id },
                modelConfig,
                prompt,
                paramName,
                paramValue: value,
                repIndex: rep,
                outputPath,
                addonSpec,
                compareMode
              })
              // Mark as completed (replace :started with :completed)
              completedRuns.delete(runKey + ':started')
              completedRuns.add(runKey)
              saveProgress()
              // Add delay between runs to allow cleanup to complete fully
              // This prevents segfaults from C++ destructors running while async cleanup is still happening
              // Pattern from integration tests (multi-instance.test.js shows delays between cycles)
              await new Promise(resolve => setTimeout(resolve, 200))
            } catch (error) {
              // Log crash but continue to next run
              const errorMsg = error?.message || String(error)
              log(`⚠️  Run crashed: ${runKey} - ${errorMsg}`)
              // Mark as attempted but failed (remove :started, add :failed)
              completedRuns.delete(runKey + ':started')
              completedRuns.add(runKey + ':failed')
              saveProgress()
              // Continue to next run instead of crashing
            }
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
