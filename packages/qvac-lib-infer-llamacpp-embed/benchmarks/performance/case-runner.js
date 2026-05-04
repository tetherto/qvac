'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const process = require('bare-process')
const {
  elapsedMs,
  round,
  similarityStats,
  cartesianProduct,
  average
} = require('./math')

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

function normalizeEmbeddings (rawEmbeddings) {
  if (!Array.isArray(rawEmbeddings) || !Array.isArray(rawEmbeddings[0])) {
    throw new Error('Invalid embedding response structure')
  }
  return rawEmbeddings[0].map((vector) => Array.from(vector))
}

function buildAddonConfig (runtimeConfig, options = {}) {
  const debugEnabled = !!options.debugEnabled
  const config = { verbosity: debugEnabled ? '2' : '0' }
  if (runtimeConfig.device != null) config.device = String(runtimeConfig.device)
  if (runtimeConfig.batchSize != null) config.batch_size = String(runtimeConfig.batchSize)
  if (runtimeConfig.flashAttn != null) config.flash_attn = String(runtimeConfig.flashAttn)
  if (runtimeConfig.ngl != null) config.gpu_layers = String(runtimeConfig.ngl)
  if (runtimeConfig.noMmap) config['no-mmap'] = ''
  return config
}

function resolveModelName (modelDef, quantization) {
  return modelDef.quantizationFiles[quantization] || null
}

function checkModelExists (modelDir, modelName) {
  return fs.existsSync(path.join(modelDir, modelName))
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
    sweep.flashAttn
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
          flashAttn
        },
        inputMode,
        isBaseline: false
      })
    }
  }

  cases.sort((a, b) => Number(b.isBaseline) - Number(a.isBaseline))
  return cases
}

function aggregateRunMetrics (runMetrics) {
  const runMsValues = runMetrics.map((x) => x.runMs)
  const tpsValues = runMetrics.map((x) => x.tps).filter((x) => x != null)
  const repeatsSucceeded = runMetrics.length
  if (repeatsSucceeded === 0) {
    return {
      repeats: 0,
      loadMs: null,
      runMs: null,
      unloadMs: null,
      tps: null
    }
  }
  const runMsTotal = runMsValues.reduce((acc, value) => acc + value, 0)

  return {
    repeats: repeatsSucceeded,
    loadMs: round(runMetrics[0].loadMs, 3),
    runMs: round(runMsTotal / repeatsSucceeded, 3),
    unloadMs: round(runMetrics[0].unloadMs, 3),
    tps: tpsValues.length ? round(average(tpsValues), 3) : null
  }
}

async function runCaseWithRepeats ({ AddonCtor, modelDir, modelName, runtimeConfig, inputs, repeats, onRepeatComplete, debugEnabled }) {
  const addonConfig = buildAddonConfig(runtimeConfig, { debugEnabled })
  const addonRuntimeLogger = createAddonRuntimeLogger(debugEnabled)

  let model = null
  let loadMs = null
  let unloadMs = null
  let firstEmbeddings = null
  const runMetrics = []
  const errors = []
  let primaryError = null
  const cleanupErrors = []

  try {
    model = new AddonCtor({
      files: { model: [path.join(modelDir, modelName)] },
      config: addonConfig,
      logger: addonRuntimeLogger,
      opts: { stats: true }
    })

    const loadStart = process.hrtime()
    await model.load()
    loadMs = elapsedMs(loadStart)

    for (let repeat = 1; repeat <= repeats; repeat++) {
      try {
        const response = await model.run(inputs)
        const rawEmbeddings = await response.await()
        const runtimeStats = response.stats
        if (!firstEmbeddings) {
          firstEmbeddings = normalizeEmbeddings(rawEmbeddings)
        }
        runMetrics.push({
          loadMs,
          runMs: runtimeStats.total_time_ms,
          tps: runtimeStats.tokens_per_second,
          unloadMs: null
        })
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
  }

  if (primaryError) {
    const primary = primaryError.message || String(primaryError)
    throw new Error(`Case failed: ${primary}`)
  }

  if (cleanupErrors.length > 0) {
    errors.push({
      repeat: null,
      message: `Cleanup failed: ${cleanupErrors.join('; ')}`
    })
  }

  for (const metric of runMetrics) {
    metric.unloadMs = unloadMs
  }

  return {
    metrics: aggregateRunMetrics(runMetrics),
    embeddings: firstEmbeddings,
    errors,
    repeatsAttempted: repeats,
    repeatsSucceeded: runMetrics.length
  }
}

function buildCaseResult ({
  testCase,
  executionResult,
  baselineEmbeddingsByInputMode,
  repeats,
  failureMessage
}) {
  if (failureMessage) {
    return {
      ...testCase,
      metrics: null,
      similarity: null,
      status: 'failed',
      repeatsAttempted: repeats,
      repeatsSucceeded: 0,
      error: {
        message: failureMessage
      }
    }
  }

  if (testCase.parameter === 'baseline' && executionResult.embeddings) {
    baselineEmbeddingsByInputMode.set(testCase.inputMode, executionResult.embeddings)
  }

  const similarity = testCase.parameter === 'baseline'
    ? (
        executionResult.embeddings
          ? { avg: 1, min: 1, max: 1, count: executionResult.embeddings.length }
          : null
      )
    : similarityStats(
      baselineEmbeddingsByInputMode.get(testCase.inputMode),
      executionResult.embeddings
    )

  const hasRepeatErrors = Array.isArray(executionResult.errors) && executionResult.errors.length > 0
  const status = hasRepeatErrors
    ? (executionResult.repeatsSucceeded > 0 ? 'partial-failure' : 'failed')
    : 'ok'
  const error = hasRepeatErrors
    ? (() => {
        const uniqueMessages = [...new Set(executionResult.errors.map((entry) => entry.message))]
        const detail = uniqueMessages.length === 1
          ? uniqueMessages[0]
          : `${uniqueMessages.length} distinct errors (first: ${uniqueMessages[0]})`
        return {
          message: `${executionResult.errors.length}/${executionResult.repeatsAttempted} repeats failed: ${detail}`,
          repeats: executionResult.errors
        }
      })()
    : null

  return {
    ...testCase,
    metrics: executionResult.metrics,
    similarity,
    status,
    repeatsAttempted: executionResult.repeatsAttempted,
    repeatsSucceeded: executionResult.repeatsSucceeded,
    error
  }
}

async function runModelCases ({
  AddonCtor,
  repeats,
  debugEnabled,
  debugLogger,
  modelDef,
  cases,
  inputsByBatchSize,
  progress
}) {
  debugLogger.log(`\n=== ${modelDef.id} ===`)
  debugLogger.log(`Cases to run: ${cases.length}`)
  const baselineEmbeddingsByInputMode = new Map()
  const caseResults = []

  for (let caseIndex = 0; caseIndex < cases.length; caseIndex++) {
    const testCase = cases[caseIndex]
    let executionResult = null
    let failureMessage = null

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
      if (!Array.isArray(inputsRaw) || inputsRaw.length === 0) {
        const configuredBatchSizes = Object.keys(inputsByBatchSize || {}).sort()
        throw new Error(
          `Invalid inputs.json for case ${testCase.caseId}: missing or empty inputs for batch size ` +
          `${testCase.runtimeConfig.batchSize}. Configured batch sizes: ` +
          `${configuredBatchSizes.length ? configuredBatchSizes.join(', ') : '(none)'}`
        )
      }
      const inputs = testCase.inputMode === 'single' ? inputsRaw[0] : inputsRaw
      executionResult = await runCaseWithRepeats({
        AddonCtor,
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
    } catch (error) {
      failureMessage = error.message || String(error)
      debugLogger.warn(`Case failed: ${testCase.caseId}: ${failureMessage}`)
      for (let repeat = 1; repeat <= repeats; repeat++) {
        progress.tick({
          modelId: modelDef.id,
          caseIndex: caseIndex + 1,
          caseCount: cases.length,
          repeat,
          repeats
        })
      }
    }

    const caseResult = buildCaseResult({
      testCase,
      executionResult,
      baselineEmbeddingsByInputMode,
      repeats,
      failureMessage
    })
    caseResults.push(caseResult)
  }

  return {
    modelId: modelDef.id,
    source: modelDef.source,
    modelDir: modelDef.modelDir,
    cases: caseResults
  }
}

module.exports = {
  buildCases,
  runModelCases
}
