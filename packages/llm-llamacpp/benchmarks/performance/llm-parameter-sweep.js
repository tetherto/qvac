'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const process = require('bare-process')
const FilesystemDL = require('@qvac/dl-filesystem')
const {
  parseAddonSource,
  resolveAddonCtor,
  createAddonRuntimeLogger,
  parseArgs,
  buildConfigObject
} = require('./utils')
const { round, average, stddev, elapsedMs, parsePositiveInt, exactMatch } = require('./math')
const { createDebugLogger, truncateText, createProgressReporter } = require('./progress')
const { tsFileStamp, toMarkdown, compactPromptErrors } = require('./reporters')
const {
  PROMPTS_PER_CASE,
  buildSweepFromArgs,
  ensureDir,
  checkModelExists,
  buildCases,
  isAdaptivePromptId,
  selectPromptForCase,
  getAdaptiveBaselineKey,
  aggregateRunMetrics,
  loadPromptsFromFile,
  loadPreviousCaseRecords,
  seedBaselineCachesFromRecord
} = require('./case-runner')

const {
  DEFAULT_RESULTS_DIR,
  DEFAULT_REPEATS,
  DEFAULT_PROMPTS_FILE,
  MODELS,
  PARAMETER_SWEEP
} = require('./llm-parameter-sweep.config')

async function main () {
  const args = parseArgs(process.argv)
  const debugEnabled = Boolean(args.debug)
  const debugLogger = createDebugLogger(debugEnabled)
  const addonSource = parseAddonSource(args['addon-source'])
  const AddonCtor = resolveAddonCtor(addonSource)
  const repeats = args.repeats ? parsePositiveInt(args.repeats, 'repeats') : DEFAULT_REPEATS
  const resultsDir = args['results-dir'] ? path.resolve(args['results-dir']) : DEFAULT_RESULTS_DIR
  const sweep = buildSweepFromArgs(PARAMETER_SWEEP, args)
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
  const sweepFingerprint = JSON.stringify({ repeats, sweep })
  let completedCases = new Set()
  let runStartedAt = null
  try {
    const progressData = JSON.parse(fs.readFileSync(progressFile, 'utf8'))
    if (progressData.sweepFingerprint && progressData.sweepFingerprint !== sweepFingerprint) {
      console.warn(
        'Progress file sweep parameters differ from current invocation (e.g. --repeats or sweep dimensions changed). ' +
        'Starting fresh. Delete progress file manually to suppress this warning.'
      )
    } else {
      completedCases = new Set(progressData.completedCases || [])
      runStartedAt = typeof progressData.startedAt === 'string' && progressData.startedAt
        ? progressData.startedAt
        : null
      debugLogger.log(`Resuming: ${completedCases.size} cases already completed`)
    }
  } catch {
    // No progress file, start fresh
  }
  if (!runStartedAt) {
    runStartedAt = new Date().toISOString()
  }

  let saveProgressTimeout = null
  const saveProgress = () => {
    if (saveProgressTimeout) {
      clearTimeout(saveProgressTimeout)
    }
    saveProgressTimeout = setTimeout(() => {
      try {
        fs.writeFileSync(progressFile, JSON.stringify({
          startedAt: runStartedAt,
          sweepFingerprint,
          completedCases: Array.from(completedCases)
        }, null, 2))
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
      fs.writeFileSync(progressFile, JSON.stringify({
        startedAt: runStartedAt,
        sweepFingerprint,
        completedCases: Array.from(completedCases)
      }, null, 2))
    } catch (writeError) {
      if (debugEnabled) {
        debugLogger.warn(`Failed to flush progress: ${writeError.message || String(writeError)}`)
      }
    }
  }

  moduleFlushProgress = flushProgress

  const stamp = tsFileStamp()
  const jsonPath = path.join(resultsDir, `llm-parameter-sweep-${stamp}.json`)
  const jsonlPath = path.join(resultsDir, `llm-parameter-sweep-${stamp}.jsonl`)
  const mdPath = path.join(resultsDir, `llm-parameter-sweep-${stamp}.md`)
  const previousCaseRecords = loadPreviousCaseRecords(resultsDir, jsonlPath)
  fs.writeFileSync(jsonlPath, '')

  const report = {
    startedAt: runStartedAt,
    finishedAt: null,
    repeats,
    promptsCount: PROMPTS_PER_CASE,
    sweep,
    selectedModelIds,
    jsonlPath,
    totalCases: 0,
    totalPlannedRuns: 0,
    totalCompletedRuns: 0,
    models: []
  }

  const plannedRunsByModel = selectedModels.map((modelDef) => {
    const cases = buildCases(modelDef, sweep)
    return { modelDef, cases }
  })
  const totalCases = plannedRunsByModel.reduce((acc, item) => acc + item.cases.length, 0)
  const totalPlannedRuns = plannedRunsByModel.reduce((acc, item) => acc + (item.cases.length * report.promptsCount * repeats), 0)
  report.totalCases = totalCases
  report.totalPlannedRuns = totalPlannedRuns
  const progress = createProgressReporter(totalPlannedRuns)

  debugLogger.log(`Running full-grid parameter sweep for: ${selectedModels.map((m) => m.id).join(', ')}`)
  debugLogger.log(`Addon source: ${addonSource}`)
  debugLogger.log(`Repeats per case: ${repeats}`)
  debugLogger.log(`Sweep dimensions: ${JSON.stringify(sweep)}`)
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

    const persistCaseResult = (caseResult) => {
      const line = {
        startedAt: report.startedAt,
        finishedAt: null,
        repeats: report.repeats,
        promptsCount: report.promptsCount,
        sweep: report.sweep,
        totalCases: report.totalCases,
        totalPlannedRuns: report.totalPlannedRuns,
        modelId: modelDef.id,
        source: modelDef.source,
        modelDir: modelDef.modelDir,
        caseId: caseResult.caseId,
        parameter: caseResult.parameter,
        value: caseResult.value,
        promptCase: caseResult.promptCase || null,
        quantization: caseResult.quantization,
        modelName: caseResult.modelName,
        runtimeConfig: caseResult.runtimeConfig,
        isBaseline: caseResult.isBaseline,
        metrics: caseResult.metrics,
        qualityMatch: caseResult.qualityMatch,
        promptResults: caseResult.promptResults || [],
        status: caseResult.status,
        repeatsAttempted: caseResult.repeatsAttempted,
        repeatsSucceeded: caseResult.repeatsSucceeded,
        promptErrorCount: caseResult.promptErrorCount,
        promptErrors: caseResult.promptErrors || [],
        error: caseResult.error || null
      }
      fs.appendFileSync(jsonlPath, `${JSON.stringify(line)}\n`)
      caseResults.push(caseResult)
    }

    for (let caseIndex = 0; caseIndex < cases.length; caseIndex++) {
      // Wrap each case in try-catch to prevent one case from crashing the entire benchmark
      const testCase = cases[caseIndex]
      const promptsForCase = [selectPromptForCase(prompts, testCase.runtimeConfig, testCase.promptCase)]
      const caseKey = `${modelDef.id}:${testCase.caseId}`
      if (completedCases.has(caseKey)) {
        const previousRecord = previousCaseRecords.get(caseKey) || null
        if (!previousRecord) {
          console.warn(`Progress marks case as complete but JSONL record is missing — re-running: ${caseKey}`)
          completedCases.delete(caseKey)
          // Fall through to run the case normally
        } else {
          seedBaselineCachesFromRecord(previousRecord, baselineOutputs, adaptiveBaselineOutputs)
          const resumed = {
            ...previousRecord,
            promptCase: previousRecord.promptCase || testCase.promptCase || null
          }
          persistCaseResult(resumed)
          debugLogger.log(`Skipping already completed case: ${caseKey}`)
          for (let promptIndex = 0; promptIndex < promptsForCase.length; promptIndex++) {
            for (let repeat = 1; repeat <= repeats; repeat++) {
              progress.tick({
                modelId: modelDef.id,
                caseIndex: caseIndex + 1,
                caseCount: cases.length,
                promptIndex: promptIndex + 1,
                promptCount: promptsForCase.length,
                repeat,
                repeats
              })
            }
          }
          continue
        }
      }
      let loader = null
      let model = null
      let modelLoaded = false
      let caseRepeatsAttempted = 0
      let caseRepeatsSucceeded = 0
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
            for (let promptIndex = 0; promptIndex < promptsForCase.length; promptIndex++) {
              for (let repeat = 1; repeat <= repeats; repeat++) {
                progress.tick({
                  modelId: modelDef.id,
                  caseIndex: caseIndex + 1,
                  caseCount: cases.length,
                  promptIndex: promptIndex + 1,
                  promptCount: promptsForCase.length,
                  repeat,
                  repeats
                })
              }
            }
            persistCaseResult({
              ...testCase,
              metrics: null,
              qualityMatch: null,
              promptResults: [],
              status: 'failed',
              repeatsAttempted: promptsForCase.length * repeats,
              repeatsSucceeded: 0,
              promptErrorCount: promptsForCase.length * repeats,
              promptErrors: promptsForCase.map((p) => ({
                promptId: p.id,
                error: truncateText(`VRAM_ERROR: ${errorMsg}`, 300),
                vramError: true
              })),
              error: {
                message: truncateText(`VRAM_ERROR: ${errorMsg}`, 300)
              }
            })
            completedCases.add(caseKey)
            saveProgress()
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
        const caseMetricSamples = {
          runMs: [],
          ttftMs: [],
          tps: []
        }
        let firstPromptTokens = null
        let firstGeneratedTokens = null
        for (let promptIndex = 0; promptIndex < promptsForCase.length; promptIndex++) {
          const prompt = promptsForCase[promptIndex]

          // Run repeats for this prompt
          const runMetrics = []
          let firstOutput = null
          let promptError = null

          for (let repeat = 1; repeat <= repeats; repeat++) {
            try {
              const runStart = process.hrtime()
              let timeToFirstToken = null
              const chunks = []
              const response = await model.run(prompt.messages)
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

              const metrics = {
                loadMs: null, // Model already loaded
                runMs: round(runMs, 3),
                unloadMs: null, // Will unload after all prompts
                ttftMs: round(ttftMs, 3),
                tps: round(stats.TPS != null ? stats.TPS : null, 3),
                promptTokens: stats.promptTokens ?? null,
                generatedTokens: stats.generatedTokens ?? null
              }

              runMetrics.push(metrics)
              caseMetricSamples.runMs.push(metrics.runMs)
              if (metrics.ttftMs != null) caseMetricSamples.ttftMs.push(metrics.ttftMs)
              if (metrics.tps != null) caseMetricSamples.tps.push(metrics.tps)
              if (firstPromptTokens == null && metrics.promptTokens != null) firstPromptTokens = metrics.promptTokens
              if (firstGeneratedTokens == null && metrics.generatedTokens != null) firstGeneratedTokens = metrics.generatedTokens
              caseRepeatsAttempted += 1
              caseRepeatsSucceeded += 1
              if (!firstOutput) {
                firstOutput = outputText
              }

              progress.tick({
                modelId: modelDef.id,
                caseIndex: caseIndex + 1,
                caseCount: cases.length,
                promptIndex: promptIndex + 1,
                promptCount: promptsForCase.length,
                repeat,
                repeats
              })

              // Add small delay between repeats (model stays loaded)
              if (repeat < repeats) {
                await new Promise(resolve => setTimeout(resolve, 50))
              }
            } catch (error) {
              promptError = error
              caseRepeatsAttempted += 1
              const errorMsg = error && error.message ? error.message : String(error)
              debugLogger.warn(`Case failed for prompt ${prompt.id} repeat ${repeat}: ${errorMsg}`)

              const isContextOverflow = errorMsg && /context|ctx[- ]?size|overflow/i.test(errorMsg)
              if (isContextOverflow) {
                await new Promise(resolve => setTimeout(resolve, 15000))
              }

              // Tick progress for the failed repeat and all remaining repeats
              for (let r = repeat; r <= repeats; r++) {
                progress.tick({
                  modelId: modelDef.id,
                  caseIndex: caseIndex + 1,
                  caseCount: cases.length,
                  promptIndex: promptIndex + 1,
                  promptCount: promptsForCase.length,
                  repeat: r,
                  repeats
                })
              }

              // Break out of repeat loop on error (can't continue with this prompt)
              break
            }
          }

          // Aggregate metrics across repeats (if any succeeded)
          if (runMetrics.length > 0) {
            const aggregated = aggregateRunMetrics(runMetrics)
            // Store load/unload times from first successful run (they're per-case, not per-repeat)
            aggregated.loadMsMean = null // Will be set after unload
            aggregated.unloadMsMean = null // Will be set after unload

            if (testCase.parameter === 'baseline') {
              baselineOutputs[prompt.id] = firstOutput
              const adaptiveKey = getAdaptiveBaselineKey(prompt.id)
              if (adaptiveKey) {
                adaptiveBaselineOutputs[adaptiveKey] = firstOutput
              }
            }

            let qualityMatch = null
            let baselineReference = null
            if (isAdaptivePromptId(prompt.id)) {
              const adaptiveKey = getAdaptiveBaselineKey(prompt.id)
              if (adaptiveKey) {
                if (testCase.parameter === 'baseline') {
                  baselineReference = firstOutput
                  qualityMatch = 1.0
                } else {
                  baselineReference = Object.prototype.hasOwnProperty.call(adaptiveBaselineOutputs, adaptiveKey)
                    ? adaptiveBaselineOutputs[adaptiveKey]
                    : null
                  qualityMatch = exactMatch(baselineReference, firstOutput)
                }
              }
            } else {
              if (testCase.parameter === 'baseline') {
                baselineReference = firstOutput
                qualityMatch = 1.0
              } else {
                baselineReference = Object.prototype.hasOwnProperty.call(baselineOutputs, prompt.id)
                  ? baselineOutputs[prompt.id]
                  : null
                qualityMatch = baselineReference == null
                  ? null
                  : exactMatch(baselineReference, firstOutput)
              }
            }

            promptResults.push({
              promptId: prompt.id,
              metrics: aggregated,
              qualityMatch,
              outputText: firstOutput,
              baselineReference
            })
          } else if (promptError) {
            // All repeats failed
            const errorMsg = promptError && promptError.message ? promptError.message : String(promptError)
            const isVramError = errorMsg.includes('VRAM_ERROR') || errorMsg.includes('VRAM') || errorMsg.includes('gpu-layers') || errorMsg.includes('failed to create context') || errorMsg.includes('UnableToLoadModel')

            promptResults.push({
              promptId: prompt.id,
              metrics: null,
              qualityMatch: null,
              error: errorMsg,
              errorStack: promptError && promptError.stack ? truncateText(promptError.stack, 1200) : null,
              vramError: isVramError
            })
          }

          // Add small delay between prompts (model stays loaded)
          if (promptIndex < promptsForCase.length - 1) {
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
            promptResult.metrics.loadMsMean = round(loadMs, 3)
            promptResult.metrics.loadMsStd = loadMs != null ? 0 : null
            promptResult.metrics.unloadMsMean = round(unloadMs, 3)
            promptResult.metrics.unloadMsStd = unloadMs != null ? 0 : null
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

        // Aggregate metrics across all successful prompt repeats in this case
        const successfulResults = promptResults.filter(p => p.metrics != null && !p.error)
        const aggregatedMetrics = successfulResults.length > 0
          ? {
              repeats,
              loadMsMean: round(loadMs, 3), // Load time is per-case
              loadMsStd: loadMs != null ? 0 : null,
              runMsMean: round(average(caseMetricSamples.runMs), 3),
              runMsStd: round(stddev(caseMetricSamples.runMs), 3),
              unloadMsMean: round(unloadMs, 3), // Unload time is per-case
              unloadMsStd: unloadMs != null ? 0 : null,
              ttftMsMean: round(average(caseMetricSamples.ttftMs), 3),
              ttftMsStd: round(stddev(caseMetricSamples.ttftMs), 3),
              tpsMean: round(average(caseMetricSamples.tps), 3),
              tpsStd: round(stddev(caseMetricSamples.tps), 3),
              promptTokens: firstPromptTokens,
              generatedTokens: firstGeneratedTokens
            }
          : null

        const avgQualityMatch = round(average(promptResults.filter(p => !p.error).map(p => p.qualityMatch).filter(x => x != null)), 6)
        const hasErrors = promptResults.some(p => p.error != null)
        const status = hasErrors
          ? (caseRepeatsSucceeded > 0 ? 'partial-failure' : 'failed')
          : 'ok'
        const promptErrors = compactPromptErrors(promptResults)
        const errorSummary = promptErrors.length > 0
          ? {
              message: truncateText(
                `${promptErrors.length} prompt error(s): ${promptErrors[0].error}`,
                300
              )
            }
          : null

        persistCaseResult({
          ...testCase,
          metrics: aggregatedMetrics,
          qualityMatch: avgQualityMatch,
          promptResults: promptResults.map((p) => ({
            promptId: p.promptId,
            metrics: p.metrics,
            qualityMatch: p.qualityMatch,
            outputText: typeof p.outputText === 'string' ? p.outputText : null,
            baselineReference: typeof p.baselineReference === 'string' ? p.baselineReference : null,
            error: p.error || null,
            vramError: Boolean(p.vramError)
          })),
          status,
          repeatsAttempted: caseRepeatsAttempted,
          repeatsSucceeded: caseRepeatsSucceeded,
          promptErrorCount: promptErrors.length,
          promptErrors,
          error: errorSummary
        })
        completedCases.add(caseKey)
        saveProgress()
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
        const remainingRepeats = Math.max(0, (promptsForCase.length * repeats) - caseRepeatsAttempted)
        for (let i = 0; i < remainingRepeats; i++) {
          progress.tick({
            modelId: modelDef.id,
            caseIndex: caseIndex + 1,
            caseCount: cases.length,
            promptIndex: promptsForCase.length,
            promptCount: promptsForCase.length,
            repeat: repeats,
            repeats
          })
        }
        persistCaseResult({
          ...testCase,
          metrics: null,
          qualityMatch: null,
          promptResults: [],
          status: 'failed',
          repeatsAttempted: caseRepeatsAttempted,
          repeatsSucceeded: caseRepeatsSucceeded,
          error: {
            message: truncateText(caseError.message || String(caseError), 300),
            stack: caseError.stack ? truncateText(caseError.stack, 1200) : null
          },
          promptErrorCount: 0,
          promptErrors: []
        })
        completedCases.add(caseKey)
        saveProgress()

        // Fail fast when the baseline case cannot initialize the model.
        // Continuing the full grid in this state only floods logs with the same fatal error.
        if (testCase.isBaseline) {
          const baselineError = caseError && caseError.message ? caseError.message : String(caseError)
          if (/Failed to initialize model|failed to load model/i.test(baselineError)) {
            throw new Error(
              `Baseline case failed to initialize model "${testCase.modelName}". ` +
              'Please re-prepare models and verify disk/free space before running the sweep again. ' +
              `Underlying error: ${baselineError}`
            )
          }
        }
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
  report.totalCompletedRuns = report.models.reduce((acc, model) => {
    const modelRuns = (model.cases || []).reduce((sum, item) => sum + Number(item.repeatsAttempted || 0), 0)
    return acc + modelRuns
  }, 0)

  isShuttingDown = true
  flushProgress()

  try {
    fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2))
    fs.writeFileSync(mdPath, toMarkdown(report))
    debugLogger.log('\nDone.')
    debugLogger.log(`JSON: ${jsonPath}`)
    debugLogger.log(`JSONL: ${jsonlPath}`)
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
  if (typeof moduleFlushProgress === 'function') {
    moduleFlushProgress()
  }
  console.error('Unhandled rejection in parameter sweep:')
  console.error(reason && reason.stack ? reason.stack : String(reason))
  console.error('Progress should be saved. Run again to resume.')
  process.exit(130)
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
