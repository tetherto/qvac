import { getModelEntry } from '@/runtime/model-registry'
import {
  translateServerParamsSchema,
  normalizeModelType,
  ModelType,
  type TranslateParams,
  type TranslationStats,
  AFRICAN_LANGUAGES_MAP
} from '@/schemas/index'
import type TranslationNmtcpp from '@qvac/translation-nmtcpp'
import type { GenerationParams } from '@qvac/llm-llamacpp'
import { getLangName, detectOne } from '@qvac/langdetect-text'
import { nowMs } from '@/profiling/index'
import { buildStreamResult } from '@/profiling/model-execution'
import type { NmtResponse, LlmResponse } from '@/utils/addon-responses'
import { buildNmtTranslationStats } from '@/plugins/ops/translate-stats'
import { ModelNotFoundError, ModelTypeMismatchError, TranslationFailedError } from '@/errors/index'
import { getRequestRegistry, withRequestContext } from '@/runtime/index'
import { isAddonContextOverflowError } from '@/plugins/builtin/llamacpp-completion/ops/context-overflow'
import { generateRandomRequestId } from '@/runtime/request-id'
import { getModelParallel } from '@/utils/config-transform'
import { getEngineLogger } from '@/logging/index'

export function getLanguage(code: string | undefined): string {
  if (!code) return ''
  if (AFRICAN_LANGUAGES_MAP.has(code)) return AFRICAN_LANGUAGES_MAP.get(code)!
  const fullName = getLangName(code)
  return fullName ?? code.toUpperCase()
}

export function isAfrican(code: string | undefined) {
  return !!code && AFRICAN_LANGUAGES_MAP.has(code)
}

// Per-call sampling overrides applied to LLM translate. Greedy + fixed seed
// makes output reproducible across calls; bounded predict prevents a runaway
// from accumulating into the KV cache and overflowing ctx_size on a later
// call; repeat_penalty > 1 breaks single-token echo loops (e.g. greedy
// continuation of "bank" → "bank\nbank\n…").
//
// Skipped for AfriqueGemma: that model relies on load-time `stop_sequences`
// and a `repeat_penalty` of 1 — applying these per-call values causes "\n"
// to be penalised, defeats the stop, and lets the model run to `predict`.
// AfriqueGemma callers must set decoding via `modelConfig` at load time.
type LlmTranslateGenerationParams = Required<
  Pick<GenerationParams, 'temp' | 'top_k' | 'top_p' | 'repeat_penalty' | 'seed' | 'predict'>
>

const LLM_TRANSLATE_GENERATION_PARAMS: LlmTranslateGenerationParams = {
  temp: 0,
  top_k: 1,
  top_p: 1,
  repeat_penalty: 1.3,
  seed: 42,
  predict: 256
}

function shouldSkipPerCallSampling(modelName: string | undefined): boolean {
  return !!modelName && modelName.startsWith('AFRICAN_')
}

export async function* translate(
  params: TranslateParams,
  requestId?: string
): AsyncGenerator<string, { modelExecutionMs: number; stats?: TranslationStats }, unknown> {
  const { modelId, text, modelType: inputModelType } = params

  const entry = getModelEntry(modelId)
  if (!entry) {
    throw new ModelNotFoundError(modelId)
  }
  const canonicalModelType = entry.local.modelType
  const model = entry.local.model

  if (inputModelType !== undefined) {
    const requestedCanonical = normalizeModelType(inputModelType)
    if (requestedCanonical !== canonicalModelType) {
      throw new ModelTypeMismatchError(canonicalModelType, requestedCanonical)
    }
  }

  const isLlm = canonicalModelType === ModelType.llamacppCompletion
  let from = isLlm ? (params as { from?: string }).from : undefined
  const to = isLlm ? (params as { to: string }).to : undefined
  const context = isLlm ? (params as { context?: string }).context : undefined

  translateServerParamsSchema.parse(params)

  // Auto-detect the source language when the caller didn't pass `from` (LLM
  // only). This used to run in each client; moving it here gives every
  // language binding one detector instead of each shipping its own (lingua in
  // Python vs langdetect-text in JS drifted on the same input). Store the
  // detected code — not the language name — so the explicit-`from` and
  // detected paths feed getLanguage() identically.
  if (isLlm && !from) {
    const detected = detectOne(text as string)
    if (detected.code === 'und' || detected.language === 'Undetermined') {
      throw new TranslationFailedError(
        "Could not detect the source language. Please specify the 'from' parameter explicitly."
      )
    }
    from = detected.code
  }

  const afriquePrompt = isLlm && (isAfrican(from) || isAfrican(to))

  const fromLanguage = getLanguage(from)
  const toLanguage = getLanguage(to)

  // Open a request-scoped lifecycle for both engine branches. The LLM
  // path cancels only its own run response (wired below), so a peer
  // completion on the same model keeps running; NMT-translate has no
  // addon cancel — the loop exits on `signal.aborted`, scope unwinds,
  // and the addon may run to completion in the background, which is
  // fine because the result is dropped either way.
  await using ctx = await getRequestRegistry().begin({
    requestId: requestId ?? generateRandomRequestId(),
    kind: 'translate',
    modelId,
    // LLM translate joins the completion lane (its cap = the model's own
    // `parallel`); NMT passes no cap and stays ungated on its own model.
    ...(isLlm && {
      maxConcurrentPerModel: getModelParallel(entry.local.config as { parallel?: number })
    })
  })
  const requestLogger = withRequestContext(getEngineLogger(), ctx)

  // Cancel only this run's response, not the addon's global cancel, so a peer
  // completion keeps running.
  let activeResponse: { cancel(): Promise<void> } | null = null
  const cancelActive = () => {
    activeResponse?.cancel().catch((err: unknown) => {
      requestLogger.warn(
        `[cancel] translate response.cancel() rejected during abort for modelId=${modelId}: ${err instanceof Error ? err.message : String(err)}`
      )
    })
  }
  if (isLlm) {
    ctx.signal.addEventListener('abort', cancelActive, { once: true })
    if (ctx.signal.aborted) cancelActive()
    ctx.scope.defer(() => {
      ctx.signal.removeEventListener('abort', cancelActive)
      activeResponse = null
    })
  }

  // Check if input is an array and model type is NMT
  if (Array.isArray(text) && canonicalModelType === ModelType.nmtcppTranslation) {
    // A cancel that landed before native work (e.g. the model is being unloaded)
    // must not start the batch. Bail before runBatch, dropping the result.
    if (ctx.signal.aborted) {
      return { modelExecutionMs: 0 }
    }
    // Use runBatch for batch processing
    const modelStart = nowMs()
    const translations = await (model as unknown as TranslationNmtcpp).runBatch(text)
    const modelExecutionMs = nowMs() - modelStart

    // Soft-cancel boundary: if `cancel({ requestId })` landed while
    // the addon was running the batch, bail before yielding anything.
    // The addon may have completed its work; the result is dropped.
    if (ctx.signal.aborted) {
      return { modelExecutionMs }
    }

    // Yield each translation with a newline separator
    for (let i = 0; i < translations.length; i++) {
      if (ctx.signal.aborted) break
      const translation = translations[i]!
      yield translation
      if (i < translations.length - 1) {
        yield '\n'
      }
    }

    return { modelExecutionMs }
  }

  // Single text processing (for NMT or LLM)
  const singleText = Array.isArray(text) ? text[0] : text

  // Prepare input based on model type
  const input =
    canonicalModelType === ModelType.nmtcppTranslation
      ? singleText
      : [
          {
            role: afriquePrompt ? 'user' : 'system',
            content: afriquePrompt
              ? `Translate ${fromLanguage} to ${toLanguage}.\n${fromLanguage}: ${singleText}\n${toLanguage}:`
              : `${context ? `${context}. ` : ''}Translate the following text from ${fromLanguage} into ${toLanguage}. Only output the translation, nothing else.\n\n${fromLanguage}: ${singleText}\n${toLanguage}:`
          }
        ]

  // A translate cancelled before native work (queued-cancel, or the model being
  // unloaded) must not call run(): LLM could decode against an exclusive finetune
  // holding the lane, and either engine would run against a model being torn
  // down. Bail with an empty soft-cancel result for both engines — the server
  // never throws InferenceCancelledError (that error is client-constructed and
  // would cross the RPC as a generic error).
  if (ctx.signal.aborted) {
    return { modelExecutionMs: 0 }
  }

  const modelStart = nowMs()
  let response
  if (
    canonicalModelType === ModelType.llamacppCompletion &&
    !shouldSkipPerCallSampling(entry.local.name)
  ) {
    response = await model.run(input, {
      generationParams: LLM_TRANSLATE_GENERATION_PARAMS
    })
  } else {
    response = await model.run(input)
  }
  if (isLlm) {
    activeResponse = response
    // A cancel that landed while `run(...)` was admitting still applies.
    if (ctx.signal.aborted) cancelActive()
  }

  // Check if the response has an iterate method (like LLM models)
  if (
    canonicalModelType === ModelType.llamacppCompletion &&
    typeof response.iterate === 'function'
  ) {
    const llmResponse = response as unknown as LlmResponse
    try {
      for await (const token of llmResponse.iterate()) {
        if (ctx.signal.aborted) break
        yield token
      }
    } catch (err) {
      // A context-overflow rejection is a real terminal condition, not a
      // cancellation — surface it even under an aborted signal, as completion does.
      if (isAddonContextOverflowError(err)) throw err
      // The request signal is the SDK-owned cancellation contract. Addon
      // rejection shapes differ for active and queued native sequences, so once
      // cancellation is accepted the translate ends cleanly regardless of that
      // transport detail; without an abort, every error still propagates.
      if (!ctx.signal.aborted) throw err
    }
    const modelExecutionMs = nowMs() - modelStart

    const stats: TranslationStats = {
      ...(llmResponse.stats?.TPS !== undefined && { tokensPerSecond: llmResponse.stats.TPS }),
      ...(llmResponse.stats?.TTFT !== undefined && { timeToFirstToken: llmResponse.stats.TTFT }),
      ...(llmResponse.stats?.CacheTokens !== undefined && {
        cacheTokens: llmResponse.stats.CacheTokens
      }),
      ...(llmResponse.stats?.generatedTokens !== undefined && {
        totalTokens: llmResponse.stats.generatedTokens
      })
    }

    return buildStreamResult(modelExecutionMs, stats)
  }

  const nmtResponse = response as unknown as NmtResponse
  for await (const token of nmtResponse.iterate()) {
    if (ctx.signal.aborted) break
    yield token
  }
  const modelExecutionMs = nowMs() - modelStart

  const stats = buildNmtTranslationStats(nmtResponse.stats)

  return buildStreamResult(modelExecutionMs, stats)
}
