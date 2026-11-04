import {
  ocrStreamResponseSchema,
  type OCRStreamRequest,
  type OCRClientParams,
  type OCRTextBlock,
  type OCRStats,
  type RPCOptions
} from '@qvac/inference/surface'
import { stream as streamRpc } from '@/client/rpc/rpc-client'
import { generateClientRequestId } from '@/client/api/client-request-id'

/**
 * Performs Optical Character Recognition (OCR) on an image to extract text.
 *
 * @param params - The OCR parameters
 * @param params.modelId - The identifier of the loaded OCR model to use
 * @param params.image - Image input as either a file path (string) or image buffer
 * @param params.options - Optional OCR options (e.g., paragraph mode)
 * @param params.stream - Whether to stream blocks as they're detected (true) or return all at once (false). Defaults to false
 * @param options - Optional RPC options (timeout, profiling, force new connection).
 * @returns Object with `requestId` (pass to `cancel({ requestId })`), blockStream generator, blocks promise, and stats promise
 * @example
 * ```typescript
 * // Load an OCR model first. Registry GGUF models resolve their pipeline
 * // and detector automatically:
 * //   EasyOCR (default): OCR_LATIN  (CRAFT detector auto-derived)
 * //   DocTR:             OCR_DOCTR  (DBNet detector auto-derived)
 * const modelId = await loadModel({
 *   modelSrc: OCR_LATIN.src,
 *   modelType: MODEL_TYPES.ggmlOcr,
 * });
 *
 * // Non-streaming mode (default) - get all blocks at once
 * const { blocks } = ocr({ modelId, image: "/path/to/image.png" });
 * for (const block of await blocks) {
 *   console.log(block.text, block.bbox, block.confidence);
 * }
 *
 * // Streaming mode - process blocks as they arrive
 * const { blockStream } = ocr({ modelId, image: imageBuffer, stream: true });
 * for await (const blocks of blockStream) {
 *   console.log("Detected:", blocks);
 * }
 * ```
 */
export function ocr(
  params: OCRClientParams,
  options?: RPCOptions
): {
  requestId: string
  blockStream: AsyncGenerator<OCRTextBlock[]>
  blocks: Promise<OCRTextBlock[]>
  stats: Promise<OCRStats | undefined>
} {
  const requestId = generateClientRequestId()
  const request: OCRStreamRequest = {
    type: 'ocrStream',
    requestId,
    modelId: params.modelId,
    image:
      typeof params.image === 'string'
        ? { type: 'filePath', value: params.image }
        : { type: 'base64', value: params.image.toString('base64') },
    ...(params.options && { options: params.options })
  }

  let ocrStats: OCRStats | undefined
  let statsResolver: (value: OCRStats | undefined) => void = () => {}
  const statsPromise = new Promise<OCRStats | undefined>((resolve) => {
    statsResolver = resolve
  })

  if (params.stream) {
    const blockStream = (async function* () {
      for await (const response of streamRpc(request, options)) {
        if (response.type === 'ocrStream') {
          const streamResponse = ocrStreamResponseSchema.parse(response)
          if (streamResponse.blocks && streamResponse.blocks.length > 0) {
            yield streamResponse.blocks
          }
          if (streamResponse.done) {
            ocrStats = streamResponse.stats
            statsResolver(ocrStats)
          }
        }
      }
    })()

    return {
      requestId,
      blockStream,
      blocks: Promise.resolve([]),
      stats: statsPromise
    }
  } else {
    const blockStream = (async function* () {
      // Empty generator for non-streaming mode
    })()

    const blocksPromise = (async () => {
      let allBlocks: OCRTextBlock[] = []
      for await (const response of streamRpc(request, options)) {
        if (response.type === 'ocrStream') {
          const streamResponse = ocrStreamResponseSchema.parse(response)
          if (streamResponse.blocks) {
            allBlocks = allBlocks.concat(streamResponse.blocks)
          }
          if (streamResponse.done) {
            ocrStats = streamResponse.stats
            statsResolver(ocrStats)
          }
        }
      }
      return allBlocks
    })()

    return {
      requestId,
      blockStream,
      blocks: blocksPromise,
      stats: statsPromise
    }
  }
}
