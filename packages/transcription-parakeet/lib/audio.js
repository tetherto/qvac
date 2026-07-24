"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PCM_S16_SCALE = void 0;
exports.pcmS16ToFloat32 = pcmS16ToFloat32;
exports.toFloat32Chunk = toFloat32Chunk;
exports.mergeFloat32Chunks = mergeFloat32Chunks;
exports.PCM_S16_SCALE = 32768;
function pcmS16ToFloat32(int16Samples) {
    const audio = new Float32Array(int16Samples.length);
    for (let i = 0; i < int16Samples.length; i++) {
        audio[i] = int16Samples[i] / exports.PCM_S16_SCALE;
    }
    return audio;
}
function toFloat32Chunk(chunk) {
    if (chunk instanceof Float32Array) {
        return chunk;
    }
    const int16Samples = new Int16Array(chunk.buffer, chunk.byteOffset, chunk.byteLength / 2);
    return pcmS16ToFloat32(int16Samples);
}
function sumChunkLengths(chunks) {
    return chunks.reduce((total, chunk) => total + chunk.length, 0);
}
function mergeFloat32Chunks(chunks) {
    const merged = new Float32Array(sumChunkLengths(chunks));
    let offset = 0;
    for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.length;
    }
    return merged;
}
