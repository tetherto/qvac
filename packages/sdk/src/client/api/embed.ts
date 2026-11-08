import { send } from '@/client/rpc/rpc-client'
import {
  type EmbedParams,
  type EmbedInput,
  type EmbedRequest,
  type EmbedStats,
  type RPCOptions
} from '@qvac/inference/surface'
import { InvalidResponseError } from '@/utils/errors-client'
import { decoratePromise } from '@/utils/decorate-promise'
import { generateClientRequestId } from '@/client/api/client-request-id'

/**
 * Generates embeddings for a single text using a specified model.
 *
 * @overloadLabel "Single text"
 *
 * @throws {QvacErrorBase} When the response type is invalid or when the embedding fails
 */
export function embed(
  params: { modelId: string; text: string; inputs?: never },
  options?: RPCOptions
): Promise<{ embedding: number[]; stats?: EmbedStats }> & { requestId: string }

/**
 * Generates embeddings for multiple texts using a specified model.
 *
 * @overloadLabel "Multiple texts"
 *
 * @throws {QvacErrorBase} When the response type is invalid or when the embedding fails
 */
export function embed(
  params: { modelId: string; text: string[]; inputs?: never },
  options?: RPCOptions
): Promise<{ embedding: number[][]; stats?: EmbedStats }> & {
  requestId: string
}

/**
 * Embeds ordered text and media inputs.
 *
 * @overloadLabel "Text and media batch"
 *
 * @throws {QvacErrorBase} When validation or embedding fails
 */
export function embed(
  params: { modelId: string; inputs: EmbedInput[]; text?: never },
  options?: RPCOptions
): Promise<{ embedding: number[][]; stats?: EmbedStats }> & { requestId: string }

/**
 * Embeds text or a batch of ordered text and media inputs.
 *
 * @throws {QvacErrorBase} When validation or embedding fails
 */
export function embed(
  params: EmbedParams,
  options?: RPCOptions
): Promise<{ embedding: number[] | number[][]; stats?: EmbedStats }> & { requestId: string }

export function embed(
  params: EmbedParams,
  options?: RPCOptions
): Promise<{ embedding: number[] | number[][]; stats?: EmbedStats }> & {
  requestId: string
} {
  // Client-generated `requestId` is surfaced synchronously on the
  // returned promise so the caller can `cancel({ requestId })` before
  // `await` resolves. The same id is threaded onto the wire envelope so
  // the server's registry entry uses it as the canonical key —
  // matching the `loadModel` / `downloadAsset` / `completion` shape.
  const requestId = generateClientRequestId()
  const inner = runEmbed(params, requestId, options)
  return decoratePromise(inner, { requestId })
}

async function runEmbed(
  params: EmbedParams,
  requestId: string,
  options?: RPCOptions
): Promise<{ embedding: number[] | number[][]; stats?: EmbedStats }> {
  const request: EmbedRequest = {
    type: 'embed',
    ...params,
    requestId
  }

  const response = await send(request, options)
  if (response.type !== 'embed') {
    throw new InvalidResponseError('embed')
  }

  return {
    embedding: response.embedding,
    ...(response.stats !== undefined && { stats: response.stats })
  }
}
