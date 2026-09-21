import { stream as streamRpc } from '@/dispatch'
import {
  translateResponseSchema,
  type TranslateRequest,
  type TranslateClientParams,
  type TranslationStats,
  type RPCOptions
} from '@/schemas/index'

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
 * @param options - Optional RPC options (timeout, profiling, force new connection, etc.).
 * @returns Object with a tokenStream generator, `translations` (one entry per
 * input, in order), `text` (those entries joined by newlines) and stats
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
  options?: RPCOptions
): {
  tokenStream: AsyncGenerator<string>
  stats: Promise<TranslationStats | undefined>
  translations: Promise<string[]>
  text: Promise<string>
} {
  // Source-language auto-detection lives in the engine op
  // (plugins/ops/translate.ts): `from` is passed through when present and
  // resolved engine-side when absent, so every language binding shares one
  // detector instead of each shipping its own.
  const request: TranslateRequest = {
    type: 'translate',
    ...params
  }

  let stats: TranslationStats | undefined
  let statsResolver: (value: TranslationStats | undefined) => void = () => {}
  const statsPromise = new Promise<TranslationStats | undefined>((resolve) => {
    statsResolver = resolve
  })

  if (params.stream) {
    const tokenStream = (async function* () {
      for await (const response of streamRpc(request, options)) {
        if (response.type === 'translate') {
          const streamResponse = translateResponseSchema.parse(response)
          if (!streamResponse.done) {
            yield streamResponse.token
          } else {
            stats = streamResponse.stats
            statsResolver(stats)
          }
        }
      }
    })()

    return {
      tokenStream,
      translations: Promise.resolve([]),
      text: Promise.resolve(''),
      stats: statsPromise
    }
  } else {
    const tokenStream = (async function* () {
      //Empty generator for non-streaming mode
    })()

    const batched = Array.isArray(params.text)
    const translationsPromise = (async () => {
      const collected: string[] = batched ? [] : ['']

      for await (const response of streamRpc(request, options)) {
        if (response.type === 'translate') {
          const streamResponse = translateResponseSchema.parse(response)
          if (streamResponse.done) {
            stats = streamResponse.stats
            statsResolver(stats)
          } else if (batched) {
            collected.push(streamResponse.token)
          } else {
            collected[0] += streamResponse.token
          }
        }
      }

      return collected
    })()

    return {
      tokenStream,
      translations: translationsPromise,
      text: translationsPromise.then((entries) => entries.join('\n')),
      stats: statsPromise
    }
  }
}
