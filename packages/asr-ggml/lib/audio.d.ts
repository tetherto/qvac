import type { AudioChunk, AudioInput } from "./types";
export declare const PCM_S16_SCALE = 32768;
/** Interpretation applied to raw `Uint8Array` bytes ("decoded" → "f32le"). */
export type ByteFormat = "s16le" | "f32le";
export declare function pcmS16ToFloat32(int16Samples: Int16Array): Float32Array;
export declare function toFloat32Chunk(chunk: Uint8Array | Float32Array): Float32Array;
export declare function mergeFloat32Chunks(chunks: readonly Float32Array[]): Float32Array;
/**
 * Normalizes one audio chunk to f32 samples. The chunk's class decides its
 * interpretation; `byteFormat` only describes how raw `Uint8Array` bytes are
 * decoded.
 */
export declare function normalizeChunkToFloat32(chunk: AudioChunk, byteFormat: ByteFormat): Float32Array;
/**
 * Normalizes any public {@link AudioInput} shape into a stream of f32
 * chunks. Shared by both engine drivers; `byteFormat` is the driver's
 * interpretation of raw `Uint8Array` bytes.
 */
export declare function normalizeAudioStream(input: AudioInput, byteFormat: ByteFormat): AsyncIterable<Float32Array> | Iterable<Float32Array>;
