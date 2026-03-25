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
import { getClientLogger } from "@/logging";
import { TranscriptionFailedError } from "@/utils/errors-client";

const logger = getClientLogger();

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
 * The returned session is single-use: calling `[Symbol.asyncIterator]`
 * returns the same generator instance each time. A second iteration will
 * yield nothing.
 *
 * @param params.modelId - The loaded transcription model to use
 * @param params.prompt - Optional initial prompt to guide transcription
 * @returns A session object: call `write(buffer)` to feed audio,
 *          iterate with `for await (const text of session)` to receive
 *          transcription, and `end()` to signal end of audio.
 */
export async function transcribeStream(
  params: TranscribeStreamClientParams,
  options?: RPCOptions,
): Promise<TranscribeStreamSession> {
  const request: TranscribeStreamRequest = {
    type: "transcribeStream",
    modelId: params.modelId,
    ...(params.prompt && { prompt: params.prompt }),
  };

  const { requestStream, responseStream } = await duplex(request, options);

  const writable = requestStream as {
    write(chunk: Buffer): void;
    end(): void;
    destroy(): void;
  };
  const readable = responseStream as AsyncIterable<Buffer> & {
    destroy(): void;
  };

  async function* parseResponses(): AsyncGenerator<string> {
    let buffer = "";
    for await (const chunk of readable) {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          logger.warn("transcribeStream: malformed JSON from server:", line);
          continue;
        }
        const obj = parsed as Record<string, unknown>;
        if (obj["type"] === "error") {
          throw new TranscriptionFailedError(
            (obj["error"] as string) ?? "Unknown server error",
          );
        }
        const response = transcribeStreamResponseSchema.parse(parsed);
        if (response.error) {
          throw new TranscriptionFailedError(response.error);
        }
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
      writable.write(audioChunk);
    },
    end() {
      writable.end();
    },
    destroy() {
      writable.destroy();
      readable.destroy();
    },
    [Symbol.asyncIterator]() {
      return responses;
    },
  };
}
