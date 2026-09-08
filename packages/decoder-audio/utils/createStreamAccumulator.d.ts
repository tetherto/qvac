/**
 * Creates a stream accumulator that processes incoming audio data in chunks of a specified size.
 * The accumulator maintains a buffer of incoming data and emits chunks when the target size is reached.
 *
 * @param options - Configuration options for the stream accumulator
 * @returns An object with methods to process data and finish the stream
 * @throws {QvacErrorDecoderAudio} If the target buffer size is smaller than the minimum required size
 */
declare function createStreamAccumulator({ onChunk, onFinish, targetBufferSize, }: createStreamAccumulator.StreamAccumulatorOptions): createStreamAccumulator.StreamAccumulator;
declare namespace createStreamAccumulator {
    interface StreamAccumulatorOptions {
        /** Called with each full chunk, and with the remainder on `finish()`. */
        onChunk: (chunk: Uint8Array) => void | Promise<void>;
        /** Called once after the final chunk has been emitted. */
        onFinish: () => void | Promise<void>;
        /** Chunk size in bytes. Must be at least 64000. */
        targetBufferSize?: number;
    }
    interface StreamAccumulator {
        processData(data: Buffer): Promise<void>;
        finish(): Promise<void>;
    }
}
export = createStreamAccumulator;
