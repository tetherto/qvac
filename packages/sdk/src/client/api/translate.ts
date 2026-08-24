import { stream as streamRpc } from '@/client/rpc/rpc-client'
import { generateClientRequestId } from '@/client/api/client-request-id'
import {
  translateResponseSchema,
  type TranslateRequest,
  type TranslateClientParams,
  type TranslationStats,
  type RPCOptions
} from '@qvac/inference/surface'

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
 * @returns Object with tokenStream generator and text/stats properties
 * @throws {QvacErrorBase} When translation fails with an error message or when language detection fails
 * @example
 * ```typescript
 * // Streaming mode (default)
 * const result = translate({
 *   modelId: "modelId",
 *   text: "Hello world",
 *   from: "en",
 *   to: "es",
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
 *   to: "es",
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
  text: Promise<string>
  requestId: string
} {
  // Stable identity generated client-side so `cancel({ requestId })` works the
  // moment we return, before the first round-trip. Surfaced on the handle.
  const requestId = generateClientRequestId()

  // Source-language auto-detection lives in the worker now
  // (server/bare/ops/translate.ts): `from` is passed through when present and
  // resolved server-side when absent, so every language binding shares one
  // detector instead of each shipping its own.
  const request: TranslateRequest = {
    type: 'translate',
    ...params,
    requestId
  }

  let stats: TranslationStats | undefined
  let statsResolver: (value: TranslationStats | undefined) => void = () => {}
  const statsPromise = new Promise<TranslationStats | undefined>((resolve) => {
    statsResolver = resolve
  })

  if (params.stream) {
    const tokenStream = (async function* () {
      try {
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
      } finally {
        // Settle stats even if the stream ended early (cancel) or errored, so
        // `await handle.stats` can't hang. Idempotent if already resolved.
        statsResolver(stats)
      }
    })()

    const textPromise = Promise.resolve('')

    return {
      tokenStream,
      text: textPromise,
      stats: statsPromise,
      requestId
    }
  } else {
    const tokenStream = (async function* () {
      //Empty generator for non-streaming mode
    })()

    const textPromise = (async () => {
      let buffer = ''

      try {
        for await (const response of streamRpc(request, options)) {
          if (response.type === 'translate') {
            const streamResponse = translateResponseSchema.parse(response)
            buffer += streamResponse.token
            if (streamResponse.done) {
              stats = streamResponse.stats
              statsResolver(stats)
            }
          }
        }
      } finally {
        // Settle stats even if the stream ended early (cancel) or errored, so
        // `await handle.stats` can't hang. Idempotent if already resolved.
        statsResolver(stats)
      }

      return buffer
    })()

    return {
      tokenStream,
      text: textPromise,
      stats: statsPromise,
      requestId
    }
  }
}
