export const PCM_S16_SCALE = 32768;

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
