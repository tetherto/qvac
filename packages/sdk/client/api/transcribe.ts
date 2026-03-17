import {
  transcribeResponseSchema,
  transcribeStreamResponseSchema,
  type TranscribeRequest,
  type TranscribeClientParams,
  type RPCOptions,
  type TranscribeStreamRequest,
  type TranscribeStreamClientParams,
  type TranscribeStreamSession,
} from "@/schemas";
import { stream, duplex } from "@/client/rpc/rpc-client";

/**
 * Transcribe audio and return the complete text. Accepts either a file
 * path or an audio buffer.
 *
 * @param params.modelId - The identifier of the transcription model to use
 * @param params.audioChunk - Audio input as either a file path (string) or audio buffer
 * @param params.prompt - Optional initial prompt to guide the transcription
 * @param options - Optional RPC options including per-call profiling
 * @returns The complete transcribed text
 */
export async function transcribe(
  params: TranscribeClientParams,
  options?: RPCOptions,
): Promise<string> {
  const request: TranscribeRequest = {
    type: "transcribe",
    modelId: params.modelId,
    audioChunk:
      typeof params.audioChunk === "string"
        ? { type: "filePath", value: params.audioChunk }
        : { type: "base64", value: params.audioChunk.toString("base64") },
    ...(params.prompt && { prompt: params.prompt }),
  };

  let fullText = "";
  for await (const response of stream(request, options)) {
    if (response.type === "transcribe") {
      const parsed = transcribeResponseSchema.parse(response);

      if (parsed.text) {
        fullText += parsed.text;
      }

      if (parsed.done) {
        break;
      }
    }
  }
  return fullText;
}

/**
 * Opens a bidirectional streaming transcription session. Audio is streamed
 * in via `write()`, and transcription text is yielded as the model's VAD
 * detects complete speech segments.
 *
 * @param params.modelId - The loaded transcription model to use
 * @param params.prompt - Optional initial prompt to guide transcription
 * @returns A session object: call `write(buffer)` to feed audio,
 *          iterate with `for await (const text of session)` to receive
 *          transcription, and `end()` to signal end of audio.
 */
export async function transcribeStream(
  params: TranscribeStreamClientParams,
): Promise<TranscribeStreamSession> {
  const request: TranscribeStreamRequest = {
    type: "transcribeStream",
    modelId: params.modelId,
    ...(params.prompt && { prompt: params.prompt }),
  };

  const { requestStream, responseStream } = await duplex(request);

  async function* parseResponses(): AsyncGenerator<string> {
    let buffer = "";
    for await (const chunk of responseStream as AsyncIterable<Buffer>) {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        const response = transcribeStreamResponseSchema.parse(JSON.parse(line));
        if (response.done) return;
        if (response.text?.trim()) {
          yield response.text;
        }
      }
    }
  }

  const responses = parseResponses();

  return {
    write(audioChunk: Buffer) {
      (requestStream as { write(chunk: Buffer): void }).write(audioChunk);
    },
    end() {
      (requestStream as { end(): void }).end();
    },
    [Symbol.asyncIterator]() {
      return responses;
    },
  };
}
