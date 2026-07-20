'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const process = require('bare-process')
const {
  elapsedMs,
  round,
  cartesianProduct,
  average,
  stddev
} = require('./math')

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

// ── Synthetic filler input ──────────────────────────────────────────────────
// This is a SPEED benchmark, so only the token count matters, not the content.
// We pad by characters as a rough proxy for token count: different models
// tokenize the same text differently, so a single ratio cannot land an exact
// token count for every model. The only invariant we need is that no sequence
// reaches its limit — the addon rejects a sequence whose token count reaches the
// batch size or the context — so we target a margin BELOW the sentence length
// with a conservative chars/token. The run records the real inputTokens. Sizing
// to a tokenizer-exact length would require a per-model tokenizer pass, which is
// out of scope for a throughput sweep.
const CHARS_PER_TOKEN = 4.1 // conservative; the current filler measures ~4.2
const TOKEN_SAFETY_MARGIN = 16
const FILLER_HEAD = 'Some input. '
const FILLER_UNIT = 'Some more input. '

function fillerForTokens (targetTokens) {
  const tokens = Math.max(1, targetTokens)
  const targetChars = Math.round(tokens * CHARS_PER_TOKEN)
  let s = FILLER_HEAD
  while (s.length < targetChars) s += FILLER_UNIT
  return s.slice(0, targetChars)
}

// Per-case input, derived from the batch size and the model's trained context:
//   ctx          = min(batchSize, trainedCtx) — the runtime context for the case
//   sentenceLen  = ctx — the longest sentence the model can process
//   nSentences   = floor(batchSize / sentenceLen), at least 1 — so the array of
//                  sentences fills the batch (1 when batch <= ctx; 2 for a
//                  4096-batch / 2048-ctx model; 4 at 8192-batch / 2048-ctx)
// floor (not round) guarantees nSentences * sentenceLen <= batchSize for any
// batch/ctx pair (e.g. a non-power-of-2 batch or an odd trained context), so the
// packed sentences can never overflow the batch. Each filler sentence is sized a
// safe margin UNDER sentenceLen tokens, so no single sentence reaches the
// context/batch limit either.
function deriveCaseInput (batchSize, trainedCtx) {
  const ctx = Math.min(batchSize, trainedCtx)
  const sentenceLen = ctx
  const nSentences = Math.max(1, Math.floor(batchSize / sentenceLen))
  const sentence = fillerForTokens(sentenceLen - TOKEN_SAFETY_MARGIN)
  const inputs = nSentences === 1 ? sentence : Array.from({ length: nSentences }, () => sentence)
  return { ctx, sentenceLen, nSentences, inputs }
}

function buildAddonConfig (runtimeConfig, options = {}) {
  const debugEnabled = !!options.debugEnabled
  const config = { verbosity: debugEnabled ? '2' : '0' }
  if (runtimeConfig.device != null) config.device = String(runtimeConfig.device)
  if (runtimeConfig.batchSize != null) config.batch_size = String(runtimeConfig.batchSize)
  if (runtimeConfig.ctx != null) config.ctx_size = String(runtimeConfig.ctx)
  if (runtimeConfig.flashAttn != null) config.flash_attn = String(runtimeConfig.flashAttn)
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
  const defaults = modelDef.defaults
  const supportedQuants = sweep.quantization
    .filter((quant) => !!resolveModelName(modelDef, quant))

  if (supportedQuants.length === 0) {
    throw new Error(`No supported quantizations found for model "${modelDef.id}"`)
  }

  const cases = []
  const combos = cartesianProduct([
    supportedQuants,
    sweep.device,
    sweep.batchSize,
    sweep.flashAttn
  ])

  for (const [quantization, device, batchSize, flashAttn] of combos) {
    cases.push({
      caseId: `${modelDef.id}__q=${quantization}__dev=${device}__bs=${batchSize}__fa=${flashAttn}`,
      parameter: 'full-grid',
      quantization,
      modelName: resolveModelName(modelDef, quantization),
      runtimeConfig: {
        ...defaults,
        device,
        batchSize,
        flashAttn
      }
    })
  }

  return cases
}

// The addon's prefill timer has ~millisecond resolution. A single short input
// prefills faster than it can measure, so the per-call prefill time can round to
// sub-millisecond. Treat prefill timing below this floor as unmeasured so the
// timing-derived metrics (ppTPS, latency) report null for those configs instead
// of a fabricated value.
const MIN_RELIABLE_PREFILL_MS = 1

function reliablePrefillMs (prefillMs) {
  return prefillMs != null && prefillMs >= MIN_RELIABLE_PREFILL_MS ? prefillMs : null
}

// Prefill throughput (ppTPS) computed from this repeat's own token count and
// prefill time. The addon's tokens_per_second is derived from cumulative
// counters (see the delta handling in runCaseWithRepeats) and is not per-call,
// so it is not used here.
function prefillTokensPerSecond (deltaTokens, prefillMs) {
  if (deltaTokens == null || deltaTokens <= 0 || prefillMs == null || prefillMs <= 0) return null
  return (deltaTokens * 1000) / prefillMs
}

// Load the model once, run a tiny input with stats on, read the model's trained
// context size, then unload. Sizing every case's input off this means the filler
// is always within the model's real context — no per-model cap. Returns null on
// any failure; the caller falls back to treating trainedCtx as the batch size.
async function probeTrainedContext ({ AddonCtor, modelDir, modelName, debugEnabled }) {
  const addonConfig = buildAddonConfig({ device: 'gpu' }, { debugEnabled })
  const addonRuntimeLogger = createAddonRuntimeLogger(debugEnabled)
  let model = null
  try {
    model = new AddonCtor({
      files: { model: [path.join(modelDir, modelName)] },
      config: addonConfig,
      logger: addonRuntimeLogger,
      opts: { stats: true }
    })
    await model.load()
    const response = await model.run('probe')
    await response.await()
    const trained = response.stats && response.stats.trained_context_size
    return typeof trained === 'number' && trained > 0 ? trained : null
  } catch (_) {
    return null
  } finally {
    try {
      if (model) await model.unload()
    } catch (_) { /* probe is best-effort */ }
  }
}

// Embedding is a single forward pass (prefill only), so every metric here is a
// prefill or end-to-end quantity — there is no decode phase. The renderer reads:
//   ppTpsMean/ppTpsStd          prefill tokens/sec (per-repeat delta)
//   latencyMsMean/latencyMsStd  prefill time in ms (per-repeat delta)
//   inputTokens                 tokens fed to the model for this case
// loadMs/runMs/unloadMs are kept for the legacy .jsonl/.md reporters.
function aggregateRunMetrics (runMetrics) {
  const repeatsSucceeded = runMetrics.length
  if (repeatsSucceeded === 0) {
    return {
      repeats: 0,
      loadMs: null,
      runMs: null,
      unloadMs: null,
      tps: null,
      ppTpsMean: null,
      ppTpsStd: null,
      latencyMsMean: null,
      latencyMsStd: null,
      inputTokens: null
    }
  }

  const wallMsValues = runMetrics.map((x) => x.wallMs).filter((x) => x != null)
  const prefillMsValues = runMetrics.map((x) => x.prefillMs).filter((x) => x != null)
  const ppTpsValues = runMetrics.map((x) => x.ppTps).filter((x) => x != null)
  const inputTokens = runMetrics.find((x) => x.totalTokens != null)?.totalTokens ?? null

  return {
    repeats: repeatsSucceeded,
    loadMs: round(runMetrics[0].loadMs, 3),
    runMs: wallMsValues.length ? round(average(wallMsValues), 3) : null,
    unloadMs: round(runMetrics[0].unloadMs, 3),
    tps: ppTpsValues.length ? round(average(ppTpsValues), 3) : null,
    ppTpsMean: ppTpsValues.length ? round(average(ppTpsValues), 3) : null,
    ppTpsStd: ppTpsValues.length ? round(stddev(ppTpsValues), 3) : null,
    latencyMsMean: prefillMsValues.length ? round(average(prefillMsValues), 3) : null,
    latencyMsStd: prefillMsValues.length ? round(stddev(prefillMsValues), 3) : null,
    inputTokens
  }
}

async function runCaseWithRepeats ({ AddonCtor, modelDir, modelName, runtimeConfig, inputs, repeats, onRepeatComplete, debugEnabled }) {
  const addonConfig = buildAddonConfig(runtimeConfig, { debugEnabled })
  const addonRuntimeLogger = createAddonRuntimeLogger(debugEnabled)

  let model = null
  let loadMs = null
  let unloadMs = null
  let producedEmbeddings = false
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

    // The addon's total_time_ms / total_tokens are CUMULATIVE for the context's
    // lifetime (llama_perf_context, never reset between run() calls), so each
    // measured repeat must report the delta since the previous run, not the raw
    // counter. These track the running totals; they are seeded from the warmup.
    let prevCumulativeMs = 0
    let prevCumulativeTokens = 0

    // Warmup run (discarded) so the first measured repeat isn't skewed by
    // cold-start graph build / GPU kernel warmup. Seeding the cumulative
    // baseline from it means the first measured delta excludes the warmup.
    // Mirrors the LLM desktop sweep and the mobile runner's warmup.
    try {
      const warmup = await model.run(inputs)
      await warmup.await()
      if (warmup.stats) {
        if (warmup.stats.total_time_ms != null) prevCumulativeMs = warmup.stats.total_time_ms
        if (warmup.stats.total_tokens != null) prevCumulativeTokens = warmup.stats.total_tokens
      }
    } catch (_) { /* measured runs below surface any real error */ }

    for (let repeat = 1; repeat <= repeats; repeat++) {
      try {
        const runStart = process.hrtime()
        const response = await model.run(inputs)
        const rawEmbeddings = await response.await()
        const wallMs = elapsedMs(runStart)
        const runtimeStats = response.stats
        // total_time_ms / total_tokens are cumulative; this repeat's own cost is
        // the delta since the previous run. Advance the baseline here, BEFORE
        // validating the embeddings: the addon counter advanced whether or not
        // the response validates, so a throw below must not leave the next rep's
        // delta double-counting this run. ppTPS = prefill tokens/sec; prefillMs =
        // prefill time; wallMs = end-to-end run latency. Embedding is a single
        // forward pass, so there is no decode phase and no generated-token metric.
        const cumulativeMs = runtimeStats.total_time_ms
        const cumulativeTokens = runtimeStats.total_tokens
        const deltaMs = cumulativeMs != null ? cumulativeMs - prevCumulativeMs : null
        const deltaTokens = cumulativeTokens != null ? cumulativeTokens - prevCumulativeTokens : null
        if (cumulativeMs != null) prevCumulativeMs = cumulativeMs
        if (cumulativeTokens != null) prevCumulativeTokens = cumulativeTokens
        // Validate the run produced a well-formed embedding response so a
        // silently-empty run is treated as a failure, not a 0-metric success.
        normalizeEmbeddings(rawEmbeddings)
        producedEmbeddings = true
        const prefillMs = reliablePrefillMs(deltaMs)
        runMetrics.push({
          loadMs,
          prefillMs,
          wallMs,
          ppTps: prefillMs != null ? prefillTokensPerSecond(deltaTokens, prefillMs) : null,
          totalTokens: deltaTokens,
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

      // Small settle delay between repeats (model stays loaded) so consecutive
      // measured runs don't contend and skew the mean ± stddev. Mirrors the LLM
      // sweep's inter-repeat delay.
      if (repeat < repeats) {
        await new Promise((resolve) => setTimeout(resolve, 50))
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
    producedEmbeddings,
    errors,
    repeatsAttempted: repeats,
    repeatsSucceeded: runMetrics.length
  }
}

function buildCaseResult ({
  testCase,
  executionResult,
  repeats,
  failureMessage
}) {
  if (failureMessage) {
    return {
      ...testCase,
      metrics: null,
      status: 'failed',
      repeatsAttempted: repeats,
      repeatsSucceeded: 0,
      error: {
        message: failureMessage
      }
    }
  }

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
  progress
}) {
  debugLogger.log(`\n=== ${modelDef.id} ===`)
  debugLogger.log(`Cases to run: ${cases.length}`)

  // Probe the model's trained context once before its cases, so every case's
  // input is sized to a length the model can actually hold. Use the first case's
  // model file (the model is the same across quants for context purposes; any
  // available quant works). If the probe fails, fall back to treating the trained
  // context as the batch size (ctx = batchSize, single sentence) per case.
  let trainedCtx = null
  let probeNote = null
  const probeCase = cases.find((c) =>
    c.modelName && checkModelExists(modelDef.modelDir, c.modelName))
  if (probeCase) {
    trainedCtx = await probeTrainedContext({
      AddonCtor,
      modelDir: modelDef.modelDir,
      modelName: probeCase.modelName,
      debugEnabled
    })
  }
  if (trainedCtx == null) {
    probeNote = 'trained-context probe failed; sizing inputs to batch size (ctx = batchSize)'
    debugLogger.warn(`${modelDef.id}: ${probeNote}`)
  } else {
    debugLogger.log(`${modelDef.id}: trained context = ${trainedCtx}`)
  }

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
      const batchSize = testCase.runtimeConfig.batchSize
      // No probe value -> treat the trained context as the batch size, so the
      // case runs a single sentence sized to the batch.
      const effectiveCtx = trainedCtx == null ? batchSize : trainedCtx
      const derived = deriveCaseInput(batchSize, effectiveCtx)
      testCase.runtimeConfig.ctx = derived.ctx
      testCase.derived = {
        ctx: derived.ctx,
        sentenceLen: derived.sentenceLen,
        nSentences: derived.nSentences,
        probeNote
      }

      executionResult = await runCaseWithRepeats({
        AddonCtor,
        modelDir: modelDef.modelDir,
        modelName: testCase.modelName,
        runtimeConfig: testCase.runtimeConfig,
        inputs: derived.inputs,
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
      repeats,
      failureMessage
    })
    caseResults.push(caseResult)

    // Fail fast when the first case cannot initialize the model. Continuing the
    // full grid in this state only floods logs with the same fatal error.
    if (failureMessage && caseIndex === 0 &&
        /UnableToLoadModel|Failed to initialize model|failed to load model|failed to create context/i.test(failureMessage)) {
      throw new Error(
        `First case failed to initialize model "${testCase.modelName}". ` +
        'Please re-prepare models and verify disk/free space before running the sweep again. ' +
        `Underlying error: ${failureMessage}`
      )
    }
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
