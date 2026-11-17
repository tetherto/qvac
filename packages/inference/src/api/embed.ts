import { send } from '@/dispatch'
import {
  embedClientParamsSchema,
  embedBatchClientParamsSchema,
  embedResponseSchema,
  embedBatchResponseSchema,
  type EmbedClientParams,
  type EmbedBatchClientParams,
  type EmbedClientInput,
  type EmbedInput,
  type EmbedWireInput,
  type EmbedStats,
  type RPCOptions
} from '@/schemas/index'
import { InvalidResponseError } from '@/errors/index'
import { parseClientInput } from '@/api/parse-input'
import { encodeBase64 } from '@/utils/encoding'
import { decoratePromise } from '@/utils/decorate-promise'
import { generateRequestId } from '@/runtime/request-id'
import { getAppLogger } from '@/logging/index'

const logger = getAppLogger()

type EmbedResult<T> = Promise<{ embedding: T; stats?: EmbedStats }> & { requestId: string }

/**
 * Embeds one input supported by the loaded model.
 *
 * @overloadLabel "Single input"
 * @param params - Model identifier and text, ordered text/media parts, or image bytes.
 * @param options - Optional RPC options.
 * @returns One vector, optional statistics, and a synchronous requestId for cancellation.
 * @throws {QvacErrorBase} When validation or inference fails.
 */
export function embed(
  params: { modelId: string; input: EmbedClientInput; text?: never; inputs?: never },
  options?: RPCOptions
): EmbedResult<number[]>

/**
 * Embeds one text string.
 *
 * @overloadLabel "Single text"
 * @param params - Model identifier and text.
 * @param options - Optional RPC options.
 * @returns One vector with optional statistics and a requestId for cancellation.
 * @throws {QvacErrorBase} When validation or inference fails.
 */
export function embed(
  params: { modelId: string; text: string; inputs?: never; input?: never },
  options?: RPCOptions
): EmbedResult<number[]>

/**
 * @deprecated Use `embedBatch({ modelId, inputs })` instead. This overload will be
 * removed in the next major version.
 *
 * Embeds each string in a text array.
 *
 * @overloadLabel "Legacy text batch (deprecated)"
 * @param params - Model identifier and text strings.
 * @param options - Optional RPC options.
 * @returns One vector per string, optional statistics, and a requestId.
 * @throws {QvacErrorBase} When validation or inference fails.
 */
export function embed(
  params: { modelId: string; text: string[]; inputs?: never; input?: never },
  options?: RPCOptions
): EmbedResult<number[][]>

/**
 * @deprecated Use `embedBatch({ modelId, inputs })` instead. This overload will be
 * removed in the next major version.
 *
 * Embeds each text or ordered text/media input.
 *
 * @overloadLabel "Legacy inputs batch (deprecated)"
 * @param params - Model identifier and text or ordered text/media inputs. Images go through embedBatch.
 * @param options - Optional RPC options.
 * @returns One vector per input, optional statistics, and a requestId.
 * @throws {QvacErrorBase} When validation or inference fails.
 */
export function embed(
  params: { modelId: string; inputs: EmbedInput[]; text?: never; input?: never },
  options?: RPCOptions
): EmbedResult<number[][]>

/**
 * Embeds a single input or a legacy batch supported by the loaded model.
 *
 * @param params - Model identifier and input.
 * @param options - Optional RPC options.
 * @returns Embeddings, optional statistics, and a requestId for cancellation.
 * @throws {QvacErrorBase} When validation or inference fails.
 */
export function embed(
  params: EmbedClientParams,
  options?: RPCOptions
): EmbedResult<number[] | number[][]>
export function embed(
  params: EmbedClientParams,
  options?: RPCOptions
): EmbedResult<number[] | number[][]> {
  return createEmbedCall(params, options)
}

/**
 * Embeds a batch of inputs supported by the loaded model, in input order.
 *
 * @param params - Model identifier and a non-empty list of inputs.
 * @param options - Optional RPC options.
 * @returns One vector per input, including one-item batches, optional statistics, and a requestId.
 * @throws {QvacErrorBase} When validation or inference fails.
 */
export function embedBatch(
  params: EmbedBatchClientParams,
  options?: RPCOptions
): EmbedResult<number[][]> {
  const requestId = generateRequestId()
  return decoratePromise(runEmbedBatch(params, requestId, options), { requestId })
}

export function createEmbedCall(
  params: EmbedClientParams,
  options?: RPCOptions,
  sendRequest: typeof send = send
): EmbedResult<number[] | number[][]> {
  const requestId = generateRequestId()
  return decoratePromise(runEmbed(params, requestId, options, sendRequest), { requestId })
}

function encodeInput(input: EmbedClientInput): EmbedWireInput {
  return typeof input === 'object' && !Array.isArray(input)
    ? { ...input, image: encodeBase64(input.image) }
    : input
}

async function runEmbed(
  params: EmbedClientParams,
  requestId: string,
  options: RPCOptions | undefined,
  sendRequest: typeof send
) {
  const parsed = parseClientInput(embedClientParamsSchema, params)
  if (parsed.inputs !== undefined) {
    logger.warn('embed() with inputs is deprecated. Use embedBatch() instead.')
  } else if (Array.isArray(parsed.text)) {
    logger.warn('embed() with a text array is deprecated. Use embedBatch() instead.')
  }
  const request =
    parsed.input !== undefined
      ? { modelId: parsed.modelId, input: encodeInput(parsed.input) }
      : parsed.inputs !== undefined
        ? { modelId: parsed.modelId, inputs: parsed.inputs }
        : { modelId: parsed.modelId, text: parsed.text }
  const response = await sendRequest({ ...request, type: 'embed', requestId }, options)
  if (response.type !== 'embed') throw new InvalidResponseError('embed')
  const result = embedResponseSchema.safeParse(response)
  if (!result.success) throw new InvalidResponseError('embed', result.error)
  return {
    embedding: result.data.embedding,
    ...(result.data.stats !== undefined && { stats: result.data.stats })
  }
}

async function runEmbedBatch(
  params: EmbedBatchClientParams,
  requestId: string,
  options?: RPCOptions
) {
  const parsed = parseClientInput(embedBatchClientParamsSchema, params)
  const response = await send(
    {
      modelId: parsed.modelId,
      inputs: parsed.inputs.map(encodeInput),
      type: 'embedBatch',
      requestId
    },
    options
  )
  if (response.type !== 'embedBatch') throw new InvalidResponseError('embedBatch')
  const result = embedBatchResponseSchema.safeParse(response)
  if (!result.success) throw new InvalidResponseError('embedBatch', result.error)
  return {
    embedding: result.data.embedding,
    ...(result.data.stats !== undefined && { stats: result.data.stats })
  }
}
