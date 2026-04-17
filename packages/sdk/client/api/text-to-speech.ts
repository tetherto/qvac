import {
  ttsResponseSchema,
  textToSpeechStreamResponseSchema,
  type TtsClientParams,
  type TtsRequest,
  type RPCOptions,
  type TtsResponse,
  type TtsSentenceChunkUpdate,
  type TextToSpeechStreamRequest,
  type TextToSpeechStreamResponse,
  type TextToSpeechStreamClientParams,
  type TextToSpeechStreamSession,
} from "@/schemas";
import { stream as streamRpc, duplex, type DuplexReadable } from "@/client/rpc/rpc-client";
import { getClientLogger } from "@/logging";
import { TextToSpeechStreamFailedError } from "@/utils/errors-client";

const logger = getClientLogger();

export interface TextToSpeechStreamResult {
  bufferStream: AsyncGenerator<number, void, unknown>;
  chunkUpdates?: AsyncGenerator<TtsSentenceChunkUpdate, void, unknown>;
  buffer: Promise<number[]>;
  done: Promise<boolean>;
}

function createTtsMulticast(
  request: TtsRequest,
  options?: RPCOptions,
): { subscribe: () => AsyncGenerator<TtsResponse> } {
  const queue: TtsResponse[] = [];
  const waiters: Array<() => void> = [];
  let ended = false;
  let fatal: Error | undefined;

  function notify() {
    for (const fn of waiters.splice(0)) fn();
  }

  async function pump() {
    try {
      for await (const response of streamRpc(request, options)) {
        if (response.type !== "textToSpeech") continue;
        const m = ttsResponseSchema.parse(response);
        queue.push(m);
        notify();
        if (m.done) break;
      }
    } catch (e) {
      fatal = e instanceof Error ? e : new Error(String(e));
    } finally {
      ended = true;
      notify();
    }
  }

  void pump();

  function subscribe(): AsyncGenerator<TtsResponse> {
    return (async function* () {
      let i = 0;
      while (true) {
        while (i < queue.length) {
          yield queue[i] as TtsResponse;
          i += 1;
        }
        if (fatal) throw fatal;
        if (ended) return;
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
        });
      }
    })();
  }

  return { subscribe };
}

export function textToSpeech(
  params: TtsClientParams,
  options?: RPCOptions,
): TextToSpeechStreamResult {
  const request: TtsRequest = {
    type: "textToSpeech",
    modelId: params.modelId,
    inputType: params.inputType,
    text: params.text,
    stream: params.stream,
    ...(params.sentenceStream !== undefined && {
      sentenceStream: params.sentenceStream,
    }),
    ...(params.sentenceStreamLocale !== undefined && {
      sentenceStreamLocale: params.sentenceStreamLocale,
    }),
    ...(params.sentenceStreamMaxChunkScalars !== undefined && {
      sentenceStreamMaxChunkScalars: params.sentenceStreamMaxChunkScalars,
    }),
  };

  let doneResolver: (value: boolean) => void = () => {};
  const donePromise = new Promise<boolean>((resolve) => {
    doneResolver = resolve;
  });

  if (params.stream) {
    if (params.sentenceStream) {
      const { subscribe } = createTtsMulticast(request, options);

      const bufferStream = (async function* () {
        for await (const m of subscribe()) {
          if (m.buffer.length > 0) {
            yield* m.buffer;
          }
          if (m.done) {
            doneResolver(true);
            break;
          }
        }
      })();

      const chunkUpdates = (async function* () {
        for await (const m of subscribe()) {
          const hasAudio = m.buffer.length > 0;
          const hasMeta =
            m.chunkIndex !== undefined ||
            (typeof m.sentenceChunk === "string" && m.sentenceChunk.length > 0);
          if (hasAudio || hasMeta) {
            yield {
              buffer: hasAudio ? [...m.buffer] : [],
              ...(m.chunkIndex !== undefined ? { chunkIndex: m.chunkIndex } : {}),
              ...(typeof m.sentenceChunk === "string" && m.sentenceChunk.length > 0
                ? { sentenceChunk: m.sentenceChunk }
                : {}),
            };
          }
          if (m.done) break;
        }
      })();

      return {
        bufferStream,
        chunkUpdates,
        buffer: Promise.resolve([]),
        done: donePromise,
      };
    }

    const bufferStream = (async function* () {
      for await (const response of streamRpc(request, options)) {
        if (response.type === "textToSpeech") {
          const streamResponse = ttsResponseSchema.parse(response);
          if (streamResponse.buffer.length > 0) {
            yield* streamResponse.buffer;
          }
          if (streamResponse.done) {
            doneResolver(true);
          }
        }
      }
    })();

    return {
      bufferStream,
      buffer: Promise.resolve([]),
      done: donePromise,
    };
  }

  const bufferStream = (async function* () {
    // Empty generator for non-streaming mode
  })();

  const bufferPromise = (async () => {
    let buffer: number[] = [];
    for await (const response of streamRpc(request, options)) {
      if (response.type === "textToSpeech") {
        const streamResponse = ttsResponseSchema.parse(response);
        buffer = buffer.concat(streamResponse.buffer);
        if (streamResponse.done) {
          doneResolver(true);
        }
      }
    }
    return buffer;
  })();

  return {
    bufferStream,
    buffer: bufferPromise,
    done: donePromise,
  };
}

/**
 * Duplex session: write UTF-8 text fragments (e.g. LLM token deltas) via `write`. Each string or
 * Buffer should be a complete UTF-8 fragment. The worker forwards them to ONNX TTS `runStreaming`
 * (optional sentence accumulation via request fields). Iterate the session for `TextToSpeechStreamResponse`
 * lines (PCM in `buffer`, optional `chunkIndex` / `sentenceChunk`) until `done`.
 */
export async function textToSpeechStream(
  params: TextToSpeechStreamClientParams,
  options?: RPCOptions,
): Promise<TextToSpeechStreamSession> {
  const request: TextToSpeechStreamRequest = {
    type: "textToSpeechStream",
    modelId: params.modelId,
    inputType: params.inputType ?? "text",
    ...(params.accumulateSentences !== undefined && {
      accumulateSentences: params.accumulateSentences,
    }),
    ...(params.sentenceDelimiterPreset !== undefined && {
      sentenceDelimiterPreset: params.sentenceDelimiterPreset,
    }),
    ...(params.maxBufferScalars !== undefined && {
      maxBufferScalars: params.maxBufferScalars,
    }),
    ...(params.flushAfterMs !== undefined && {
      flushAfterMs: params.flushAfterMs,
    }),
  };

  const { requestStream, responseStream } = await duplex(request, options);

  const responses = parseTextToSpeechStreamLines(responseStream);
  let consumed = false;

  return {
    write(textFragment: string | Buffer) {
      const buf =
        typeof textFragment === "string"
          ? Buffer.from(textFragment, "utf8")
          : textFragment;
      requestStream.write(buf);
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
        throw new TextToSpeechStreamFailedError(
          "TextToSpeechStreamSession can only be iterated once",
        );
      }
      consumed = true;
      return responses;
    },
  };
}

async function* parseTextToSpeechStreamLines(
  responseStream: DuplexReadable,
): AsyncGenerator<TextToSpeechStreamResponse, void, unknown> {
  let buf = "";

  for await (const chunk of responseStream) {
    buf += chunk.toString();
    const lines = buf.split("\n");
    buf = lines.pop() || "";

    for (const line of lines) {
      const yielded = processTextToSpeechStreamLine(line);
      if (yielded === null) {
        return;
      }
      if (yielded !== undefined) {
        yield yielded;
      }
    }
  }

  if (buf.trim()) {
    const yielded = processTextToSpeechStreamLine(buf);
    if (yielded !== null && yielded !== undefined) {
      yield yielded;
    }
  }
}

function processTextToSpeechStreamLine(
  line: string,
): TextToSpeechStreamResponse | undefined | null {
  if (!line.trim()) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    logger.warn("textToSpeechStream: malformed JSON from server:", line);
    return undefined;
  }

  const obj = parsed as Record<string, unknown>;
  if (obj["type"] === "error") {
    throw new TextToSpeechStreamFailedError(
      (obj["message"] as string) ?? "Unknown server error",
    );
  }

  const response = textToSpeechStreamResponseSchema.parse(parsed);

  if (response.done) {
    return response;
  }

  return response;
}
