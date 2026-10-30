import { send } from '@/dispatch'
import {
  type EmbedParams,
  type EmbedInput,
  type EmbedRequest,
  type EmbedStats,
  type RPCOptions
} from '@/schemas/index'
import { InvalidResponseError } from '@/errors/index'
import { decoratePromise } from '@/utils/decorate-promise'
import { generateRequestId } from '@/runtime/request-id'

/**
 * Generates embeddings for a single text using a specified model.
 *
 * @overloadLabel "Single text"
 * @param params - The parameters for the embedding
 * @param params.modelId - The identifier of the embedding model to use
 * @param params.text - The input text to embed
 * @param options - Optional RPC options including per-call profiling
 * @returns A promise (decorated with `requestId`) resolving to an object with `embedding` (a single `number[]` vector) and optional `stats` performance data.
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
 * @param params - The parameters for the embedding
 * @param params.modelId - The identifier of the embedding model to use
 * @param params.text - The input texts to embed
 * @param options - Optional RPC options including per-call profiling
 * @returns A promise (decorated with `requestId`) resolving to an object with `embedding` (one `number[]` vector per input text, i.e. `number[][]`) and optional `stats` performance data.
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
 * @param params - Model identifier and ordered inputs to embed
 * @param options - Optional RPC options including per-call profiling
 * @returns One embedding vector per input, with optional statistics and a synchronous requestId for cancellation.
 * @throws {QvacErrorBase} When validation or embedding fails
 */
export function embed(
  params: { modelId: string; inputs: EmbedInput[]; text?: never },
  options?: RPCOptions
): Promise<{ embedding: number[][]; stats?: EmbedStats }> & { requestId: string }

/**
 * Embeds text or a batch of ordered text and media inputs.
 *
 * @param params - Model identifier and either text or inputs
 * @param options - Optional RPC options including per-call profiling
 * @returns Embeddings with optional statistics and a synchronous requestId for cancellation.
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
  // The caller-generated `requestId` is surfaced synchronously on the
  // returned promise so the caller can `cancel({ requestId })` before
  // `await` resolves. The same id is carried on the request so the
  // registry entry uses it as the canonical key — matching the
  // `loadModel` / `downloadAsset` / `completion` shape.
  const requestId = generateRequestId()
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
