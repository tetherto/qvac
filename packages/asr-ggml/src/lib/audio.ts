import { QvacErrorAddonASRGgml, ERR_CODES } from "./error";
import type { AudioChunk, AudioInput } from "./types";

export const PCM_S16_SCALE = 32768;

/** Interpretation applied to raw `Uint8Array` bytes ("decoded" → "f32le"). */
export type ByteFormat = "s16le" | "f32le";

/** Bytes per sample of each supported byte interpretation. */
export const BYTES_PER_SAMPLE: Readonly<Record<ByteFormat, number>> =
  Object.freeze({ s16le: 2, f32le: 4 });

/**
 * Bytes per sample on the wire: every driver normalizes its input to f32
 * samples before handing it to the native interface.
 */
export const WIRE_BYTES_PER_SAMPLE = BYTES_PER_SAMPLE.f32le;

const EMPTY_SAMPLES = new Float32Array(0);

export function pcmS16ToFloat32(int16Samples: Int16Array): Float32Array {
  const audio = new Float32Array(int16Samples.length);
  for (let i = 0; i < int16Samples.length; i++) {
    audio[i] = int16Samples[i] / PCM_S16_SCALE;
  }
  return audio;
}

export function toFloat32Chunk(
  chunk: Uint8Array | Float32Array,
): Float32Array {
  if (chunk instanceof Float32Array) {
    return chunk;
  }
  const int16Samples = new Int16Array(
    chunk.buffer,
    chunk.byteOffset,
    chunk.byteLength / 2,
  );
  return pcmS16ToFloat32(int16Samples);
}

function sumChunkLengths(chunks: readonly Float32Array[]): number {
  return chunks.reduce((total, chunk) => total + chunk.length, 0);
}

export function mergeFloat32Chunks(
  chunks: readonly Float32Array[],
): Float32Array {
  const merged = new Float32Array(sumChunkLengths(chunks));
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

function invalidAudioInput(message: string): QvacErrorAddonASRGgml {
  return new QvacErrorAddonASRGgml({
    code: ERR_CODES.INVALID_AUDIO_INPUT,
    adds: message,
  });
}

function s16BytesToFloat32(bytes: Uint8Array): Float32Array {
  if (bytes.byteLength % 2 !== 0) {
    throw invalidAudioInput(
      `s16le byte chunk length must be a multiple of 2, got ${bytes.byteLength}`,
    );
  }
  const aligned =
    bytes.byteOffset % 2 === 0
      ? bytes
      : new Uint8Array(bytes); // aligned copy
  const samples = new Int16Array(
    aligned.buffer,
    aligned.byteOffset,
    aligned.byteLength / 2,
  );
  return pcmS16ToFloat32(samples);
}

function f32BytesToFloat32(bytes: Uint8Array): Float32Array {
  if (bytes.byteLength % 4 !== 0) {
    throw invalidAudioInput(
      `f32le byte chunk length must be a multiple of 4, got ${bytes.byteLength}`,
    );
  }
  const aligned =
    bytes.byteOffset % 4 === 0
      ? bytes
      : new Uint8Array(bytes); // aligned copy
  return new Float32Array(
    aligned.buffer,
    aligned.byteOffset,
    aligned.byteLength / 4,
  );
}

/**
 * Normalizes one audio chunk to f32 samples. The chunk's class decides its
 * interpretation; `byteFormat` only describes how raw `Uint8Array` bytes are
 * decoded.
 */
export function normalizeChunkToFloat32(
  chunk: AudioChunk,
  byteFormat: ByteFormat,
): Float32Array {
  if (chunk instanceof Float32Array) return chunk;
  if (chunk instanceof Int16Array) return pcmS16ToFloat32(chunk);
  if (chunk instanceof Uint8Array) {
    return byteFormat === "f32le"
      ? f32BytesToFloat32(chunk)
      : s16BytesToFloat32(chunk);
  }
  throw invalidAudioInput(
    "Unsupported audio chunk. Expected Float32Array, Int16Array, or Uint8Array.",
  );
}

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
export function createChunkNormalizer(byteFormat: ByteFormat): {
  push(chunk: AudioChunk): Float32Array;
  flush(): void;
} {
  const sampleBytes = BYTES_PER_SAMPLE[byteFormat];
  let pending: Uint8Array | null = null;

  return {
    push(chunk: AudioChunk): Float32Array {
      if (!(chunk instanceof Uint8Array)) {
        if (pending) {
          throw invalidAudioInput(
            `${pending.byteLength} trailing ${byteFormat} byte(s) cannot be completed by a ${chunk.constructor.name} chunk`,
          );
        }
        return normalizeChunkToFloat32(chunk, byteFormat);
      }

      let bytes = chunk;
      if (pending) {
        const joined = new Uint8Array(pending.byteLength + chunk.byteLength);
        joined.set(pending, 0);
        joined.set(chunk, pending.byteLength);
        bytes = joined;
        pending = null;
      }

      const whole = bytes.byteLength - (bytes.byteLength % sampleBytes);
      if (whole < bytes.byteLength) {
        // Copy: the caller may reuse (or detach) its own buffer after append.
        pending = new Uint8Array(bytes.subarray(whole));
      }
      if (whole === 0) return EMPTY_SAMPLES;
      return normalizeChunkToFloat32(bytes.subarray(0, whole), byteFormat);
    },

    flush(): void {
      if (pending) {
        throw invalidAudioInput(
          `${byteFormat} byte stream ends mid-sample: ${pending.byteLength} trailing byte(s), expected a multiple of ${sampleBytes}`,
        );
      }
    },
  };
}

function isAudioChunk(value: unknown): value is AudioChunk {
  return (
    value instanceof Float32Array ||
    value instanceof Int16Array ||
    value instanceof Uint8Array
  );
}

async function* mapAsyncChunks(
  source: AsyncIterable<AudioChunk>,
  byteFormat: ByteFormat,
): AsyncIterable<Float32Array> {
  const normalizer = createChunkNormalizer(byteFormat);
  for await (const chunk of source) {
    const samples = normalizer.push(chunk);
    // A chunk that carried only a partial sample yields nothing; the bytes
    // are held until the next chunk completes them.
    if (samples.length > 0) yield samples;
  }
  normalizer.flush();
}

/** Normalizes an already-materialized list of chunks, in aggregate. */
function mapChunkList(
  chunks: readonly AudioChunk[],
  byteFormat: ByteFormat,
): Float32Array[] {
  const normalizer = createChunkNormalizer(byteFormat);
  const out: Float32Array[] = [];
  for (const chunk of chunks) {
    const samples = normalizer.push(chunk);
    if (samples.length > 0) out.push(samples);
  }
  normalizer.flush();
  return out;
}

/**
 * Normalizes any public {@link AudioInput} shape into a stream of f32
 * chunks. Shared by both engine drivers; `byteFormat` is the driver's
 * interpretation of raw `Uint8Array` bytes.
 */
export function normalizeAudioStream(
  input: AudioInput,
  byteFormat: ByteFormat,
): AsyncIterable<Float32Array> | Iterable<Float32Array> {
  if (!input) {
    throw invalidAudioInput("audio input is required");
  }
  if (
    typeof (input as { [Symbol.asyncIterator]?: unknown })[
      Symbol.asyncIterator
    ] === "function"
  ) {
    return mapAsyncChunks(input as AsyncIterable<AudioChunk>, byteFormat);
  }
  if (isAudioChunk(input)) {
    return mapChunkList([input], byteFormat);
  }
  if (Array.isArray(input)) {
    return mapChunkList(input, byteFormat);
  }
  if (
    typeof (input as { [Symbol.iterator]?: unknown })[Symbol.iterator] ===
    "function"
  ) {
    const items = Array.from(input as Iterable<unknown>);
    if (items.length > 0 && items.every(isAudioChunk)) {
      return mapChunkList(items, byteFormat);
    }
    // Legacy convenience: a plain iterable of numbers is materialized as a
    // single raw byte chunk.
    return mapChunkList(
      [Uint8Array.from(items as number[])],
      byteFormat,
    );
  }
  throw invalidAudioInput(
    "Unsupported audio input. Expected stream, TypedArray, or chunk array.",
  );
}
