package io.tether.qvac.sdk.rpc

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
 * bare-stow's worker framing over [inner]. Each frame is a 4-byte little-endian
 * length counting the tag and the payload, a 1-byte tag (0 control, 1 user data),
 * then the payload. User data carries the bare-rpc byte stream; control payloads
 * are JSON: `ready`, `exit`, `error` from the worker and `terminate` to it.
 */
class StowChannel(
    private val inner: BareRpcChannel,
    private val maxFrameBytes: Int = DEFAULT_MAX_FRAME_BYTES,
) : BareRpcChannel {
    private val readMutex = Mutex()
    private val writeMutex = Mutex()
    private var pending = byteArrayOf()
    private val ready = CompletableDeferred<Unit>()
    private val exited = CompletableDeferred<Int?>()
    private var workerError: StowWorkerException? = null

    /** Suspends until the worker signals ready, or throws why it ended first. */
    suspend fun awaitReady() {
        while (!ready.isCompleted) {
            readMutex.withLock {
                if (!ready.isCompleted) readFrame()
            }
        }
        ready.await()
    }

    /**
     * Asks the worker to stop and suspends until it reports its exit code. The
     * session reading this channel drives the reads that deliver `exit`.
     */
    suspend fun terminate(): Int? {
        val message = buildJsonObject { put("type", "terminate") }
        writeFrame(CONTROL, Json.encodeToString(JsonObject.serializer(), message).encodeToByteArray())
        return exited.await()
    }

    override suspend fun readExactly(count: Int): ByteArray = readMutex.withLock {
        require(count >= 0) { "read count must not be negative" }
        while (pending.size < count) readFrame()
        val result = pending.copyOfRange(0, count)
        pending = pending.copyOfRange(count, pending.size)
        result
    }

    override suspend fun write(data: ByteArray) {
        writeFrame(USER, data)
    }

    override suspend fun close() {
        val error = workerError ?: BareRpcProtocolException("bare-stow channel closed")
        ready.completeExceptionally(error)
        exited.complete(null)
        inner.close()
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
        writeMutex.withLock { inner.write(frame) }
    }

    private suspend fun readFrame() {
        val prefix = try {
            inner.readExactly(4)
        } catch (error: Throwable) {
            val reason = workerError ?: error
            ready.completeExceptionally(reason)
            exited.complete(null)
            throw reason
        }
        val length = (prefix[0].toLong() and 0xff) or
            ((prefix[1].toLong() and 0xff) shl 8) or
            ((prefix[2].toLong() and 0xff) shl 16) or
            ((prefix[3].toLong() and 0xff) shl 24)
        if (length < 1 || length > maxFrameBytes) {
            throw BareRpcProtocolException("bare-stow frame length out of range: $length")
        }
        val body = inner.readExactly(length.toInt())
        val payload = body.copyOfRange(1, body.size)
        when (body[0].toInt()) {
            USER -> pending += payload
            CONTROL -> onControl(payload)
        }
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
        const val DEFAULT_MAX_FRAME_BYTES = 512 * 1024 * 1024
    }
}
