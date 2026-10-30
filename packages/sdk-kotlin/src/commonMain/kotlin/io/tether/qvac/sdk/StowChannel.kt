package io.tether.qvac.sdk

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

/** The worker reported an error through bare-stow before it exited. */
class StowWorkerException(message: String, val remoteStack: String?) : Exception(message)

/**
 * bare-stow's worker framing over a byte transport. Each frame is a 4-byte
 * little-endian length counting the tag and the payload, a 1-byte tag (0
 * control, 1 user data), then the payload. User data carries the bare-rpc
 * byte stream and is passed through in the pieces the transport delivers.
 * Control payloads are JSON: `ready`, `exit` and `error` from the worker,
 * `terminate` to it.
 *
 * [receive] returns the next bytes the transport received, or null once it
 * ends. [send] writes bytes to it. The owner closes the transport; a pending
 * [awaitReady] or [terminate] ends when its reads end.
 */
class StowChannel(
    private val receive: suspend () -> ByteArray?,
    private val send: suspend (ByteArray) -> Unit,
    private val maxControlBytes: Int = DEFAULT_MAX_CONTROL_BYTES,
) {
    private val readMutex = Mutex()
    private val writeMutex = Mutex()
    private var buffer = ByteArray(0)
    private var start = 0
    private var userBytesLeft = 0L
    private val ready = CompletableDeferred<Unit>()
    private val exited = CompletableDeferred<Int?>()
    private var workerError: StowWorkerException? = null

    /** Suspends until the worker signals ready, or throws why it ended first. */
    suspend fun awaitReady() {
        while (!ready.isCompleted) {
            readMutex.withLock {
                if (ready.isCompleted) return@withLock
                if (userBytesLeft > 0) throw QvacWorkerProtocolException("bare-stow user data before ready")
                if (!readFrameHeader()) ended(null)
            }
        }
        ready.await()
    }

    /**
     * Asks the worker to stop and suspends until it reports its exit code, or
     * null if the transport ends first. The reads that deliver `exit` are the
     * ones [read] makes.
     */
    suspend fun terminate(): Int? {
        val message = buildJsonObject { put("type", "terminate") }
        writeFrame(CONTROL, Json.encodeToString(JsonObject.serializer(), message).encodeToByteArray())
        return exited.await()
    }

    /** The next user-data bytes, or null once the transport ends. */
    suspend fun read(): ByteArray? = readMutex.withLock {
        while (userBytesLeft == 0L) {
            if (!readFrameHeader()) {
                ended(null)
                return@withLock null
            }
        }
        if (start == buffer.size && !fill()) {
            ended(null)
            return@withLock null
        }
        val count = minOf(userBytesLeft, (buffer.size - start).toLong()).toInt()
        userBytesLeft -= count
        take(count)
    }

    suspend fun write(data: ByteArray) {
        writeFrame(USER, data)
    }

    private suspend fun writeFrame(tag: Int, payload: ByteArray) {
        val frame = ByteArray(HEADER_BYTES + payload.size)
        val length = payload.size + 1
        frame[0] = length.toByte()
        frame[1] = (length ushr 8).toByte()
        frame[2] = (length ushr 16).toByte()
        frame[3] = (length ushr 24).toByte()
        frame[4] = tag.toByte()
        payload.copyInto(frame, HEADER_BYTES)
        writeMutex.withLock { send(frame) }
    }

    /**
     * Reads the next frame header. A control frame is handled whole; for a
     * user frame it records how many payload bytes follow. Returns false once
     * the transport ends.
     */
    private suspend fun readFrameHeader(): Boolean {
        if (!buffered(HEADER_BYTES)) return false
        val header = take(HEADER_BYTES)
        val length = (header[0].toLong() and 0xff) or
            ((header[1].toLong() and 0xff) shl 8) or
            ((header[2].toLong() and 0xff) shl 16) or
            ((header[3].toLong() and 0xff) shl 24)
        if (length < 1) throw QvacWorkerProtocolException("bare-stow frame length out of range: $length")
        val payloadBytes = length - 1
        when (header[4].toInt()) {
            USER -> userBytesLeft = payloadBytes
            CONTROL -> {
                if (payloadBytes > maxControlBytes) {
                    throw QvacWorkerProtocolException("bare-stow control frame of $payloadBytes bytes exceeds $maxControlBytes")
                }
                if (!buffered(payloadBytes.toInt())) return false
                onControl(take(payloadBytes.toInt()))
            }
            else -> if (!skip(payloadBytes)) return false
        }
        return true
    }

    private suspend fun skip(count: Long): Boolean {
        var left = count
        while (left > 0) {
            if (start == buffer.size && !fill()) return false
            val dropped = minOf(left, (buffer.size - start).toLong()).toInt()
            start += dropped
            left -= dropped
        }
        return true
    }

    private suspend fun buffered(count: Int): Boolean {
        while (buffer.size - start < count) {
            if (!fill()) return false
        }
        return true
    }

    private suspend fun fill(): Boolean {
        val chunk = try {
            receive()
        } catch (error: Throwable) {
            ended(error)
            throw workerError ?: error
        } ?: return false
        buffer = if (start == buffer.size) chunk else buffer.copyOfRange(start, buffer.size) + chunk
        start = 0
        return true
    }

    private fun take(count: Int): ByteArray {
        val taken = buffer.copyOfRange(start, start + count)
        start += count
        return taken
    }

    private fun ended(cause: Throwable?) {
        ready.completeExceptionally(
            workerError ?: cause ?: QvacWorkerProtocolException("the worker ended before it was ready"),
        )
        exited.complete(null)
    }

    private fun onControl(payload: ByteArray) {
        val message = runCatching { Json.parseToJsonElement(payload.decodeToString()).jsonObject }.getOrNull() ?: return
        when (message["type"]?.jsonPrimitive?.content) {
            "ready" -> ready.complete(Unit)
            "exit" -> exited.complete(message["code"]?.jsonPrimitive?.intOrNull)
            "error" -> {
                val error = StowWorkerException(
                    message["message"]?.jsonPrimitive?.content ?: "worker error",
                    message["stack"]?.jsonPrimitive?.content,
                )
                workerError = error
                ready.completeExceptionally(error)
            }
        }
    }

    private companion object {
        const val CONTROL = 0
        const val USER = 1
        const val HEADER_BYTES = 5
        const val DEFAULT_MAX_CONTROL_BYTES = 1024 * 1024
    }
}
