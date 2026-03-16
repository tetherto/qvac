import {
  transcribeStreamResponseSchema,
  transcribeLiveResponseSchema,
  type TranscribeStreamRequest,
  type TranscribeClientParams,
  type TranscribeLiveRequest,
  type TranscribeLiveClientParams,
  type TranscribeLiveSession,
} from "@/schemas";
import { stream, duplex } from "@/client/rpc/rpc-client";

/**
 * This function streams audio transcription results in real-time, yielding
 * text chunks as they become available from the model.
 *
 * @param params - The arguments for the transcription
 * @param params.modelId - The identifier of the transcription model to use
 * @param params.audioChunk - Audio input as either a file path (string) or audio buffer
 * @param params.prompt - Optional initial prompt to guide the transcription
 * @yields {string} Text chunks as they are transcribed
 * @throws {QvacErrorBase} When transcription fails with an error message
 */
export async function* transcribeStream(params: TranscribeClientParams) {
  const request: TranscribeStreamRequest = {
    type: "transcribeStream",
    modelId: params.modelId,
    audioChunk:
      typeof params.audioChunk === "string"
        ? { type: "filePath", value: params.audioChunk }
        : { type: "base64", value: params.audioChunk.toString("base64") },
    ...(params.prompt && { prompt: params.prompt }),
  };

  for await (const response of stream(request)) {
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
 * @returns {Promise<string>} The complete transcribed text
 * @throws {QvacErrorBase} When transcription fails (propagated from transcribeStream)
 */
export async function transcribe(
  params: TranscribeClientParams,
): Promise<string> {
  let fullText = "";
  for await (const textChunk of transcribeStream(params)) {
    fullText += textChunk;
  }
  return fullText;
}

/**
 * Opens a live bidirectional transcription session. Audio is streamed in
 * via `write()`, and transcription text is yielded as the model's VAD
 * detects complete speech segments.
 *
 * @param params.modelId - The loaded whisper model to use
 * @param params.prompt - Optional initial prompt to guide transcription
 * @returns A session object: call `write(buffer)` to feed audio,
 *          iterate with `for await (const text of session)` to receive
 *          transcription, and `end()` to signal end of audio.
 */
export async function transcribeLive(
  params: TranscribeLiveClientParams,
): Promise<TranscribeLiveSession> {
  const request: TranscribeLiveRequest = {
    type: "transcribeLive",
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
        const response = transcribeLiveResponseSchema.parse(JSON.parse(line));
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
