export declare const PCM_S16_SCALE = 32768;
export declare function pcmS16ToFloat32(int16Samples: Int16Array): Float32Array;
export declare function toFloat32Chunk(chunk: Uint8Array | Float32Array): Float32Array;
export declare function mergeFloat32Chunks(chunks: readonly Float32Array[]): Float32Array;
