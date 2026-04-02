import { getModel } from "@/server/bare/registry/model-registry";
import {
  translateServerParamsSchema,
  normalizeModelType,
  ModelType,
  type TranslateParams,
  type TranslationStats,
  AFRICAN_LANGUAGES_MAP,
} from "@/schemas";
import type TranslationNmtcpp from "@qvac/translation-nmtcpp";
import { getLangName } from "@qvac/langdetect-text";
import { nowMs } from "@/profiling";
import { buildStreamResult } from "@/profiling/model-execution";
import type { NmtResponse, LlmResponse } from "@/server/bare/types/addon-responses";

export function getLanguage(code: string | undefined): string {
  if (!code) return "";
  if (AFRICAN_LANGUAGES_MAP.has(code)) return AFRICAN_LANGUAGES_MAP.get(code)!;
  const fullName = getLangName(code);
  return fullName ?? code.toUpperCase();
}

export function isAfrican(code: string | undefined) {
  return !!code && AFRICAN_LANGUAGES_MAP.has(code);
}

export async function* translate(
  params: TranslateParams,
): AsyncGenerator<string, { modelExecutionMs: number; stats?: TranslationStats }, unknown> {
  const { modelId, text, modelType: inputModelType } = params;
  const canonicalModelType = normalizeModelType(inputModelType);
  const isLlm = canonicalModelType === ModelType.llamacppCompletion;
  const from = isLlm ? (params as { from?: string }).from : undefined;
  const to = isLlm ? (params as { to: string }).to : undefined;
  const context = isLlm ? (params as { context?: string }).context : undefined;
  const afriquePrompt = isLlm && (isAfrican(from) || isAfrican(to));
  translateServerParamsSchema.parse(params);

  const model = getModel(modelId);

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
  const response = await model.run(input);

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
