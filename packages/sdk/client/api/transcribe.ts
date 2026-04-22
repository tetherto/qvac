import {
  transcribeResponseSchema,
  transcribeStreamResponseSchema,
  type TranscribeRequest,
  type TranscribeClientParams,
  type RPCOptions,
  type TranscribeSegment,
  type TranscribeStreamRequest,
  type TranscribeStreamClientParams,
  type TranscribeStreamSession,
  type TranscribeStreamMetadataSession,
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
    ...(params.metadata === true && { metadata: true }),
  };
}

/**
 * Transcribe audio and return the complete text. Accepts either a file
 * path or an audio buffer.
 *
 * @param params.modelId - The identifier of the transcription model to use
 * @param params.audioChunk - Audio input as either a file path (string) or audio buffer
 * @param params.prompt - Optional initial prompt to guide the transcription
 * @param params.metadata - When true, resolves to an array of transcript
 *                          segments (`{ text, startMs, endMs, append, id }`)
 *                          instead of joined text. Whisper engine only.
 * @param options - Optional RPC options including per-call profiling
 * @returns The complete transcribed text, or — when `metadata` is true —
 *          the list of transcript segments in emission order.
 */
export function transcribe(
  params: TranscribeClientParams & { metadata: true },
  options?: RPCOptions,
): Promise<TranscribeSegment[]>;
export function transcribe(
  params: TranscribeClientParams,
  options?: RPCOptions,
): Promise<string>;
export async function transcribe(
  params: TranscribeClientParams,
  options?: RPCOptions,
): Promise<string | TranscribeSegment[]> {
  const request = buildTranscribeRequest(params);

  if (params.metadata === true) {
    const segments: TranscribeSegment[] = [];
    for await (const response of stream(request, options)) {
      if (response.type === "transcribe") {
        const parsed = transcribeResponseSchema.parse(response);

        if (parsed.segment) {
          segments.push(parsed.segment);
        }

        if (parsed.done) {
          break;
        }
      }
    }
    return segments;
  }

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
  params: TranscribeClientParams & { metadata: true },
  options?: RPCOptions,
): AsyncGenerator<TranscribeSegment>;
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
 * @param params.metadata - When true, the session yields transcript segment
 *                          objects (`{ text, startMs, endMs, append, id }`)
 *                          instead of plain text. Whisper engine only.
 * @returns A session object: call `write(buffer)` to feed audio,
 *          iterate with `for await (...)` to receive transcription,
 *          and `end()` to signal end of audio.
 */
export function transcribeStream(
  params: TranscribeStreamClientParams & { metadata: true },
  options?: RPCOptions,
): Promise<TranscribeStreamMetadataSession>;
export function transcribeStream(
  params: TranscribeStreamClientParams,
  options?: RPCOptions,
): Promise<TranscribeStreamSession>;

export function transcribeStream(
  params: TranscribeClientParams | TranscribeStreamClientParams,
  options?: RPCOptions,
):
  | AsyncGenerator<string>
  | AsyncGenerator<TranscribeSegment>
  | Promise<TranscribeStreamSession>
  | Promise<TranscribeStreamMetadataSession> {
  if ("audioChunk" in params && params.audioChunk !== undefined) {
    logger.warn(
      "transcribeStream() with audioChunk is deprecated — use transcribe() instead.",
    );
    if (params.metadata === true) {
      return transcribeStreamWithAudioMetadata(params, options);
    }
    return transcribeStreamWithAudio(params, options);
  }
  const streamParams = params as TranscribeStreamClientParams;
  if (streamParams.metadata === true) {
    return transcribeStreamDuplexMetadata(streamParams, options);
  }
  return transcribeStreamDuplex(streamParams, options);
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

async function* transcribeStreamWithAudioMetadata(
  params: TranscribeClientParams,
  options?: RPCOptions,
): AsyncGenerator<TranscribeSegment> {
  const request = buildTranscribeRequest(params);

  for await (const response of stream(request, options)) {
    if (response.type === "transcribe") {
      const parsed = transcribeResponseSchema.parse(response);
      if (parsed.segment) yield parsed.segment;
      if (parsed.done) break;
    }
  }
}

function buildTranscribeStreamRequest(
  params: TranscribeStreamClientParams,
): TranscribeStreamRequest {
  return {
    type: "transcribeStream",
    modelId: params.modelId,
    ...(params.prompt && { prompt: params.prompt }),
    ...(params.metadata === true && { metadata: true }),
  };
}

async function transcribeStreamDuplex(
  params: TranscribeStreamClientParams,
  options?: RPCOptions,
): Promise<TranscribeStreamSession> {
  const request = buildTranscribeStreamRequest(params);

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

async function transcribeStreamDuplexMetadata(
  params: TranscribeStreamClientParams,
  options?: RPCOptions,
): Promise<TranscribeStreamMetadataSession> {
  const request = buildTranscribeStreamRequest(params);

  const { requestStream, responseStream } = await duplex(request, options);

  const responses = parseResponseLinesMetadata(responseStream);
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

async function* parseResponseLinesMetadata(
  responseStream: DuplexReadable,
): AsyncGenerator<TranscribeSegment> {
  let buf = "";

  for await (const chunk of responseStream) {
    buf += chunk.toString();
    const lines = buf.split("\n");
    buf = lines.pop() || "";

    for (const line of lines) {
      const result = processLineMetadata(line);
      if (result === null) return;
      if (result !== undefined) yield result;
    }
  }

  if (buf.trim()) {
    const result = processLineMetadata(buf);
    if (result !== null && result !== undefined) yield result;
  }
}

function parseResponseLine(line: string): TranscribeStreamResponse | null {
  if (!line.trim()) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    logger.warn("transcribeStream: malformed JSON from server:", line);
    return null;
  }

  const obj = parsed as Record<string, unknown>;
  if (obj["type"] === "error") {
    throw new TranscriptionFailedError(
      (obj["message"] as string) ?? "Unknown server error",
    );
  }

  return transcribeStreamResponseSchema.parse(parsed);
}

function processLine(line: string): string | undefined | null {
  const response = parseResponseLine(line);
  if (response === null) return undefined;
  if (response.error) throw new TranscriptionFailedError(response.error);
  if (response.done) return null;
  if (response.text?.trim()) return response.text;
  return undefined;
}

function processLineMetadata(
  line: string,
): TranscribeSegment | undefined | null {
  const response = parseResponseLine(line);
  if (response === null) return undefined;
  if (response.error) throw new TranscriptionFailedError(response.error);
  if (response.done) return null;
  if (response.segment) return response.segment;
  return undefined;
}

