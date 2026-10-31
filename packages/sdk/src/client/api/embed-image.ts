import { send } from '@/client/rpc/rpc-client'
import { parseClientInput } from '@/client/parse-input'
import {
  embedImageClientParamsSchema,
  embedImageResponseSchema,
  type EmbedImageClientParams,
  type EmbedImageResult,
  type RPCOptions
} from '@qvac/inference/surface'
import { InvalidResponseError } from '@/utils/errors-client'
import { encodeBase64 } from '@/utils/encoding'
import { decoratePromise } from '@/utils/decorate-promise'
import { generateClientRequestId } from '@/client/api/client-request-id'

/**
 * Embeds one JPEG/PNG image or packed RGB buffer with a loaded MegaLoc model.
 *
 * @param params - Model ID and image bytes. Raw RGB requires width, height and channels: 3.
 * @param options - Transport options.
 * @returns An L2-normalized 8448-value descriptor and native runtime statistics.
 * The promise exposes requestId synchronously for cancel(). Calls queue per model.
 * Cancellation discards the result after native inference finishes.
 * @throws {RequestValidationFailedError} If the image or RGB dimensions are invalid.
 * @throws {InferenceCancelledError} If the request is cancelled.
 * @throws {InvalidResponseError} If the model returns an invalid descriptor.
 */
export function embedImage(
  params: EmbedImageClientParams,
  options?: RPCOptions
): Promise<EmbedImageResult> & { requestId: string } {
  return createEmbedImageCall(params, options)
}

export function createEmbedImageCall(
  params: EmbedImageClientParams,
  options?: RPCOptions,
  sendRequest: typeof send = send
): Promise<EmbedImageResult> & { requestId: string } {
  const requestId = generateClientRequestId()
  return decoratePromise(runEmbedImage(params, requestId, options, sendRequest), { requestId })
}

async function runEmbedImage(
  params: EmbedImageClientParams,
  requestId: string,
  options: RPCOptions | undefined,
  sendRequest: typeof send
): Promise<EmbedImageResult> {
  const { image, ...input } = parseClientInput(embedImageClientParamsSchema, params)
  const response = await sendRequest(
    { ...input, image: encodeBase64(image), type: 'embedImage', requestId },
    options
  )
  if (response.type !== 'embedImage') throw new InvalidResponseError('embedImage')
  const parsed = embedImageResponseSchema.safeParse(response)
  if (!parsed.success) throw new InvalidResponseError('embedImage', parsed.error)
  const { type: _type, ...result } = parsed.data
  return result
}
