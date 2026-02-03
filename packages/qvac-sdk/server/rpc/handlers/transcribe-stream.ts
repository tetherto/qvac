import type {
  TranscribeStreamRequest,
  TranscribeStreamResponse,
} from "@/schemas";
import { transcribeStream } from "@/server/bare/addons/whispercpp-transcription";
import { getServerLogger } from "@/logging";

const logger = getServerLogger();

export async function* handleTranscribeStream(
  request: TranscribeStreamRequest,
): AsyncGenerator<TranscribeStreamResponse> {
  const { modelId, audioChunk, prompt } = request;

  try {
    // Stream transcription results in real-time
    for await (const textChunk of transcribeStream({
      audioChunk,
      modelId,
      prompt,
    })) {
      yield {
        type: "transcribeStream",
        text: textChunk,
      };
    }

    // Signal completion
    yield {
      type: "transcribeStream",
      done: true,
    };
  } catch (error) {
    logger.error("Error during transcription:", error);
    yield {
      type: "transcribeStream",
      text: "",
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}
