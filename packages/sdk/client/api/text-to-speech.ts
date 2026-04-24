import {
  ttsResponseSchema,
  textToSpeechStreamResponseSchema,
  type TtsClientParams,
  type TtsRequest,
  type RPCOptions,
  type TtsResponse,
  type TextToSpeechStreamRequest,
  type TextToSpeechStreamResponse,
  type TextToSpeechStreamClientParams,
  type TextToSpeechStreamSession,
  type TextToSpeechStreamResult,
  type TtsSentenceChunkUpdate,
} from "@/schemas";
import { stream as streamRpc, duplex, type DuplexReadable } from "@/client/rpc/rpc-client";
import { getClientLogger } from "@/logging";
import { TextToSpeechStreamFailedError } from "@/utils/errors-client";

const logger = getClientLogger();

/**
 * Fan-out queue that lets multiple consumers iterate the same TTS RPC stream
 * independently. Items are retained only until every active subscriber has
 * consumed them, then trimmed from the queue.
 */
class TtsMulticast {
  private readonly queue: TtsResponse[] = [];
  private readonly waiters: Array<() => void> = [];
  private readonly subscriberIndexes: number[] = [];
  private ended = false;
  private fatal: Error | undefined;
  private readonly resolvePumpDone: (value: boolean) => void;

  readonly done: Promise<boolean>;

  constructor(request: TtsRequest, options: RPCOptions | undefined) {
    let resolve!: (value: boolean) => void;
    this.done = new Promise<boolean>((r) => {
      resolve = r;
    });
    this.resolvePumpDone = resolve;
    void this.pump(request, options);
  }

  subscribe(): AsyncGenerator<TtsResponse> {
    const subIdx = this.subscriberIndexes.length;
    this.subscriberIndexes.push(0);
    return this.drain(subIdx);
  }

  private notify(): void {
    for (const fn of this.waiters.splice(0)) fn();
  }

  private trimConsumed(): void {
    if (this.subscriberIndexes.length === 0) return;
    // `Number.POSITIVE_INFINITY` marks an unsubscribed slot; ignore those when
    // computing how far every live subscriber has advanced.
    const minIndex = Math.min(...this.subscriberIndexes);
    if (!Number.isFinite(minIndex)) return;
    if (minIndex > 0) {
      this.queue.splice(0, minIndex);
      for (let j = 0; j < this.subscriberIndexes.length; j++) {
        const v = this.subscriberIndexes[j] ?? 0;
        if (Number.isFinite(v)) this.subscriberIndexes[j] = v - minIndex;
      }
    }
  }

  private unsubscribe(subIdx: number): void {
    // Park the slot at +Infinity instead of splicing so every other
    // subscriber's `subIdx` stays valid. `trimConsumed` filters these out.
    this.subscriberIndexes[subIdx] = Number.POSITIVE_INFINITY;
    this.trimConsumed();
  }

  private async pump(
    request: TtsRequest,
    options: RPCOptions | undefined,
  ): Promise<void> {
    try {
      for await (const response of streamRpc(request, options)) {
        if (response.type !== "textToSpeech") continue;
        const m = ttsResponseSchema.parse(response);
        this.queue.push(m);
        this.notify();
        if (m.done) break;
      }
    } catch (e) {
      this.fatal = e instanceof Error ? e : new Error(String(e));
    } finally {
      this.ended = true;
      this.notify();
      this.resolvePumpDone(this.fatal === undefined);
    }
  }

  private async *drain(subIdx: number): AsyncGenerator<TtsResponse> {
    // If the consumer breaks out of a `for await` (or calls `.return()` /
    // throws), this generator's finally block runs; release the slot so it
    // no longer pins `trimConsumed`'s min-index and the queue can be GC'd.
    try {
      while (true) {
        while ((this.subscriberIndexes[subIdx] ?? 0) < this.queue.length) {
          const currentIdx = this.subscriberIndexes[subIdx] ?? 0;
          const item = this.queue[currentIdx] as TtsResponse;
          this.subscriberIndexes[subIdx] = currentIdx + 1;
          this.trimConsumed();
          yield item;
        }
        if (this.fatal) throw this.fatal;
        if (this.ended) return;
        await new Promise<void>((resolve) => {
          this.waiters.push(resolve);
        });
      }
    } finally {
      this.unsubscribe(subIdx);
    }
  }
}

function buildTtsRequest(params: TtsClientParams): TtsRequest {
  return {
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
}

function buildTextToSpeechStreamRequest(
  params: TextToSpeechStreamClientParams,
): TextToSpeechStreamRequest {
  return {
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
}

export function textToSpeech(
  params: TtsClientParams,
  options?: RPCOptions,
): TextToSpeechStreamResult {
  // `sentenceStream` is only meaningful when the response is streamed; the
  // collect path ignores it entirely, so accepting this combination would
  // silently return an empty `chunkUpdates` generator and drop per-sentence
  // metadata. Fail fast instead of running through the wrong branch.
  if (params.sentenceStream === true && params.stream === false) {
    throw new Error(
      "textToSpeech: `sentenceStream: true` requires `stream: true`",
    );
  }

  const request = buildTtsRequest(params);

  if (params.stream && params.sentenceStream) {
    return sentenceStreamTts(request, options);
  }

  if (params.stream) {
    return plainStreamTts(request, options);
  }

  return collectTts(request, options);
}

function sentenceStreamTts(
  request: TtsRequest,
  options: RPCOptions | undefined,
): TextToSpeechStreamResult {
  const multicast = new TtsMulticast(request, options);
  // Subscribe eagerly, synchronously — before pump() can push its first
  // item — so both subscribers see the full queue from index 0. If we
  // deferred subscribing until the generators were iterated, the first
  // consumer could trim the queue before the second ever registered,
  // silently dropping earlier frames.
  const bufferSubscription = multicast.subscribe();
  const chunkSubscription = multicast.subscribe();

  return {
    bufferStream: sentenceBufferStream(bufferSubscription),
    chunkUpdates: sentenceChunkUpdates(chunkSubscription),
    buffer: Promise.resolve([]),
    done: multicast.done,
  };
}

async function* sentenceBufferStream(
  source: AsyncGenerator<TtsResponse>,
): AsyncGenerator<number> {
  for await (const m of source) {
    if (m.buffer.length > 0) {
      yield* m.buffer;
    }
    if (m.done) break;
  }
}

async function* sentenceChunkUpdates(
  source: AsyncGenerator<TtsResponse>,
): AsyncGenerator<TtsSentenceChunkUpdate> {
  for await (const m of source) {
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
}

function plainStreamTts(
  request: TtsRequest,
  options: RPCOptions | undefined,
): TextToSpeechStreamResult {
  let doneResolver: (value: boolean) => void = () => {};
  const done = new Promise<boolean>((resolve) => {
    doneResolver = resolve;
  });

  return {
    bufferStream: plainTtsBufferStream(request, options, doneResolver),
    buffer: Promise.resolve([]),
    done,
  };
}

async function* plainTtsBufferStream(
  request: TtsRequest,
  options: RPCOptions | undefined,
  resolveDone: (value: boolean) => void,
): AsyncGenerator<number> {
  for await (const response of streamRpc(request, options)) {
    if (response.type !== "textToSpeech") continue;
    const parsed = ttsResponseSchema.parse(response);
    if (parsed.buffer.length > 0) {
      yield* parsed.buffer;
    }
    if (parsed.done) {
      resolveDone(true);
    }
  }
}

function collectTts(
  request: TtsRequest,
  options: RPCOptions | undefined,
): TextToSpeechStreamResult {
  let doneResolver: (value: boolean) => void = () => {};
  const done = new Promise<boolean>((resolve) => {
    doneResolver = resolve;
  });

  return {
    bufferStream: emptyBufferStream(),
    buffer: collectTtsBuffer(request, options, doneResolver),
    done,
  };
}

async function* emptyBufferStream(): AsyncGenerator<number> {
  // Non-streaming mode exposes no incremental buffer stream.
}

async function collectTtsBuffer(
  request: TtsRequest,
  options: RPCOptions | undefined,
  resolveDone: (value: boolean) => void,
): Promise<number[]> {
  let buffer: number[] = [];
  for await (const response of streamRpc(request, options)) {
    if (response.type !== "textToSpeech") continue;
    const parsed = ttsResponseSchema.parse(response);
    buffer = buffer.concat(parsed.buffer);
    if (parsed.done) {
      resolveDone(true);
    }
  }
  return buffer;
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
  const request = buildTextToSpeechStreamRequest(params);

  const { requestStream, responseStream } = await duplex(request, options);

  const responses = parseTextToSpeechStreamLines(responseStream);
  let consumed = false;
  // `closed` flips on `end()` or `destroy()`. Without this guard a late
  // `write()` would propagate a raw Bare/Node "write after end" stream error
  // to the caller. Throwing a typed SDK error keeps the duplex session
  // surface predictable.
  let closed = false;

  return {
    write(textFragment: string | Buffer) {
      if (closed) {
        throw new TextToSpeechStreamFailedError(
          "TextToSpeechStreamSession.write() called after end()/destroy()",
        );
      }
      const buf =
        typeof textFragment === "string"
          ? Buffer.from(textFragment, "utf8")
          : textFragment;
      requestStream.write(buf);
    },
    end() {
      if (closed) return;
      closed = true;
      requestStream.end();
    },
    destroy() {
      closed = true;
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
      if (yielded === undefined) continue;
      yield yielded;
      // Close the stream after the terminal frame so consumers don't
      // depend on the server closing the socket to stop iteration.
      if (yielded.done) return;
    }
  }

  if (buf.trim()) {
    const yielded = processTextToSpeechStreamLine(buf);
    if (yielded !== undefined) {
      yield yielded;
    }
  }
}

function processTextToSpeechStreamLine(
  line: string,
): TextToSpeechStreamResponse | undefined {
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

  return textToSpeechStreamResponseSchema.parse(parsed);
}
