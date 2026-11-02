"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SentenceStreamer = void 0;
exports.normalizeError = normalizeError;
exports.ttsOutputDebugString = ttsOutputDebugString;
exports.isAudioOutputEvent = isAudioOutputEvent;
exports.isStatsEvent = isStatsEvent;
exports.emptyStreamAccumulator = emptyStreamAccumulator;
exports.computeSentenceStreamStats = computeSentenceStreamStats;
exports.resolveRunStreamingOptions = resolveRunStreamingOptions;
exports.normalizeTextStream = normalizeTextStream;
exports.requireStreamOutputText = requireStreamOutputText;
exports.splitSentenceChunks = splitSentenceChunks;
const error_1 = require("./error");
const textChunker_1 = require("./textChunker");
const textStreamAccumulator_1 = require("./textStreamAccumulator");
function normalizeError(error) {
    return typeof error === "string"
        ? error
        : error instanceof Error
            ? error
            : new Error("Unknown TTS error");
}
function defaultAccumulateSentencesForStreamInput(textStream) {
    if (textStream == null ||
        typeof textStream === "string" ||
        Array.isArray(textStream)) {
        return false;
    }
    return (typeof textStream[Symbol.asyncIterator] === "function");
}
function ttsOutputDebugString(data) {
    if (!data)
        return "";
    if (typeof data === "string")
        return data;
    if (typeof data === "number" ||
        typeof data === "boolean" ||
        typeof data === "bigint") {
        return data.toString();
    }
    if (typeof data === "symbol")
        return data.description || "";
    if (typeof data === "function")
        return data.name;
    const value = data;
    const summary = {};
    if (value.sampleRate != null)
        summary.sampleRate = value.sampleRate;
    if (value.chunkIndex != null)
        summary.chunkIndex = value.chunkIndex;
    if (value.isLast != null)
        summary.isLast = value.isLast;
    if (value.sentenceChunk != null) {
        summary.sentenceChunk = value.sentenceChunk;
    }
    if (value.outputArray &&
        typeof value.outputArray.length === "number") {
        summary.outputArrayLen = value.outputArray.length;
    }
    return JSON.stringify(summary);
}
function isAudioOutputEvent(data) {
    return (data != null &&
        typeof data === "object" &&
        "outputArray" in data &&
        data.outputArray != null);
}
function isStatsEvent(data) {
    return (data != null &&
        typeof data === "object" &&
        ("totalTime" in data ||
            "audioDurationMs" in data ||
            "totalSamples" in data));
}
/**
 * What `tokensPerSecond` counts. Audio8 paces on the codec frame grid and
 * reports frames per second in batch synthesis; the text-paced engines report
 * characters per second. Streaming has to keep the same unit as `run()` or the
 * number silently changes meaning between the two entry points.
 */
function emptyStreamAccumulator() {
    return {
        totalTime: 0,
        audioDurationMs: 0,
        totalSamples: 0,
        generatedFrames: 0,
    };
}
function streamedTokenCount(chunks, accumulator, countsFrames) {
    return countsFrames
        ? accumulator.generatedFrames
        : chunks.join("").length;
}
function computeSentenceStreamStats(chunks, accumulator, countsFrames) {
    const { generatedFrames, ...totals } = accumulator;
    const produced = streamedTokenCount(chunks, accumulator, countsFrames);
    const stats = {
        ...totals,
        tokensPerSecond: accumulator.totalTime > 0 ? produced / accumulator.totalTime : 0,
        realTimeFactor: accumulator.audioDurationMs > 0
            ? (accumulator.totalTime * 1000) /
                accumulator.audioDurationMs
            : 0,
    };
    if (countsFrames)
        stats.generatedFrames = generatedFrames;
    return stats;
}
function emptyRuntimeStats() {
    return {
        totalTime: 0,
        tokensPerSecond: 0,
        realTimeFactor: 0,
        audioDurationMs: 0,
        totalSamples: 0,
    };
}
function resolveRunStreamingOptions(textStream, options) {
    const normalized = options == null || typeof options !== "object" ? {} : options;
    let accumulateSentences = normalized.accumulateSentences;
    if (accumulateSentences === undefined) {
        accumulateSentences =
            defaultAccumulateSentencesForStreamInput(textStream);
    }
    return {
        accumulateSentences: !!accumulateSentences,
        sentenceDelimiterPreset: normalized.sentenceDelimiterPreset === "latin" ||
            normalized.sentenceDelimiterPreset === "cjk" ||
            normalized.sentenceDelimiterPreset === "multilingual"
            ? normalized.sentenceDelimiterPreset
            : "multilingual",
        maxBufferScalars: normalized.maxBufferScalars,
        flushAfterMs: normalized.flushAfterMs ?? textStreamAccumulator_1.DEFAULT_FLUSH_AFTER_MS,
        sentenceDelimiter: normalized.sentenceDelimiter instanceof RegExp
            ? normalized.sentenceDelimiter
            : undefined,
    };
}
function normalizeTextStream(textStream) {
    if (textStream == null) {
        throw new error_1.QvacErrorAddonTTSGgml({
            code: error_1.ERR_CODES.FAILED_TO_APPEND,
            adds: "runStreaming: text stream is required",
        });
    }
    if (typeof textStream === "string") {
        // eslint-disable-next-line @typescript-eslint/require-await -- async iterable shape is required by the public API.
        return (async function* oneString() {
            yield textStream;
        })();
    }
    if (typeof textStream[Symbol.asyncIterator] === "function") {
        return textStream;
    }
    if (Array.isArray(textStream) ||
        typeof textStream[Symbol.iterator] === "function") {
        // eslint-disable-next-line @typescript-eslint/require-await -- adapts synchronous iterables to the async iterable contract.
        return (async function* fromIterable() {
            for (const value of textStream) {
                yield value;
            }
        })();
    }
    throw new error_1.QvacErrorAddonTTSGgml({
        code: error_1.ERR_CODES.FAILED_TO_APPEND,
        adds: "runStreaming: expected string, array of strings, Iterable, or AsyncIterable",
    });
}
/** `run({ streamOutput: true })` splits its text, so it needs a non-empty string. */
function requireStreamOutputText(input) {
    if (typeof input !== "string" || input.trim().length === 0) {
        throw new error_1.QvacErrorAddonTTSGgml({
            code: error_1.ERR_CODES.FAILED_TO_APPEND,
            adds: "run with streamOutput: non-empty string `input` is required",
        });
    }
    return input;
}
/** The sentence chunks of `text`; an input that yields none is an error. */
function splitSentenceChunks(text, options, language) {
    const chunks = (0, textChunker_1.splitTtsText)(String(text), {
        language,
        locale: options.locale,
        maxScalars: options.maxChunkScalars,
    });
    if (chunks.length === 0) {
        throw new error_1.QvacErrorAddonTTSGgml({
            code: error_1.ERR_CODES.FAILED_TO_APPEND,
            adds: "chunked synthesis: text produced no chunks after split",
        });
    }
    return chunks;
}
function mergeSentenceStreamStats(accumulator, data) {
    if (accumulator.firstAudioMs === undefined &&
        typeof data.firstAudioMs === "number" &&
        Number.isFinite(data.firstAudioMs) &&
        data.firstAudioMs >= 0) {
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
/**
 * Drives one sentence stream at a time. The wrapper routes native output and
 * stats events here while a context is active; a newer stream, a cancel or a
 * reload replaces or clears the context, and the driver of the old stream
 * notices and stops.
 */
class SentenceStreamer {
    host;
    /** The active stream, or null between streams. */
    ctx = null;
    constructor(host) {
        this.host = host;
    }
    streamChunks(chunks, jobFields) {
        const response = this.host.startJob();
        const context = {
            chunks,
            chunkIdx: 0,
            acc: emptyStreamAccumulator(),
            chunkResolver: null,
            jobFields,
        };
        this.ctx = context;
        void this.driveChunks(context).catch((error) => this.abort(context, error));
        return response;
    }
    streamText(source, jobFields) {
        const response = this.host.startJob();
        const context = {
            textStreamMode: true,
            asyncTextSource: source,
            chunks: [],
            chunkIdx: 0,
            acc: emptyStreamAccumulator(),
            chunkResolver: null,
            jobFields,
        };
        this.ctx = context;
        void this.driveText(context, source).catch((error) => this.abort(context, error));
        return response;
    }
    rejectActiveChunk(error) {
        const resolver = this.ctx?.chunkResolver;
        if (!resolver)
            return;
        this.ctx.chunkResolver = null;
        resolver.reject(error);
    }
    fail(reason) {
        this.rejectActiveChunk(reason instanceof Error ? reason : new Error(reason));
        this.ctx = null;
        this.host.failJob(reason);
    }
    enrich(data) {
        const context = this.ctx;
        if (!context) {
            return data;
        }
        const index = context.chunkIdx;
        const enriched = {
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
    onStats(data) {
        const context = this.ctx;
        if (!context)
            return false;
        mergeSentenceStreamStats(context.acc, data);
        if (context.chunkResolver) {
            context.chunkResolver.resolve();
            context.chunkResolver = null;
        }
        if (!context.textStreamMode &&
            context.chunkIdx >= context.chunks.length - 1) {
            this.host.endJob(computeSentenceStreamStats(context.chunks, context.acc, this.host.countsFrames()));
        }
        return true;
    }
    abort(context, error) {
        if (context !== this.ctx)
            return;
        this.rejectActiveChunk(error);
        this.ctx = null;
        this.host.failJob(normalizeError(error));
    }
    async driveChunks(context) {
        for (let index = 0; index < context.chunks.length; index++) {
            if (context !== this.ctx)
                return;
            context.chunkIdx = index;
            await this.synthesizeChunk(context, context.chunks[index]);
        }
        if (context !== this.ctx)
            return;
        this.ctx = null;
    }
    async driveText(context, source) {
        try {
            for await (const piece of source) {
                if (context !== this.ctx)
                    return;
                const text = String(piece).trim();
                if (text.length === 0)
                    continue;
                context.chunks.push(text);
                context.chunkIdx = context.chunks.length - 1;
                await this.synthesizeChunk(context, text);
            }
        }
        catch (error) {
            this.abort(context, error);
            return;
        }
        if (context !== this.ctx)
            return;
        this.ctx = null;
        this.host.endJob(context.chunks.length === 0
            ? emptyRuntimeStats()
            : computeSentenceStreamStats(context.chunks, context.acc, this.host.countsFrames()));
    }
    async synthesizeChunk(context, text) {
        const done = new Promise((resolve, reject) => {
            context.chunkResolver = { resolve, reject };
        });
        // Dispatch may fail before the completion promise is awaited.
        void done.catch(() => { });
        await this.host.dispatchJob({
            type: "text",
            input: text,
            ...(context.jobFields ?? {}),
        });
        await done;
    }
}
exports.SentenceStreamer = SentenceStreamer;
