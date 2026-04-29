import { getModelEntry } from "@/server/bare/registry/model-registry";
import {
  translateServerParamsSchema,
  normalizeModelType,
  ModelType,
  type TranslateParams,
  type TranslationStats,
  AFRICAN_LANGUAGES_MAP,
} from "@/schemas";
import type TranslationNmtcpp from "@qvac/translation-nmtcpp";
import type { GenerationParams, RunOptions } from "@qvac/llm-llamacpp";
import { getLangName } from "@qvac/langdetect-text";
import { nowMs } from "@/profiling";
import { buildStreamResult } from "@/profiling/model-execution";
import type { NmtResponse, LlmResponse } from "@/server/bare/types/addon-responses";
import {
  ModelIsDelegatedError,
  ModelNotFoundError,
  ModelTypeMismatchError,
} from "@/utils/errors-server";

export function getLanguage(code: string | undefined): string {
  if (!code) return "";
  if (AFRICAN_LANGUAGES_MAP.has(code)) return AFRICAN_LANGUAGES_MAP.get(code)!;
  const fullName = getLangName(code);
  return fullName ?? code.toUpperCase();
}

export function isAfrican(code: string | undefined) {
  return !!code && AFRICAN_LANGUAGES_MAP.has(code);
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
  Pick<
    GenerationParams,
    "temp" | "top_k" | "top_p" | "repeat_penalty" | "seed" | "predict"
  >
>;

const LLM_TRANSLATE_GENERATION_PARAMS: LlmTranslateGenerationParams = {
  temp: 0,
  top_k: 1,
  top_p: 1,
  repeat_penalty: 1.3,
  seed: 42,
  predict: 256,
};

function shouldSkipPerCallSampling(modelName: string | undefined): boolean {
  return !!modelName && modelName.startsWith("AFRICAN_");
}

export async function* translate(
  params: TranslateParams,
): AsyncGenerator<string, { modelExecutionMs: number; stats?: TranslationStats }, unknown> {
  const { modelId, text, modelType: inputModelType } = params;

  const entry = getModelEntry(modelId);
  if (!entry) {
    throw new ModelNotFoundError(modelId);
  }
  if (entry.isDelegated) {
    throw new ModelIsDelegatedError(modelId);
  }
  const canonicalModelType = entry.local.modelType;
  const model = entry.local.model;

  if (inputModelType !== undefined) {
    const requestedCanonical = normalizeModelType(inputModelType);
    if (requestedCanonical !== canonicalModelType) {
      throw new ModelTypeMismatchError(canonicalModelType, requestedCanonical);
    }
  }

  const isLlm = canonicalModelType === ModelType.llamacppCompletion;
  const from = isLlm ? (params as { from?: string }).from : undefined;
  const to = isLlm ? (params as { to: string }).to : undefined;
  const context = isLlm ? (params as { context?: string }).context : undefined;
  const afriquePrompt = isLlm && (isAfrican(from) || isAfrican(to));
  translateServerParamsSchema.parse(params);

  const fromLanguage = getLanguage(from);
  const toLanguage = getLanguage(to);

  // Check if input is an array and model type is NMT
  if (
    Array.isArray(text) &&
    canonicalModelType === ModelType.nmtcppTranslation
  ) {
    // Use runBatch for batch processing
    const modelStart = nowMs();
    const translations = await (model as unknown as TranslationNmtcpp).runBatch(
      text,
    );
    const modelExecutionMs = nowMs() - modelStart;

    // Yield each translation with a newline separator
    for (let i = 0; i < translations.length; i++) {
      const translation = translations[i]!;
      yield translation;
      if (i < translations.length - 1) {
        yield "\n";
      }
    }

    return { modelExecutionMs };
  }

  // Single text processing (for NMT or LLM)
  const singleText = Array.isArray(text) ? text[0] : text;

  // Prepare input based on model type
  const input =
    canonicalModelType === ModelType.nmtcppTranslation
      ? singleText
      : [
          {
            role: afriquePrompt ? "user" : "system",
            content: afriquePrompt
              ? `Translate ${fromLanguage} to ${toLanguage}.\n${fromLanguage}: ${singleText}\n${toLanguage}:`
              : `${context ? `${context}. ` : ""}Translate the following text from ${fromLanguage} into ${toLanguage}. Only output the translation, nothing else.\n\n${fromLanguage}: ${singleText}\n${toLanguage}:`,
          },
        ];

  const modelStart = nowMs();
  let response;
  if (
    canonicalModelType === ModelType.llamacppCompletion &&
    !shouldSkipPerCallSampling(entry.local.name)
  ) {
    // AnyModel.run is intentionally erased to a single-arg signature in the
    // registry layer (Omit<BaseInference, "addon">). Re-narrow to the engine
    // shape so we get the same typing as @qvac/llm-llamacpp.run().
    const llmRun = model.run.bind(model) as (
      prompt: typeof input,
      opts: RunOptions,
    ) => ReturnType<typeof model.run>;
    response = await llmRun(input, {
      generationParams: LLM_TRANSLATE_GENERATION_PARAMS,
    });
  } else {
    response = await model.run(input);
  }

  // Check if the response has an iterate method (like LLM models)
  if (
    canonicalModelType === ModelType.llamacppCompletion &&
    typeof response.iterate === "function"
  ) {
    const llmResponse = response as unknown as LlmResponse;
    for await (const token of llmResponse.iterate()) {
      yield token;
    }
    const modelExecutionMs = nowMs() - modelStart;

    const stats: TranslationStats = {
      ...(llmResponse.stats?.TPS !== undefined && { tokensPerSecond: llmResponse.stats.TPS }),
      ...(llmResponse.stats?.TTFT !== undefined && { timeToFirstToken: llmResponse.stats.TTFT }),
      ...(llmResponse.stats?.CacheTokens !== undefined && { cacheTokens: llmResponse.stats.CacheTokens }),
      ...(llmResponse.stats?.generatedTokens !== undefined && { totalTokens: llmResponse.stats.generatedTokens }),
    };

    return buildStreamResult(modelExecutionMs, stats);
  }

  const nmtResponse = response as unknown as NmtResponse;
  for await (const token of nmtResponse.iterate()) {
    yield token;
  }
  const modelExecutionMs = nowMs() - modelStart;

  const stats: TranslationStats = {
    ...(nmtResponse.stats?.totalTime !== undefined && { totalTime: nmtResponse.stats.totalTime }),
    ...(nmtResponse.stats?.totalTokens !== undefined && { totalTokens: nmtResponse.stats.totalTokens }),
    ...(nmtResponse.stats?.decodeTime !== undefined && { decodeTime: nmtResponse.stats.decodeTime }),
    ...(nmtResponse.stats?.encodeTime !== undefined && { encodeTime: nmtResponse.stats.encodeTime }),
    ...(nmtResponse.stats?.TPS !== undefined && { tokensPerSecond: nmtResponse.stats.TPS }),
    ...(nmtResponse.stats?.TTFT !== undefined && { timeToFirstToken: nmtResponse.stats.TTFT }),
  };

  return buildStreamResult(modelExecutionMs, stats);
}
