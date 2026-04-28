import {
  transcribeResponseSchema,
  transcribeStreamResponseSchema,
  type TranscribeRequest,
  type TranscribeClientParams,
  type RPCOptions,
  type TranscribeStreamRequest,
  type TranscribeStreamClientParams,
  type TranscribeStreamSession,
  type TranscribeStreamResponse,
} from "@/schemas";
import { stream, duplex, type DuplexReadable } from "@/client/rpc/rpc-client";
import { getClientLogger } from "@/logging";
import { TranscriptionFailedError } from "@/utils/errors-client";

const logger = getClientLogger();

function buildTranscribeRequest(params: TranscribeClientParams): TranscribeRequest {
  return {
    type: "transcribe",
    modelId: params.modelId,
    audioChunk:
      typeof params.audioChunk === "string"
        ? { type: "filePath", value: params.audioChunk }
        : { type: "base64", value: params.audioChunk.toString("base64") },
    ...(params.prompt && { prompt: params.prompt }),
  };
}

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
  const request = buildTranscribeRequest(params);

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
 * @deprecated Pass audio via `transcribe()` instead. This overload will be
 * removed in the next major version.
 *
 * Streaming transcription with upfront audio: sends full audio, yields text
 * chunks as they arrive.
 */
export function transcribeStream(
  params: TranscribeClientParams,
  options?: RPCOptions,
): AsyncGenerator<string>;

/**
 * Opens a bidirectional streaming transcription session. Audio is streamed
 * in via `write()`, and transcription text is yielded as the model's VAD
 * detects complete speech segments.
 *
 * The returned session is single-use. Attempting to iterate a second
 * time will throw a `TranscriptionFailedError`.
 *
 * @param params.modelId - The loaded transcription model to use
 * @param params.prompt - Optional initial prompt to guide transcription
 * @returns A session object: call `write(buffer)` to feed audio,
 *          iterate with `for await (const text of session)` to receive
 *          transcription, and `end()` to signal end of audio.
 */
export function transcribeStream(
  params: TranscribeStreamClientParams,
  options?: RPCOptions,
): Promise<TranscribeStreamSession>;

export function transcribeStream(
  params: TranscribeClientParams | TranscribeStreamClientParams,
  options?: RPCOptions,
): AsyncGenerator<string> | Promise<TranscribeStreamSession> {
  if ("audioChunk" in params && params.audioChunk !== undefined) {
    logger.warn(
      "transcribeStream() with audioChunk is deprecated — use transcribe() instead.",
    );
    return transcribeStreamWithAudio(params, options);
  }
  return transcribeStreamDuplex(params, options);
}

async function* transcribeStreamWithAudio(
  params: TranscribeClientParams,
  options?: RPCOptions,
): AsyncGenerator<string> {
  const request = buildTranscribeRequest(params);

  for await (const response of stream(request, options)) {
    if (response.type === "transcribe") {
      const parsed = transcribeResponseSchema.parse(response);
      if (parsed.text) yield parsed.text;
      if (parsed.done) break;
    }
  }
}

async function transcribeStreamDuplex(
  params: TranscribeStreamClientParams,
  options?: RPCOptions,
): Promise<TranscribeStreamSession> {
  const request: TranscribeStreamRequest = {
    type: "transcribeStream",
    modelId: params.modelId,
    ...(params.prompt && { prompt: params.prompt }),
  };

  const { requestStream, responseStream } = await duplex(request, options);

  const responses = parseResponseLines(responseStream);
  let consumed = false;

  return {
    write(audioChunk: Buffer) {
      requestStream.write(audioChunk);
    },
    end() {
      requestStream.end();
    },
    destroy() {
      requestStream.destroy();
      responseStream.destroy();
    },
    [Symbol.asyncIterator]() {
      if (consumed) {
        throw new TranscriptionFailedError(
          "TranscribeStreamSession can only be iterated once",
        );
      }
      consumed = true;
      return responses;
    },
  };
}

async function* parseResponseLines(
  responseStream: DuplexReadable,
): AsyncGenerator<string> {
  let buf = "";

  for await (const chunk of responseStream) {
    buf += chunk.toString();
    const lines = buf.split("\n");
    buf = lines.pop() || "";

    for (const line of lines) {
      const result = processLine(line);
      if (result === null) return;
      if (result !== undefined) yield result;
    }
  }

  // Process any residual data after stream ends
  if (buf.trim()) {
    const result = processLine(buf);
    if (result !== null && result !== undefined) yield result;
  }
}

function processLine(line: string): string | undefined | null {
  if (!line.trim()) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    logger.warn("transcribeStream: malformed JSON from server:", line);
    return undefined;
  }

  const obj = parsed as Record<string, unknown>;
  if (obj["type"] === "error") {
    throw new TranscriptionFailedError(
      (obj["message"] as string) ?? "Unknown server error",
    );
  }

  const response: TranscribeStreamResponse =
    transcribeStreamResponseSchema.parse(parsed);

  if (response.error) throw new TranscriptionFailedError(response.error);
  if (response.done) return null;
  if (response.text?.trim()) return response.text;
  return undefined;
}

