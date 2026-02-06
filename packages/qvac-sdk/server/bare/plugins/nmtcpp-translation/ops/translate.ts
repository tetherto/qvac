import { getModel } from "@/server/bare/registry/model-registry";
import {
  translateServerParamsSchema,
  normalizeModelType,
  ModelType,
  type TranslateParams,
  type TranslationStats,
} from "@/schemas";
import { getLangName } from "@qvac/langdetect-text";
import type TranslationNmtcpp from "@qvac/translation-nmtcpp";

function getLanguage(code: string | undefined): string {
  if (!code) return "";
  const fullName = getLangName(code);
  return fullName ?? code.toUpperCase();
}

export async function* translate(
  params: TranslateParams,
): AsyncGenerator<string, TranslationStats | undefined, unknown> {
  const { modelId, text, modelType: inputModelType } = params;
  const canonicalModelType = normalizeModelType(inputModelType);
  const isLlm = canonicalModelType === ModelType.llamacppCompletion;
  const from = isLlm ? (params as { from?: string }).from : undefined;
  const to = isLlm ? (params as { to: string }).to : undefined;
  const context = isLlm ? (params as { context?: string }).context : undefined;
  translateServerParamsSchema.parse(params);

  const model = getModel(modelId);

  const fromLanguage = getLanguage(from);
  const toLanguage = getLanguage(to);

  const startTime = Date.now();
  let processedTokens = 0;

  // Check if input is an array and model type is NMT
  if (
    Array.isArray(text) &&
    canonicalModelType === ModelType.nmtcppTranslation
  ) {
    // Use runBatch for batch processing
    const translations = await (model as unknown as TranslationNmtcpp).runBatch(
      text,
    );

    // Yield each translation with a newline separator
    for (const translation of translations) {
      processedTokens++;
      yield translation;
      if (translations.indexOf(translation) < translations.length - 1) {
        yield "\n";
      }
    }

    const endTime = Date.now();
    return {
      processedTokens,
      processingTime: endTime - startTime,
    };
  }

  // Single text processing (for NMT or LLM)
  const singleText = Array.isArray(text) ? text[0] : text;

  // Prepare input based on model type
  const input =
    canonicalModelType === ModelType.nmtcppTranslation
      ? singleText
      : [
          {
            role: "system",
            content: `${context ? `${context}. ` : ""}Translate the following text from ${fromLanguage} into ${toLanguage}. Only output the translation, nothing else.\n\n${fromLanguage}: ${singleText}\n${toLanguage}:`,
          },
        ];

  const response = await model.run(input);

  // Check if the response has an iterate method (like LLM models)
  if (
    canonicalModelType === ModelType.llamacppCompletion &&
    typeof response.iterate === "function"
  ) {
    for await (const token of response.iterate()) {
      processedTokens++;
      yield token as string;
    }
  } else {
    // For models that don't support iterate, create an async iterator using onUpdate
    const tokenQueue: string[] = [];
    let isComplete = false;
    let resolveNext: ((value: IteratorResult<string>) => void) | null = null;

    // Start the response processing
    const responsePromise = response
      .onUpdate((data: string) => {
        processedTokens++;

        if (resolveNext) {
          // If there's a pending read, resolve it immediately
          resolveNext({ value: data, done: false });
          resolveNext = null;
        } else {
          // Otherwise, queue the token
          tokenQueue.push(data);
        }
      })
      .await()
      .then(() => {
        isComplete = true;
        if (resolveNext) {
          resolveNext({ value: undefined, done: true });
          resolveNext = null;
        }
      });

    // Create an async iterator
    const asyncIterator = {
      async next(): Promise<IteratorResult<string>> {
        if (tokenQueue.length > 0) {
          return { value: tokenQueue.shift()!, done: false };
        }

        if (isComplete) {
          return { value: undefined, done: true };
        }

        // Wait for the next token
        return new Promise<IteratorResult<string>>((resolve) => {
          resolveNext = resolve;
        });
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };

    // Yield tokens as they come
    for await (const token of asyncIterator) {
      yield token;
    }

    // Ensure the response is fully processed
    await responsePromise;
  }

  const endTime = Date.now();
  return {
    processedTokens,
    processingTime: endTime - startTime,
  };
}
