/**
 * Streaming helpers for the sliding-window transcription driver in index.js.
 *
 * These are pure functions kept separate from the class so they can be
 * unit-tested in isolation (see test/unit/stitch.test.js) and so index.js
 * stays focused on lifecycle orchestration.
 */
/**
 * A whisper-style transcript segment as emitted by the native decoder.
 * Extra native fields are preserved via the index signature so segments can
 * be spread without losing metadata.
 */
export interface TranscriptSegment {
    text: string;
    t0?: number;
    t1?: number;
    windowStartTimestep?: number;
    [key: string]: unknown;
}
export interface StitchResult {
    delta: string;
    merged: string;
    bestK: number;
}
export interface StitchSegmentsResult {
    deltaSegments: TranscriptSegment[];
    merged: string;
    bestK: number;
}
/**
 * Coerce a stream chunk into a Uint8Array without copying when possible.
 * Throws INVALID_STREAM_INPUT if the chunk isn't a recognised binary form.
 */
export declare function toUint8(chunk: unknown): Uint8Array;
/**
 * Copy out the byte range [startTs, endTs) from a list of body chunks
 * (each element a Uint8Array) into a single contiguous Uint8Array.
 * The caller owns timestep->byte translation via bytesPerTimestep.
 */
export declare function sliceBody(bodyChunks: Uint8Array[], bytesPerTimestep: number, startTs: number, endTs: number, totalBytes: number): Uint8Array;
/**
 * Build an [T, C] header-prefixed buffer the addon can consume as a single
 * batch input, reusing the per-window body bytes.
 */
export declare function buildWindowBuffer(windowBody: Uint8Array, channels: number, windowTimesteps: number): Uint8Array;
export declare function normalizeWord(w: string): string;
/**
 * Text-only word-level stitch: find the longest normalised-word suffix of
 * `prevText` that also appears as a prefix of `newText`, and treat only
 * the remainder of `newText` as fresh content.
 *
 * The streaming driver in index.js uses `stitchSegments` (below) because
 * it needs to preserve per-segment timestamp metadata. `stitchMerge` is
 * retained as a public text-only helper for callers that only have raw
 * transcript strings to merge (e.g. post-hoc analysis, unit testing the
 * overlap algorithm without constructing segment objects) and as the
 * reference implementation of the underlying word-overlap logic.
 *
 * Returns { delta, merged, bestK }:
 *  - delta:  the newly-discovered tail
 *  - merged: prevText extended by delta
 *  - bestK:  number of words absorbed as overlap (for inspection/tests)
 *
 * maxWords caps the search depth so pathological inputs stay O(maxWords^2).
 * Known limitation: legitimate immediate word repetitions at a window
 * boundary (e.g. "the the") will collapse; acceptable for v1 sliding
 * window until a segmentation model replaces this.
 */
export declare function stitchMerge(prevText: string, newText: string, maxWords: number): StitchResult;
/**
 * Segment-aware variant of stitchMerge: preserves the per-segment
 * timestamp/metadata fields emitted by the native decoder.
 *
 * `segments` is the array returned by a per-window decode (each entry is
 * a whisper-style `{ text, t0, t1, ... }`). We run the same word-level
 * overlap detection but trim the leading `bestK` words from the incoming
 * segments rather than flattening to a single string.
 *
 * `windowStartTimestep` is attached to every emitted segment so
 * consumers can correlate a window-local `t0`/`t1` back to the absolute
 * position in the input stream.
 *
 * Returns:
 *   - deltaSegments: trimmed segments the driver should emit as an update
 *       (segments fully absorbed by the overlap are dropped; a segment
 *       partially overlapped gets its `text` rewritten to the surviving
 *       tail words).
 *   - merged: running transcript text (identical to stitchMerge.merged)
 *   - bestK: for inspection / tests
 */
export declare function stitchSegments(prevText: string, segments: TranscriptSegment[], maxWords: number, windowStartTimestep?: number): StitchSegmentsResult;
