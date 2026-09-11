/** A synchronous random-access reader; it must not return a Promise. */
export interface VideoReader {
    size: number;
    read(offset: number, length: number): Uint8Array;
}
/** Finite input. Chunk iterables are staged before decoding, not processed live. */
export type VideoInput = string | Uint8Array | VideoReader | AsyncIterable<Uint8Array>;
