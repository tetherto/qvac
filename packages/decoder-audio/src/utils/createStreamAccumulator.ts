import { ERR_CODES, QvacErrorDecoderAudio } from "./error";

const TARGET_SECONDS = 1; // Desired chunk size in seconds
const SAMPLE_RATE = 16000; // PCM audio sample rate
const BYTES_PER_SAMPLE = 4; // PCM S16LE (16-bit)
const TARGET_BUFFER_SIZE = TARGET_SECONDS * SAMPLE_RATE * BYTES_PER_SAMPLE;

/**
 * Creates a stream accumulator that processes incoming audio data in chunks of a specified size.
 * The accumulator maintains a buffer of incoming data and emits chunks when the target size is reached.
 *
 * @param options - Configuration options for the stream accumulator
 * @returns An object with methods to process data and finish the stream
 * @throws {QvacErrorDecoderAudio} If the target buffer size is smaller than the minimum required size
 */
function createStreamAccumulator({
  onChunk,
  onFinish,
  targetBufferSize = TARGET_BUFFER_SIZE,
}: createStreamAccumulator.StreamAccumulatorOptions): createStreamAccumulator.StreamAccumulator {
  if (targetBufferSize < TARGET_BUFFER_SIZE) {
    throw new QvacErrorDecoderAudio({ code: ERR_CODES.BUFFER_SIZE_TOO_SMALL });
  }

  let accumulator = Buffer.alloc(0);

  return {
    /**
     * Process incoming data and emit chunks when target size is reached.
     * Accumulates incoming data until it reaches the target buffer size,
     * then emits a chunk and continues with the remaining data.
     *
     * @param data - The incoming data to process
     * @returns A promise that resolves when the chunk is processed
     */
    async processData(data: Buffer): Promise<void> {
      accumulator = Buffer.concat([accumulator, data]);

      while (accumulator.length >= targetBufferSize) {
        const chunk = accumulator.subarray(0, targetBufferSize);
        await onChunk(new Uint8Array(chunk));
        accumulator = accumulator.subarray(targetBufferSize);
      }
    },

    /**
     * Finish processing and emit any remaining data.
     * Processes any remaining data in the accumulator and calls the finish callback.
     *
     * @returns A promise that resolves when all remaining data is processed
     */
    async finish(): Promise<void> {
      if (accumulator.length > 0) {
        await onChunk(new Uint8Array(accumulator));
      }
      await onFinish();
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-namespace -- declaration merging exposes the option types alongside the `export =` function.
namespace createStreamAccumulator {
  export interface StreamAccumulatorOptions {
    /** Called with each full chunk, and with the remainder on `finish()`. */
    onChunk: (chunk: Uint8Array) => void | Promise<void>;
    /** Called once after the final chunk has been emitted. */
    onFinish: () => void | Promise<void>;
    /** Chunk size in bytes. Must be at least 64000. */
    targetBufferSize?: number;
  }

  export interface StreamAccumulator {
    processData(data: Buffer): Promise<void>;
    finish(): Promise<void>;
  }
}

export = createStreamAccumulator;
