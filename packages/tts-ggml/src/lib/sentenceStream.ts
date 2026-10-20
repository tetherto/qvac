import type { QvacResponse } from "@qvac/infer-base";
import type { TTSJobData } from "../tts";
import { ERR_CODES, QvacErrorAddonTTSGgml } from "./error";
import type { JobFields } from "./jobFields";
import { splitTtsText } from "./textChunker";
import { DEFAULT_FLUSH_AFTER_MS } from "./textStreamAccumulator";
import type {
  NativeOutputChunk,
  NativeStats,
  RunStreamingOptions,
  RuntimeStats,
  SentenceStreamChunkMeta,
  SentenceStreamOptions,
  TextStreamInput,
  TTSOutputChunk,
} from "./types";

export type SentenceStreamResponse = QvacResponse<
  TTSOutputChunk & SentenceStreamChunkMeta
>;

export interface ChunkResolver {
  resolve(): void;
  reject(error: unknown): void;
}

export interface StreamAccumulator {
  firstAudioMs?: number;
  totalTime: number;
  audioDurationMs: number;
  totalSamples: number;
  generatedFrames: number;
  codecSidecarLoaded?: number;
  codecOnCoreml?: number;
}

export interface SentenceStreamContext {
  textStreamMode?: boolean;
  asyncTextSource?: AsyncIterable<string>;
  chunks: string[];
  chunkIdx: number;
  acc: StreamAccumulator;
  chunkResolver: ChunkResolver | null;
  // Per-response engine fields (Parler description/template, Audio8 voice),
  // replayed on every chunk's jobData so the native caches they key -- the T5
  // cross-KV, the encoded reference voice -- stay hot across the stream.
  jobFields?: JobFields;
}

export function normalizeError(error: unknown): string | Error {
  return typeof error === "string"
    ? error
    : error instanceof Error
      ? error
      : new Error("Unknown TTS error");
}

function defaultAccumulateSentencesForStreamInput(
  textStream: TextStreamInput | null | undefined,
): boolean {
  if (
    textStream == null ||
    typeof textStream === "string" ||
    Array.isArray(textStream)
  ) {
    return false;
  }
  return (
    typeof (
      textStream as {
        [Symbol.asyncIterator]?: unknown;
      }
    )[Symbol.asyncIterator] === "function"
  );
}

export function ttsOutputDebugString(data: unknown): string {
  if (!data) return "";
  if (typeof data === "string") return data;
  if (
    typeof data === "number" ||
    typeof data === "boolean" ||
    typeof data === "bigint"
  ) {
    return data.toString();
  }
  if (typeof data === "symbol") return data.description || "";
  if (typeof data === "function") return data.name;
  const value = data as {
    sampleRate?: unknown;
    chunkIndex?: unknown;
    isLast?: unknown;
    sentenceChunk?: unknown;
    outputArray?: { length?: unknown };
  };
  const summary: Record<string, unknown> = {};
  if (value.sampleRate != null) summary.sampleRate = value.sampleRate;
  if (value.chunkIndex != null) summary.chunkIndex = value.chunkIndex;
  if (value.isLast != null) summary.isLast = value.isLast;
  if (value.sentenceChunk != null) {
    summary.sentenceChunk = value.sentenceChunk;
  }
  if (
    value.outputArray &&
    typeof value.outputArray.length === "number"
  ) {
    summary.outputArrayLen = value.outputArray.length;
  }
  return JSON.stringify(summary);
}

export function isAudioOutputEvent(data: unknown): data is NativeOutputChunk {
  return (
    data != null &&
    typeof data === "object" &&
    "outputArray" in data &&
    data.outputArray != null
  );
}

export function isStatsEvent(data: unknown): data is NativeStats {
  return (
    data != null &&
    typeof data === "object" &&
    ("totalTime" in data ||
      "audioDurationMs" in data ||
      "totalSamples" in data)
  );
}

/**
 * What `tokensPerSecond` counts. Audio8 paces on the codec frame grid and
 * reports frames per second in batch synthesis; the text-paced engines report
 * characters per second. Streaming has to keep the same unit as `run()` or the
 * number silently changes meaning between the two entry points.
 */
export function emptyStreamAccumulator(): StreamAccumulator {
  return {
    totalTime: 0,
    audioDurationMs: 0,
    totalSamples: 0,
    generatedFrames: 0,
  };
}

function streamedTokenCount(
  chunks: string[],
  accumulator: StreamAccumulator,
  countsFrames: boolean,
): number {
  return countsFrames
    ? accumulator.generatedFrames
    : chunks.join("").length;
}

export function computeSentenceStreamStats(
  chunks: string[],
  accumulator: StreamAccumulator,
  countsFrames: boolean,
): RuntimeStats {
  const { generatedFrames, ...totals } = accumulator;
  const produced = streamedTokenCount(chunks, accumulator, countsFrames);
  const stats: RuntimeStats = {
    ...totals,
    tokensPerSecond:
      accumulator.totalTime > 0 ? produced / accumulator.totalTime : 0,
    realTimeFactor:
      accumulator.audioDurationMs > 0
        ? (accumulator.totalTime * 1000) /
          accumulator.audioDurationMs
        : 0,
  };
  if (countsFrames) stats.generatedFrames = generatedFrames;
  return stats;
}

function emptyRuntimeStats(): RuntimeStats {
  return {
    totalTime: 0,
    tokensPerSecond: 0,
    realTimeFactor: 0,
    audioDurationMs: 0,
    totalSamples: 0,
  };
}

export function resolveRunStreamingOptions(
  textStream: TextStreamInput,
  options: RunStreamingOptions,
): Required<
  Pick<
    RunStreamingOptions,
    | "accumulateSentences"
    | "sentenceDelimiterPreset"
    | "flushAfterMs"
  >
> &
  Pick<
    RunStreamingOptions,
    "maxBufferScalars" | "sentenceDelimiter"
  > {
  const normalized =
    options == null || typeof options !== "object" ? {} : options;
  let accumulateSentences = normalized.accumulateSentences;
  if (accumulateSentences === undefined) {
    accumulateSentences =
      defaultAccumulateSentencesForStreamInput(textStream);
  }
  return {
    accumulateSentences: !!accumulateSentences,
    sentenceDelimiterPreset:
      normalized.sentenceDelimiterPreset === "latin" ||
      normalized.sentenceDelimiterPreset === "cjk" ||
      normalized.sentenceDelimiterPreset === "multilingual"
        ? normalized.sentenceDelimiterPreset
        : "multilingual",
    maxBufferScalars: normalized.maxBufferScalars,
    flushAfterMs:
      normalized.flushAfterMs ?? DEFAULT_FLUSH_AFTER_MS,
    sentenceDelimiter:
      normalized.sentenceDelimiter instanceof RegExp
        ? normalized.sentenceDelimiter
        : undefined,
  };
}

export function normalizeTextStream(
  textStream: TextStreamInput,
): AsyncIterable<string> {
  if (textStream == null) {
    throw new QvacErrorAddonTTSGgml({
      code: ERR_CODES.FAILED_TO_APPEND,
      adds: "runStreaming: text stream is required",
    });
  }
  if (typeof textStream === "string") {
    // eslint-disable-next-line @typescript-eslint/require-await -- async iterable shape is required by the public API.
    return (async function* oneString() {
      yield textStream;
    })();
  }
  if (
    typeof (
      textStream as {
        [Symbol.asyncIterator]?: unknown;
      }
    )[Symbol.asyncIterator] === "function"
  ) {
    return textStream as AsyncIterable<string>;
  }
  if (
    Array.isArray(textStream) ||
    typeof (
      textStream as {
        [Symbol.iterator]?: unknown;
      }
    )[Symbol.iterator] === "function"
  ) {
    // eslint-disable-next-line @typescript-eslint/require-await -- adapts synchronous iterables to the async iterable contract.
    return (async function* fromIterable() {
      for (const value of textStream as Iterable<string>) {
        yield value;
      }
    })();
  }
  throw new QvacErrorAddonTTSGgml({
    code: ERR_CODES.FAILED_TO_APPEND,
    adds:
      "runStreaming: expected string, array of strings, Iterable, or AsyncIterable",
  });
}

/** `run({ streamOutput: true })` splits its text, so it needs a non-empty string. */
export function requireStreamOutputText(input: unknown): string {
  if (typeof input !== "string" || input.trim().length === 0) {
    throw new QvacErrorAddonTTSGgml({
      code: ERR_CODES.FAILED_TO_APPEND,
      adds: "run with streamOutput: non-empty string `input` is required",
    });
  }
  return input;
}

/** The sentence chunks of `text`; an input that yields none is an error. */
export function splitSentenceChunks(
  text: string,
  options: SentenceStreamOptions,
  language: string | undefined,
): string[] {
  const chunks = splitTtsText(String(text), {
    language,
    locale: options.locale,
    maxScalars: options.maxChunkScalars,
  });
  if (chunks.length === 0) {
    throw new QvacErrorAddonTTSGgml({
      code: ERR_CODES.FAILED_TO_APPEND,
      adds: "chunked synthesis: text produced no chunks after split",
    });
  }
  return chunks;
}

function mergeSentenceStreamStats(
  accumulator: StreamAccumulator,
  data: NativeStats,
): void {
  if (
    accumulator.firstAudioMs === undefined &&
    typeof data.firstAudioMs === "number" &&
    Number.isFinite(data.firstAudioMs) &&
    data.firstAudioMs >= 0
  ) {
    accumulator.firstAudioMs = data.firstAudioMs;
  }
  accumulator.totalTime +=
    typeof data.totalTime === "number" ? data.totalTime : 0;
  accumulator.audioDurationMs +=
    typeof data.audioDurationMs === "number"
      ? data.audioDurationMs
      : 0;
  accumulator.totalSamples +=
    typeof data.totalSamples === "number" ? data.totalSamples : 0;
  accumulator.generatedFrames +=
    typeof data.generatedFrames === "number" ? data.generatedFrames : 0;
  if (typeof data.codecSidecarLoaded === "number") {
    accumulator.codecSidecarLoaded = data.codecSidecarLoaded;
  }
  if (typeof data.codecOnCoreml === "number") {
    accumulator.codecOnCoreml = data.codecOnCoreml;
  }
}

/** What the stream driver needs from the wrapper that owns the job handler. */
export interface SentenceStreamHost {
  /** Opens the response the whole stream reports through. */
  startJob(): SentenceStreamResponse;
  dispatchJob(job: TTSJobData): Promise<void>;
  endJob(stats: RuntimeStats | NativeStats): void;
  failJob(error: string | Error): void;
  /**
   * Audio8 and MOSS report `tokensPerSecond` as codec frames per second, so
   * the streaming aggregate has to count frames too rather than characters.
   */
  countsFrames(): boolean;
}

/**
 * Drives one sentence stream at a time. The wrapper routes native output and
 * stats events here while a context is active; a newer stream, a cancel or a
 * reload replaces or clears the context, and the driver of the old stream
 * notices and stops.
 */
export class SentenceStreamer {
  /** The active stream, or null between streams. */
  ctx: SentenceStreamContext | null = null;

  constructor(private readonly host: SentenceStreamHost) {}

  streamChunks(chunks: string[], jobFields?: JobFields): SentenceStreamResponse {
    const response = this.host.startJob();
    const context: SentenceStreamContext = {
      chunks,
      chunkIdx: 0,
      acc: emptyStreamAccumulator(),
      chunkResolver: null,
      jobFields,
    };
    this.ctx = context;
    void this.driveChunks(context).catch((error: unknown) =>
      this.abort(context, error),
    );
    return response;
  }

  streamText(
    source: AsyncIterable<string>,
    jobFields?: JobFields,
  ): SentenceStreamResponse {
    const response = this.host.startJob();
    const context: SentenceStreamContext = {
      textStreamMode: true,
      asyncTextSource: source,
      chunks: [],
      chunkIdx: 0,
      acc: emptyStreamAccumulator(),
      chunkResolver: null,
      jobFields,
    };
    this.ctx = context;
    void this.driveText(context, source).catch((error: unknown) =>
      this.abort(context, error),
    );
    return response;
  }

  rejectActiveChunk(error: unknown): void {
    const resolver = this.ctx?.chunkResolver;
    if (!resolver) return;
    this.ctx!.chunkResolver = null;
    resolver.reject(error);
  }

  fail(reason: string | Error): void {
    this.rejectActiveChunk(reason instanceof Error ? reason : new Error(reason));
    this.ctx = null;
    this.host.failJob(reason);
  }

  enrich(data: NativeOutputChunk): TTSOutputChunk & SentenceStreamChunkMeta {
    const context = this.ctx;
    if (!context) {
      return data;
    }
    const index = context.chunkIdx;
    const enriched: TTSOutputChunk & SentenceStreamChunkMeta = {
      outputArray: data.outputArray,
      chunkIndex: index,
      sentenceChunk: context.chunks[index] || "",
    };
    if (data.sampleRate != null) {
      enriched.sampleRate = data.sampleRate;
    }
    if (!context.textStreamMode) {
      enriched.isLast = index >= context.chunks.length - 1 && data.isLast !== false;
    }
    return enriched;
  }

  /**
   * Folds a chunk's stats into the aggregate and releases the chunk; after the
   * last pre-chunked sentence, ends the job. Returns false when no stream is
   * active, so the caller can end a plain job with the stats as they are.
   */
  onStats(data: NativeStats): boolean {
    const context = this.ctx;
    if (!context) return false;
    mergeSentenceStreamStats(context.acc, data);
    if (context.chunkResolver) {
      context.chunkResolver.resolve();
      context.chunkResolver = null;
    }
    if (
      !context.textStreamMode &&
      context.chunkIdx >= context.chunks.length - 1
    ) {
      this.host.endJob(
        computeSentenceStreamStats(
          context.chunks,
          context.acc,
          this.host.countsFrames(),
        ),
      );
    }
    return true;
  }

  private abort(context: SentenceStreamContext, error: unknown): void {
    if (context !== this.ctx) return;
    this.rejectActiveChunk(error);
    this.ctx = null;
    this.host.failJob(normalizeError(error));
  }

  private async driveChunks(context: SentenceStreamContext): Promise<void> {
    for (let index = 0; index < context.chunks.length; index++) {
      if (context !== this.ctx) return;
      context.chunkIdx = index;
      await this.synthesizeChunk(context, context.chunks[index]);
    }
    if (context !== this.ctx) return;
    this.ctx = null;
  }

  private async driveText(
    context: SentenceStreamContext,
    source: AsyncIterable<string>,
  ): Promise<void> {
    try {
      for await (const piece of source) {
        if (context !== this.ctx) return;
        const text = String(piece).trim();
        if (text.length === 0) continue;
        context.chunks.push(text);
        context.chunkIdx = context.chunks.length - 1;
        await this.synthesizeChunk(context, text);
      }
    } catch (error) {
      this.abort(context, error);
      return;
    }
    if (context !== this.ctx) return;
    this.ctx = null;
    this.host.endJob(
      context.chunks.length === 0
        ? emptyRuntimeStats()
        : computeSentenceStreamStats(
            context.chunks,
            context.acc,
            this.host.countsFrames(),
          ),
    );
  }

  private async synthesizeChunk(
    context: SentenceStreamContext,
    text: string,
  ): Promise<void> {
    const done = new Promise<void>((resolve, reject) => {
      context.chunkResolver = { resolve, reject };
    });
    // Dispatch may fail before the completion promise is awaited.
    void done.catch(() => {});
    await this.host.dispatchJob({
      type: "text",
      input: text,
      ...(context.jobFields ?? {}),
    });
    await done;
  }
}
