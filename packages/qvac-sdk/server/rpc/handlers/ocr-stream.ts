import type { OCRStreamRequest, OCRStreamResponse } from "@/schemas";
import { ocr } from "@/server/bare/addons/onnx-ocr";
import { getServerLogger } from "@/logging";

const logger = getServerLogger();

export async function* handleOCRStream(
  request: OCRStreamRequest,
): AsyncGenerator<OCRStreamResponse> {
  const { modelId, image, options } = request;

  try {
    // Stream OCR results in real-time
    for await (const result of ocr({
      image,
      modelId,
      options,
    })) {
      if (result.blocks && result.blocks.length > 0) {
        yield {
          type: "ocrStream",
          blocks: result.blocks,
        };
      }

      if (result.stats) {
        yield {
          type: "ocrStream",
          stats: result.stats,
        };
      }
    }

    // Signal completion
    yield {
      type: "ocrStream",
      done: true,
    };
  } catch (error) {
    logger.error("Error during OCR:", error);
    yield {
      type: "ocrStream",
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}
