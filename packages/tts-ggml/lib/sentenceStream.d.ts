import type { QvacResponse } from "@qvac/infer-base";
import type { TTSJobData } from "../tts";
import type { JobFields } from "./jobFields";
import type { NativeOutputChunk, NativeStats, RunStreamingOptions, RuntimeStats, SentenceStreamChunkMeta, SentenceStreamOptions, TextStreamInput, TTSOutputChunk } from "./types";
export type SentenceStreamResponse = QvacResponse<TTSOutputChunk & SentenceStreamChunkMeta>;
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
    jobFields?: JobFields;
}
export declare function normalizeError(error: unknown): string | Error;
export declare function ttsOutputDebugString(data: unknown): string;
export declare function isAudioOutputEvent(data: unknown): data is NativeOutputChunk;
export declare function isStatsEvent(data: unknown): data is NativeStats;
/**
 * What `tokensPerSecond` counts. Audio8 paces on the codec frame grid and
 * reports frames per second in batch synthesis; the text-paced engines report
 * characters per second. Streaming has to keep the same unit as `run()` or the
 * number silently changes meaning between the two entry points.
 */
export declare function emptyStreamAccumulator(): StreamAccumulator;
export declare function computeSentenceStreamStats(chunks: string[], accumulator: StreamAccumulator, countsFrames: boolean): RuntimeStats;
export declare function resolveRunStreamingOptions(textStream: TextStreamInput, options: RunStreamingOptions): Required<Pick<RunStreamingOptions, "accumulateSentences" | "sentenceDelimiterPreset" | "flushAfterMs">> & Pick<RunStreamingOptions, "maxBufferScalars" | "sentenceDelimiter">;
export declare function normalizeTextStream(textStream: TextStreamInput): AsyncIterable<string>;
/** `run({ streamOutput: true })` splits its text, so it needs a non-empty string. */
export declare function requireStreamOutputText(input: unknown): string;
/** The sentence chunks of `text`; an input that yields none is an error. */
export declare function splitSentenceChunks(text: string, options: SentenceStreamOptions, language: string | undefined): string[];
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
export declare class SentenceStreamer {
    private readonly host;
    /** The active stream, or null between streams. */
    ctx: SentenceStreamContext | null;
    constructor(host: SentenceStreamHost);
    streamChunks(chunks: string[], jobFields?: JobFields): SentenceStreamResponse;
    streamText(source: AsyncIterable<string>, jobFields?: JobFields): SentenceStreamResponse;
    rejectActiveChunk(error: unknown): void;
    fail(reason: string | Error): void;
    enrich(data: NativeOutputChunk): TTSOutputChunk & SentenceStreamChunkMeta;
    /**
     * Folds a chunk's stats into the aggregate and releases the chunk; after the
     * last pre-chunked sentence, ends the job. Returns false when no stream is
     * active, so the caller can end a plain job with the stats as they are.
     */
    onStats(data: NativeStats): boolean;
    private abort;
    private driveChunks;
    private driveText;
    private synthesizeChunk;
}
