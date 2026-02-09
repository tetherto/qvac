import {
  ModelType,
  type TranscribeStreamRequest,
  type TranscribeStreamResponse,
} from "@/schemas";
import { transcribeStream as whisperTranscribeStream } from "@/server/bare/addons/whispercpp-transcription";
import { transcribeStream as parakeetTranscribeStream } from "@/server/bare/addons/parakeet-transcription";
import { getModelEntry } from "@/server/bare/registry/model-registry";
import { getServerLogger } from "@/logging";

const logger = getServerLogger();

export async function* handleTranscribeStream(
  request: TranscribeStreamRequest,
): AsyncGenerator<TranscribeStreamResponse> {
  const { modelId, audioChunk, prompt } = request;

  try {
    // Determine which transcription handler to use based on model type
    const entry = getModelEntry(modelId);
    const modelType = entry?.local?.modelType;

    const transcribeStream =
      modelType === ModelType.parakeetTranscription
        ? parakeetTranscribeStream
        : whisperTranscribeStream;

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
