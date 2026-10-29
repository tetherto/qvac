package io.tether.qvac.sdk

/**
 * Wire limits of one worker connection. They bound memory, not generated
 * output: a frame over the limit fails the call it belongs to and leaves the
 * connection usable.
 *
 * @property maxFrameBytes the longest bare-rpc frame accepted from the worker,
 *   length prefix included, and the longest JSON line. Raise it for a call
 *   that returns more than 16 MiB in one reply or stream chunk, such as a
 *   large `upscaleStream` image. A frame is held in memory several times over
 *   while it is decoded.
 */
data class RpcLimits(val maxFrameBytes: Int = DEFAULT_MAX_FRAME_BYTES) {
    init {
        require(maxFrameBytes in MIN_FRAME_BYTES..MAX_FRAME_BYTES) {
            "maxFrameBytes must be between $MIN_FRAME_BYTES and $MAX_FRAME_BYTES, got $maxFrameBytes"
        }
    }

    companion object {
        const val DEFAULT_MAX_FRAME_BYTES = 16 * 1024 * 1024
        const val MIN_FRAME_BYTES = 4 * 1024

        // Four frames of this size must fit the library's per-stream cap, a UInt.
        const val MAX_FRAME_BYTES = 512 * 1024 * 1024
    }
}
