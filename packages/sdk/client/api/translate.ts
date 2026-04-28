import { stream as streamRpc } from "@/client/rpc/rpc-client";
import {
  translateResponseSchema,
  normalizeModelType,
  ModelType,
  type TranslateRequest,
  type TranslateClientParams,
  type TranslationStats,
  type RPCOptions,
} from "@/schemas";
import { detectOne } from "@qvac/langdetect-text";
import { TranslationFailedError } from "@/utils/errors-client";

/**
 * Translates text from one language to another using a specified translation model.
 * Supports both NMT (Neural Machine Translation) and LLM models.
 *
 * @param params - Translation configuration object
 * @param params.modelId - The identifier of the translation model to use
 * @param params.text - The input text to translate
 * @param params.from - Source language code (optional)
 * @param params.to - Target language code
 * @param params.stream - Whether to stream tokens (true) or return complete response (false). Defaults to true.
 * @returns Object with tokenStream generator and text/stats properties
 * @throws {QvacErrorBase} When translation fails with an error message or when language detection fails
 * @example
 * ```typescript
 * // Streaming mode (default)
 * const result = translate({
 *   modelId: "modelId",
 *   text: "Hello world",
 *   from: "en",
 *   to: "es"
 *   modelType: "llm",
 * });
 *
 * for await (const token of result.tokenStream) {
 *   console.log(token);
 * }
 *
 * // Non-streaming mode
 * const response = translate({
 *   modelId: "modelId",
 *   text: "Hello world",
 *   from: "en",
 *   to: "es"
 *   modelType: "llm",
 *   stream: false,
 * });
 *
 * console.log(await response.text);
 * ```
 */
export function translate(
  params: TranslateClientParams,
  options?: RPCOptions,
): {
  tokenStream: AsyncGenerator<string>;
  stats: Promise<TranslationStats | undefined>;
  text: Promise<string>;
} {
  const canonicalModelType = normalizeModelType(params.modelType);
  const isLlm = canonicalModelType === ModelType.llamacppCompletion;

  let sourceLanguage = isLlm ? (params as { from?: string }).from : undefined;

  if (!sourceLanguage && isLlm) {
    const detected = detectOne(params.text as string);
    if (detected.code === "und" || detected.language === "Undetermined") {
      throw new TranslationFailedError(
        "Could not detect the source language. Please specify the 'from' parameter explicitly.",
      );
    }
    sourceLanguage = detected.language;
  }

  const request: TranslateRequest = {
    type: "translate",
    ...params,
    ...(isLlm && {
      from: sourceLanguage,
    }),
  };

  let stats: TranslationStats | undefined;
  let statsResolver: (value: TranslationStats | undefined) => void = () => {};
  const statsPromise = new Promise<TranslationStats | undefined>((resolve) => {
    statsResolver = resolve;
  });

  if (params.stream) {
    const tokenStream = (async function* () {
      for await (const response of streamRpc(request, options)) {
        if (response.type === "translate") {
          const streamResponse = translateResponseSchema.parse(response);
          if (!streamResponse.done) {
            yield streamResponse.token;
          } else {
            stats = streamResponse.stats;
            statsResolver(stats);
          }
        }
      }
    })();

    const textPromise = Promise.resolve("");

    return {
      tokenStream,
      text: textPromise,
      stats: statsPromise,
    };
  } else {
    const tokenStream = (async function* () {
      //Empty generator for non-streaming mode
    })();

    const textPromise = (async () => {
      let buffer = "";

      for await (const response of streamRpc(request, options)) {
        if (response.type === "translate") {
          const streamResponse = translateResponseSchema.parse(response);
          buffer += streamResponse.token;
          if (streamResponse.done) {
            stats = streamResponse.stats;
            statsResolver(stats);
          }
        }
      }

      return buffer;
    })();

    return {
      tokenStream,
      text: textPromise,
      stats: statsPromise,
    };
  }
}
