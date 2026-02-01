import { getModel } from "@/server/bare/registry/model-registry";
import {
  translateServerParamsSchema,
  type TranslateParams,
  type TranslationStats,
} from "@/schemas";
import { getLangName } from "@qvac/langdetect-text";

function getLanguage(code: string | undefined): string {
  if (!code) return "";
  const fullName = getLangName(code);
  return fullName ?? code.toUpperCase();
}

export async function* translate(
  params: TranslateParams,
): AsyncGenerator<string, TranslationStats | undefined, unknown> {
  const { modelId, text, modelType } = params;
  const from = params.modelType === "llm" ? params.from : undefined;
  const to = params.modelType === "llm" ? params.to : undefined;
  const context = params.modelType === "llm" ? params.context : undefined;
  translateServerParamsSchema.parse(params);

  const model = getModel(modelId);

  const fromLanguage = getLanguage(from);
  const toLanguage = getLanguage(to);

  // Prepare input based on model type
  const input =
    modelType === "nmt"
      ? text
      : [
          {
            role: "system",
            content: `${context ? `${context}. ` : ""}Translate the following text from ${fromLanguage} into ${toLanguage}. Only output the translation, nothing else.\n\n${fromLanguage}: ${text}\n${toLanguage}:`,
          },
        ];

  const startTime = Date.now();
  let processedTokens = 0;
  const response = await model.run(input);

  // Check if the response has an iterate method (like LLM models)
  if (modelType === "llm" && typeof response.iterate === "function") {
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
