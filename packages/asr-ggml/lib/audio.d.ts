import type { AudioChunk, AudioInput } from "./types";
export declare const PCM_S16_SCALE = 32768;
/** Interpretation applied to raw `Uint8Array` bytes ("decoded" → "f32le"). */
export type ByteFormat = "s16le" | "f32le";
/** Bytes per sample of each supported byte interpretation. */
export declare const BYTES_PER_SAMPLE: Readonly<Record<ByteFormat, number>>;
/**
 * Bytes per sample on the wire: every driver normalizes its input to f32
 * samples before handing it to the native interface.
 */
export declare const WIRE_BYTES_PER_SAMPLE: number;
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
 * Stateful per-stream chunk normalizer.
 *
 * Byte chunks arriving from a socket, pipe or file read have arbitrary
 * lengths, so a single PCM sample can straddle a chunk boundary. The
 * pre-merge whisper package concatenated every chunk of a batch and validated
 * the byte length only once, in aggregate, in the native decoder — an odd
 * 1023/1025-byte split was harmless. Normalization is now per chunk, so the
 * trailing partial sample is carried over and joined with the next chunk;
 * only a stream that *ends* mid-sample is rejected, which is exactly the
 * aggregate check the native decoder used to perform.
 */
export declare function createChunkNormalizer(byteFormat: ByteFormat): {
    push(chunk: AudioChunk): Float32Array;
    flush(): void;
};
/**
 * Normalizes any public {@link AudioInput} shape into a stream of f32
 * chunks. Shared by both engine drivers; `byteFormat` is the driver's
 * interpretation of raw `Uint8Array` bytes.
 */
export declare function normalizeAudioStream(input: AudioInput, byteFormat: ByteFormat): AsyncIterable<Float32Array> | Iterable<Float32Array>;
