"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PCM_S16_SCALE = void 0;
exports.pcmS16ToFloat32 = pcmS16ToFloat32;
exports.toFloat32Chunk = toFloat32Chunk;
exports.mergeFloat32Chunks = mergeFloat32Chunks;
exports.normalizeChunkToFloat32 = normalizeChunkToFloat32;
exports.normalizeAudioStream = normalizeAudioStream;
const error_1 = require("./error");
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
function invalidAudioInput(message) {
    return new error_1.QvacErrorAddonASRGgml({
        code: error_1.ERR_CODES.INVALID_AUDIO_INPUT,
        adds: message,
    });
}
function s16BytesToFloat32(bytes) {
    if (bytes.byteLength % 2 !== 0) {
        throw invalidAudioInput(`s16le byte chunk length must be a multiple of 2, got ${bytes.byteLength}`);
    }
    const aligned = bytes.byteOffset % 2 === 0
        ? bytes
        : new Uint8Array(bytes); // aligned copy
    const samples = new Int16Array(aligned.buffer, aligned.byteOffset, aligned.byteLength / 2);
    return pcmS16ToFloat32(samples);
}
function f32BytesToFloat32(bytes) {
    if (bytes.byteLength % 4 !== 0) {
        throw invalidAudioInput(`f32le byte chunk length must be a multiple of 4, got ${bytes.byteLength}`);
    }
    const aligned = bytes.byteOffset % 4 === 0
        ? bytes
        : new Uint8Array(bytes); // aligned copy
    return new Float32Array(aligned.buffer, aligned.byteOffset, aligned.byteLength / 4);
}
/**
 * Normalizes one audio chunk to f32 samples. The chunk's class decides its
 * interpretation; `byteFormat` only describes how raw `Uint8Array` bytes are
 * decoded.
 */
function normalizeChunkToFloat32(chunk, byteFormat) {
    if (chunk instanceof Float32Array)
        return chunk;
    if (chunk instanceof Int16Array)
        return pcmS16ToFloat32(chunk);
    if (chunk instanceof Uint8Array) {
        return byteFormat === "f32le"
            ? f32BytesToFloat32(chunk)
            : s16BytesToFloat32(chunk);
    }
    throw invalidAudioInput("Unsupported audio chunk. Expected Float32Array, Int16Array, or Uint8Array.");
}
function isAudioChunk(value) {
    return (value instanceof Float32Array ||
        value instanceof Int16Array ||
        value instanceof Uint8Array);
}
async function* mapAsyncChunks(source, byteFormat) {
    for await (const chunk of source) {
        yield normalizeChunkToFloat32(chunk, byteFormat);
    }
}
/**
 * Normalizes any public {@link AudioInput} shape into a stream of f32
 * chunks. Shared by both engine drivers; `byteFormat` is the driver's
 * interpretation of raw `Uint8Array` bytes.
 */
function normalizeAudioStream(input, byteFormat) {
    if (!input) {
        throw invalidAudioInput("audio input is required");
    }
    if (typeof input[Symbol.asyncIterator] === "function") {
        return mapAsyncChunks(input, byteFormat);
    }
    if (isAudioChunk(input)) {
        return [normalizeChunkToFloat32(input, byteFormat)];
    }
    if (Array.isArray(input)) {
        return input.map((chunk) => normalizeChunkToFloat32(chunk, byteFormat));
    }
    if (typeof input[Symbol.iterator] ===
        "function") {
        const items = Array.from(input);
        if (items.length > 0 && items.every(isAudioChunk)) {
            return items.map((chunk) => normalizeChunkToFloat32(chunk, byteFormat));
        }
        // Legacy convenience: a plain iterable of numbers is materialized as a
        // single raw byte chunk.
        return [
            normalizeChunkToFloat32(Uint8Array.from(items), byteFormat),
        ];
    }
    throw invalidAudioInput("Unsupported audio input. Expected stream, TypedArray, or chunk array.");
}
