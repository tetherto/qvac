import {
  ocrStreamResponseSchema,
  type OCRStreamRequest,
  type OCRClientParams,
  type OCRTextBlock,
  type OCRStats,
} from "@/schemas";
import { stream as streamRpc } from "@/client/rpc/rpc-client";

/**
 * Performs Optical Character Recognition (OCR) on an image to extract text.
 *
 * @param params - The OCR parameters
 * @param params.modelId - The identifier of the loaded OCR model to use
 * @param params.image - Image input as either a file path (string) or image buffer
 * @param params.options - Optional OCR options (e.g., paragraph mode)
 * @param params.stream - Whether to stream blocks as they're detected (true) or return all at once (false). Defaults to false
 * @returns Object with blockStream generator, blocks promise, and stats promise
 * @example
 * ```typescript
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
export function ocr(params: OCRClientParams): {
  blockStream: AsyncGenerator<OCRTextBlock[]>;
  blocks: Promise<OCRTextBlock[]>;
  stats: Promise<OCRStats | undefined>;
} {
  const request: OCRStreamRequest = {
    type: "ocrStream",
    modelId: params.modelId,
    image:
      typeof params.image === "string"
        ? { type: "filePath", value: params.image }
        : { type: "base64", value: params.image.toString("base64") },
    ...(params.options && { options: params.options }),
  };

  let ocrStats: OCRStats | undefined;
  let statsResolver: (value: OCRStats | undefined) => void = () => {};
  const statsPromise = new Promise<OCRStats | undefined>((resolve) => {
    statsResolver = resolve;
  });

  if (params.stream) {
    const blockStream = (async function* () {
      for await (const response of streamRpc(request)) {
        if (response.type === "ocrStream") {
          const streamResponse = ocrStreamResponseSchema.parse(response);
          if (streamResponse.blocks && streamResponse.blocks.length > 0) {
            yield streamResponse.blocks;
          }
          if (streamResponse.done) {
            ocrStats = streamResponse.stats;
            statsResolver(ocrStats);
          }
        }
      }
    })();

    return {
      blockStream,
      blocks: Promise.resolve([]),
      stats: statsPromise,
    };
  } else {
    const blockStream = (async function* () {
      // Empty generator for non-streaming mode
    })();

    const blocksPromise = (async () => {
      let allBlocks: OCRTextBlock[] = [];
      for await (const response of streamRpc(request)) {
        if (response.type === "ocrStream") {
          const streamResponse = ocrStreamResponseSchema.parse(response);
          if (streamResponse.blocks) {
            allBlocks = allBlocks.concat(streamResponse.blocks);
          }
          if (streamResponse.done) {
            ocrStats = streamResponse.stats;
            statsResolver(ocrStats);
          }
        }
      }
      return allBlocks;
    })();

    return {
      blockStream,
      blocks: blocksPromise,
      stats: statsPromise,
    };
  }
}
