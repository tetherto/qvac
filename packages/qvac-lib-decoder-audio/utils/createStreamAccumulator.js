const { QvacErrorDecoderAudio, ERR_CODES } = require('./error')

const TARGET_SECONDS = 1 // Desired chunk size in seconds
const SAMPLE_RATE = 16000 // PCM audio sample rate
const BYTES_PER_SAMPLE = 4 // PCM S16LE (16-bit)
const TARGET_BUFFER_SIZE = TARGET_SECONDS * SAMPLE_RATE * BYTES_PER_SAMPLE

/**
 * Creates a stream accumulator that processes incoming audio data in chunks of a specified size.
 * The accumulator maintains a buffer of incoming data and emits chunks when the target size is reached.
 *
 * @param {Object} options - Configuration options for the stream accumulator
 * @param {Function} options.onChunk - Callback function called when a chunk of data is ready to be processed
 * @param {Function} options.onFinish - Callback function called when all data has been processed
 * @param {number} [options.targetBufferSize=TARGET_BUFFER_SIZE] - Target size for each chunk in bytes
 * @returns {Object} An object with methods to process data and finish the stream
 * @throws {Error} If the target buffer size is smaller than the minimum required size
 */
function createStreamAccumulator ({
  onChunk,
  onFinish,
  targetBufferSize = TARGET_BUFFER_SIZE
}) {
  if (targetBufferSize < TARGET_BUFFER_SIZE) {
    throw new QvacErrorDecoderAudio(ERR_CODES.BUFFER_SIZE_TOO_SMALL)
  }

  let accumulator = Buffer.alloc(0)

  return {
    /**
     * Process incoming data and emit chunks when target size is reached.
     * Accumulates incoming data until it reaches the target buffer size,
     * then emits a chunk and continues with the remaining data.
     *
     * @param {Buffer} data - The incoming data to process
     * @returns {Promise<void>} A promise that resolves when the chunk is processed
     */
    async processData (data) {
      accumulator = Buffer.concat([accumulator, data])

      while (accumulator.length >= targetBufferSize) {
        const chunk = accumulator.subarray(0, targetBufferSize)
        await onChunk(new Uint8Array(chunk))
        accumulator = accumulator.subarray(targetBufferSize)
      }
    },

    /**
     * Finish processing and emit any remaining data.
     * Processes any remaining data in the accumulator and calls the finish callback.
     *
     * @returns {Promise<void>} A promise that resolves when all remaining data is processed
     */
    async finish () {
      if (accumulator.length > 0) {
        await onChunk(new Uint8Array(accumulator))
      }
      await onFinish()
    }
  }
}

module.exports = createStreamAccumulator
