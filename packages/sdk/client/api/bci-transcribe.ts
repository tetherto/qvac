import {
  bciTranscribeResponseSchema,
  bciTranscribeClientParamsSchema,
  bciTranscribeStreamResponseSchema,
  type BciTranscribeRequest,
  type BciTranscribeClientParams,
  type BciTranscribeClientParamsParsed,
  type BciTranscribeStreamClientParams,
  type BciTranscribeStreamRequest,
  type BciTranscribeStreamResponse,
  type BciTranscribeStreamSession,
  type BciTranscribeStreamMetadataSession,
  type RPCOptions,
  type TranscribeSegment,
} from "@/schemas";
import { stream, duplex, type DuplexReadable } from "@/client/rpc/rpc-client";
import { getClientLogger } from "@/logging";
import { TranscriptionFailedError } from "@/utils/errors-client";
import { decoratePromise } from "@/utils/decorate-promise";
import { generateClientRequestId } from "@/client/api/client-request-id";

const logger = getClientLogger();

function buildBciTranscribeRequest(
  params: BciTranscribeClientParamsParsed,
  requestId: string,
): BciTranscribeRequest {
  return {
    type: "bciTranscribe",
    modelId: params.modelId,
    neuralData:
      typeof params.neuralData === "string"
        ? { type: "filePath", value: params.neuralData }
        : {
            type: "base64",
            value: Buffer.from(params.neuralData).toString("base64"),
          },
    ...(params.metadata === true && { metadata: true }),
    requestId,
  };
}

/**
 * Transcribe a neural-signal buffer with a loaded BCI model and return the
 * complete text. Accepts either a `.bin` file path or a raw neural buffer.
 *
 * @param params - BCI transcription parameters.
 * @param params.modelId - The identifier of the loaded BCI model to use.
 * @param params.neuralData - Neural signal as either a file path (string) or
 *                            a binary buffer (`Uint8Array`).
 * @param params.metadata - When true, resolves to an array of transcript
 *                          segments (`{ text, startMs, endMs, append, id }`)
 *                          instead of joined text.
 * @param options - Optional RPC options including per-call profiling.
 * @returns A promise (decorated with `requestId`) resolving to the complete
 *          transcribed text, or — when `metadata` is true — the list of
 *          transcript segments in emission order. The `requestId` is
 *          reachable synchronously so callers can target this in-flight
 *          transcription with `cancel({ requestId })` before `await` resolves.
 */
export function bciTranscribe(
  params: BciTranscribeClientParams & { metadata: true },
  options?: RPCOptions,
): Promise<TranscribeSegment[]> & { requestId: string };
export function bciTranscribe(
  params: BciTranscribeClientParams,
  options?: RPCOptions,
): Promise<string> & { requestId: string };
export function bciTranscribe(
  params: BciTranscribeClientParams,
  options?: RPCOptions,
): Promise<string | TranscribeSegment[]> & { requestId: string } {
  const parsed = bciTranscribeClientParamsSchema.parse(params);
  const requestId = generateClientRequestId();
  const inner = runBciTranscribe(parsed, requestId, options);
  return decoratePromise(inner, { requestId });
}

async function runBciTranscribe(
  params: BciTranscribeClientParamsParsed,
  requestId: string,
  options?: RPCOptions,
): Promise<string | TranscribeSegment[]> {
  const request = buildBciTranscribeRequest(params, requestId);

  if (params.metadata === true) {
    const segments: TranscribeSegment[] = [];
    for await (const response of stream(request, options)) {
      if (response.type === "bciTranscribe") {
        const parsed = bciTranscribeResponseSchema.parse(response);

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
    if (response.type === "bciTranscribe") {
      const parsed = bciTranscribeResponseSchema.parse(response);

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

function buildBciTranscribeStreamRequest(
  params: BciTranscribeStreamClientParams,
  requestId: string,
): BciTranscribeStreamRequest {
  const streamOpts = {
    ...(params.windowTimesteps !== undefined && {
      windowTimesteps: params.windowTimesteps,
    }),
    ...(params.hopTimesteps !== undefined && {
      hopTimesteps: params.hopTimesteps,
    }),
    ...(params.emit !== undefined && { emit: params.emit }),
  };

  return {
    type: "bciTranscribeStream",
    modelId: params.modelId,
    ...(params.metadata === true && { metadata: true }),
    ...(Object.keys(streamOpts).length > 0 && { streamOpts }),
    requestId,
  };
}

/**
 * Opens a bidirectional streaming BCI transcription session. Neural-signal
 * chunks are streamed in via `write()`, and transcription is yielded as the
 * addon's sliding window decodes successive windows.
 *
 * The returned session is single-use. Attempting to iterate a second time
 * will throw a `TranscriptionFailedError`.
 *
 * @param params - Streaming BCI transcription parameters.
 * @param params.modelId - The loaded BCI model to use.
 * @param params.metadata - When true, the session yields transcript segment
 *                          objects (`{ text, startMs, endMs, append, id }`)
 *                          instead of plain text.
 * @param params.windowTimesteps - Decode window size in timesteps.
 * @param params.hopTimesteps - How far the window advances between decodes.
 * @param params.emit - `'delta'` (default) yields only the newly-discovered
 *                       tail per window; `'full'` yields the full running
 *                       transcript each update.
 * @param options - Optional RPC options including per-call profiling.
 * @returns A session object: call `write(neuralChunk)` with a `Uint8Array`
 *          to feed neural-signal bytes, iterate with `for await (...)` to
 *          receive transcription, and `end()` to signal end of input. The
 *          session exposes `requestId` synchronously for targeted
 *          `cancel({ requestId })`.
 */
export function bciTranscribeStream(
  params: BciTranscribeStreamClientParams & { metadata: true },
  options?: RPCOptions,
): Promise<BciTranscribeStreamMetadataSession>;
export function bciTranscribeStream(
  params: BciTranscribeStreamClientParams,
  options?: RPCOptions,
): Promise<BciTranscribeStreamSession>;
export function bciTranscribeStream(
  params: BciTranscribeStreamClientParams,
  options?: RPCOptions,
): Promise<BciTranscribeStreamSession | BciTranscribeStreamMetadataSession> {
  if (params.metadata === true) {
    return createBciStreamSession(
      params,
      options,
      processLineMetadata,
      "BciTranscribeStreamMetadataSession",
    );
  }
  return createBciStreamSession(
    params,
    options,
    processLine,
    "BciTranscribeStreamSession",
  );
}

async function createBciStreamSession<T>(
  params: BciTranscribeStreamClientParams,
  options: RPCOptions | undefined,
  process: (line: string) => T | undefined | null,
  sessionName: string,
): Promise<{
  requestId: string;
  write(neuralChunk: Uint8Array): void;
  end(): void;
  destroy(): void;
  [Symbol.asyncIterator](): AsyncIterator<T>;
}> {
  const requestId = generateClientRequestId();
  const request = buildBciTranscribeStreamRequest(params, requestId);

  const { requestStream, responseStream } = await duplex(request, options);

  const responses = parseLines(responseStream, process);
  let consumed = false;

  return {
    requestId,
    write(neuralChunk: Uint8Array) {
      requestStream.write(neuralChunk);
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
          `${sessionName} can only be iterated once`,
        );
      }
      consumed = true;
      return responses;
    },
  };
}

/**
 * Line-delimited parser: reads newline-separated frames from a duplex
 * response stream, passes each non-empty line through `process`, and yields
 * whatever values it returns. `null` from `process` terminates the stream.
 */
async function* parseLines<T>(
  responseStream: DuplexReadable,
  process: (line: string) => T | undefined | null,
): AsyncGenerator<T> {
  let buf = "";

  for await (const chunk of responseStream) {
    buf += chunk.toString();
    const lines = buf.split("\n");
    buf = lines.pop() || "";

    for (const line of lines) {
      const result = process(line);
      if (result === null) return;
      if (result !== undefined) yield result;
    }
  }

  if (buf.trim()) {
    const result = process(buf);
    if (result !== null && result !== undefined) yield result;
  }
}

function parseResponseLine(line: string): BciTranscribeStreamResponse | null {
  if (!line.trim()) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    logger.warn("bciTranscribeStream: malformed JSON from server:", line);
    return null;
  }

  const obj = parsed as Record<string, unknown>;
  if (obj["type"] === "error") {
    throw new TranscriptionFailedError(
      (obj["message"] as string) ?? "Unknown server error",
    );
  }

  return bciTranscribeStreamResponseSchema.parse(parsed);
}

/**
 * Shared wire-frame decoder. Returns `null` for the terminal `done` frame,
 * `undefined` for frames the caller should skip, or the value extracted from
 * the frame.
 */
function processWith<T>(
  line: string,
  extract: (response: BciTranscribeStreamResponse) => T | undefined,
): T | undefined | null {
  const response = parseResponseLine(line);
  if (response === null) return undefined;
  if (response.error) throw new TranscriptionFailedError(response.error);
  if (response.done) return null;
  return extract(response);
}

function processLine(line: string): string | undefined | null {
  return processWith(line, (response) =>
    response.text?.trim() ? response.text : undefined,
  );
}

function processLineMetadata(
  line: string,
): TranscribeSegment | undefined | null {
  return processWith(line, (response) => response.segment);
}
