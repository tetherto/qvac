import {
  transcribeStreamResponseSchema,
  type TranscribeStreamRequest,
  type TranscribeClientParams,
  type RPCOptions,
} from "@/schemas";
import { stream } from "@/client/rpc/rpc-client";

/**
 * This function streams audio transcription results in real-time, yielding
 * text chunks as they become available from the model.
 *
 * @param params - The arguments for the transcription
 * @param params.modelId - The identifier of the transcription model to use
 * @param params.audioChunk - Audio input as either a file path (string) or audio buffer
 * @param params.prompt - Optional initial prompt to guide the transcription
 * @param options - Optional RPC options including per-call profiling
 * @yields {string} Text chunks as they are transcribed
 * @throws {QvacErrorBase} When transcription fails with an error message
 */
export async function* transcribeStream(
  params: TranscribeClientParams,
  options?: RPCOptions,
) {
  const request: TranscribeStreamRequest = {
    type: "transcribeStream",
    modelId: params.modelId,
    audioChunk:
      typeof params.audioChunk === "string"
        ? { type: "filePath", value: params.audioChunk }
        : { type: "base64", value: params.audioChunk.toString("base64") },
    ...(params.prompt && { prompt: params.prompt }),
  };

  for await (const response of stream(request, options)) {
    if (response.type === "transcribeStream") {
      const streamResponse = transcribeStreamResponseSchema.parse(response);

      if (streamResponse.text) {
        yield streamResponse.text;
      }

      if (streamResponse.done) {
        break;
      }
    }
  }
}

/**
 * This function provides a simple interface for transcribing audio by
 * collecting all streaming results into a single string response.
 *
 * @param params - The arguments for the transcription
 * @param params.modelId - The identifier of the transcription model to use
 * @param params.audioChunk - Audio input as either a file path (string) or audio buffer
 * @param params.prompt - Optional initial prompt to guide the transcription
 * @param options - Optional RPC options including per-call profiling
 * @returns {Promise<string>} The complete transcribed text
 * @throws {QvacErrorBase} When transcription fails (propagated from transcribeStream)
 */
export async function transcribe(
  params: TranscribeClientParams,
  options?: RPCOptions,
): Promise<string> {
  let fullText = "";
  for await (const textChunk of transcribeStream(params, options)) {
    fullText += textChunk;
  }
  return fullText;
}
