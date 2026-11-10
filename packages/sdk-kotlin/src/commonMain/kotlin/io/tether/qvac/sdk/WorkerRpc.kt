package io.tether.qvac.sdk

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.channelFlow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.emitAll
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.launch
import kotlinx.coroutines.selects.select
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import to.holepunch.bare.rpc.Message
import to.holepunch.bare.rpc.Messages
import to.holepunch.bare.rpc.RemoteError
import to.holepunch.bare.rpc.RemoteException
import to.holepunch.bare.rpc.Rpc
import to.holepunch.compactEncoding.State
import to.holepunch.compactEncoding.uint
import to.holepunch.compactEncoding.uint32

/** The worker broke the JSON contract on top of bare-rpc. */
class QvacWorkerProtocolException(message: String) : Exception(message)

/**
 * JSON requests to the worker over one bare-rpc connection.
 *
 * [data] is the bytes the transport receives; their end closes the
 * connection. [send] writes one frame. [close] fails the pending and later
 * calls; the owner then closes the transport.
 *
 * Frames are split here, before the library sees them, so that a frame over
 * [RpcLimits.maxFrameBytes] fails only the call it addresses: the library
 * would fail the whole connection. The rest of such a frame is read and
 * dropped.
 */
class WorkerRpc(
    data: Flow<ByteArray>,
    send: suspend (ByteArray) -> Unit,
    private val limits: RpcLimits = RpcLimits(),
) {
    private val maxFrameBytes = limits.maxFrameBytes.toLong()

    // Several full-size frames can be on the wire before the worker sees a
    // pause, and a single frame must never trip the per-stream cap.
    private val maxBufferedBytes = 4 * maxFrameBytes

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val rpc = Rpc(
        data = frames(data),
        write = send,
        scope = scope,
        maxFrameSize = maxFrameBytes.toUInt(),
        maxBufferedBytes = maxBufferedBytes.toUInt(),
    )
    private val json = Json {
        ignoreUnknownKeys = true
        explicitNulls = false
    }

    suspend fun call(payload: JsonObject): JsonObject {
        val reply = try {
            rpc.request(0u, encode(payload))
        } catch (error: RemoteException) {
            throw error.unwrapped()
        }
        return decode(reply)
    }

    fun stream(payload: JsonObject): Flow<JsonObject> = decodeLines(rpc.requestFlow(0u, encode(payload)))

    /**
     * The payload is the first chunk on the request stream, then [input]. The
     * worker reads its duplex session's input until that stream ends, so a
     * cancelled collection ends it before the reply is abandoned. The request
     * runs in this connection's scope, on [Dispatchers.Default] rather than in
     * the collector's context: cancelling the collector must not cancel the
     * request before its input has ended. [input] is collected there too.
     * Replies are handed over one at a time, so the library's flow control
     * sees how far the collector has got; once the collector stops, they are
     * dropped.
     */
    fun duplex(payload: JsonObject, input: Flow<ByteArray>): Flow<JsonObject> = decodeLines(flow {
        val stop = CompletableDeferred<Unit>()
        val body = flow {
            emit(encode(payload))
            emitAll(input.until(stop))
        }
        val replies = Channel<ByteArray>(Channel.RENDEZVOUS)
        val reply = scope.launch {
            try {
                rpc.requestFlow(0u, body).collect { chunk ->
                    select {
                        replies.onSend(chunk) {}
                        stop.onJoin {}
                    }
                }
                replies.close()
            } catch (error: Throwable) {
                replies.close(error)
            }
        }
        try {
            for (chunk in replies) emit(chunk)
        } finally {
            withContext(NonCancellable) {
                stop.complete(Unit)
                withTimeoutOrNull(REPLY_AFTER_INPUT_END_MS) { reply.join() }
                reply.cancel()
            }
        }
    })

    /** Fails pending and later calls. The owner then closes the transport. */
    suspend fun close() = rpc.close()

    /** The whole frames in [data], with each oversized frame replaced by [rejectOversized]'s. */
    private fun frames(data: Flow<ByteArray>): Flow<ByteArray> = flow {
        val frames = FrameBuffer()
        var dropping = 0L
        data.collect { chunk ->
            var from = 0
            if (dropping > 0) {
                from = minOf(dropping, chunk.size.toLong()).toInt()
                dropping -= from
                if (from == chunk.size) return@collect
            }
            frames.append(chunk, from)
            while (true) {
                val length = frames.frameLength() ?: break
                val frameBytes = FRAME_PREFIX_BYTES + length
                if (frameBytes > maxFrameBytes) {
                    val head = frames.take(FRAME_PREFIX_BYTES + MAX_HEADER_BYTES) ?: break
                    emit(rejectOversized(head, frameBytes))
                    dropping = frames.drop(length - MAX_HEADER_BYTES)
                    if (dropping > 0) break
                    continue
                }
                emit(frames.take(frameBytes) ?: break)
            }
        }
    }

    /**
     * A frame failing the call an oversized frame addresses with the error the
     * library would report for a peer error, so the library tears down only
     * that call. [head] is the frame's length prefix and the start of its body;
     * the body's first fields are the message type, the request id and, for a
     * stream frame, its flags.
     *
     * @throws QvacWorkerProtocolException for an oversized frame that addresses
     *   no reply, which fails the connection.
     */
    private fun rejectOversized(head: ByteArray, frameBytes: Long): ByteArray {
        val state = State(head).apply { start = FRAME_PREFIX_BYTES.toInt() }
        val type = uint.decode(state)
        val id = uint.decode(state)
        val message = "frame of $frameBytes bytes exceeds the cap of $maxFrameBytes bytes"
        val error = RemoteError(message, FRAME_TOO_LARGE, 0)
        val failure = when {
            id == 0uL -> null
            type == MESSAGE_RESPONSE -> Message.Response(id, 0u, null, error)
            type == MESSAGE_STREAM && uint.decode(state) and STREAM_RESPONSE != 0uL ->
                Message.Stream(id, STREAM_RESPONSE or STREAM_CLOSE or STREAM_ERROR, null, error)
            else -> null
        }
        return Messages.encode(failure ?: throw QvacWorkerProtocolException(message))
    }

    private fun Throwable.unwrapped(): Throwable =
        if (this is RemoteException && code == FRAME_TOO_LARGE) QvacWorkerProtocolException(message.orEmpty()) else this

    private fun decodeLines(chunks: Flow<ByteArray>): Flow<JsonObject> = flow {
        val decoder = JsonLinesDecoder(limits.maxFrameBytes)
        chunks.catch { throw it.unwrapped() }.collect { chunk ->
            for (line in decoder.feed(chunk)) emit(decode(line))
        }
        for (line in decoder.finish()) emit(decode(line))
    }

    private fun encode(payload: JsonObject): ByteArray {
        return json.encodeToString(JsonObject.serializer(), payload).encodeToByteArray()
    }

    private fun decode(payload: ByteArray): JsonObject = decode(payload.decodeToString())

    private fun decode(payload: String): JsonObject {
        return try {
            json.parseToJsonElement(payload).jsonObject
        } catch (error: Throwable) {
            throw QvacWorkerProtocolException("worker returned invalid JSON: ${error.message}")
        }
    }

    private fun Flow<ByteArray>.until(stop: Deferred<Unit>): Flow<ByteArray> = channelFlow {
        val producer = launch { collect { send(it) } }
        val stopper = launch {
            stop.await()
            producer.cancel()
        }
        producer.join()
        stopper.cancel()
    }

    private companion object {
        const val REPLY_AFTER_INPUT_END_MS = 5_000L
        const val FRAME_PREFIX_BYTES = 4L

        // The message type, request id and stream flags are compact-encoded
        // unsigned integers of at most nine bytes each.
        const val MAX_HEADER_BYTES = 27L
        const val MESSAGE_RESPONSE = 2uL
        const val MESSAGE_STREAM = 3uL
        const val STREAM_CLOSE = 0x2uL
        const val STREAM_ERROR = 0x80uL
        const val STREAM_RESPONSE = 0x200uL
        const val FRAME_TOO_LARGE = "ERR_FRAME_TOO_LARGE"
    }
}

/**
 * Bytes received but not yet delivered as whole frames. Consumed bytes are
 * reclaimed only when the buffer has to grow, so a frame arriving in many
 * chunks costs O(frame), not O(chunks * frame).
 */
private class FrameBuffer {
    private var bytes = ByteArray(0)
    private var start = 0
    private var end = 0
    private val size get() = end - start

    fun append(chunk: ByteArray, from: Int) {
        val count = chunk.size - from
        if (end + count > bytes.size) {
            val kept = size
            if (kept + count > bytes.size) {
                val grown = ByteArray(maxOf(kept + count, bytes.size * 2))
                bytes.copyInto(grown, 0, start, end)
                bytes = grown
            } else {
                bytes.copyInto(bytes, 0, start, end)
            }
            start = 0
            end = kept
        }
        chunk.copyInto(bytes, end, from, chunk.size)
        end += count
    }

    /** The body length the next frame's prefix declares, or null until the prefix is complete. */
    fun frameLength(): Long? {
        if (size < 4) return null
        return uint32.decode(State(bytes).apply { start = this@FrameBuffer.start }).toLong()
    }

    fun take(count: Long): ByteArray? {
        if (size < count) return null
        val taken = bytes.copyOfRange(start, start + count.toInt())
        consume(count.toInt())
        return taken
    }

    /** Drops up to [count] buffered bytes and returns how many are still to drop. */
    fun drop(count: Long): Long {
        val dropped = minOf(count, size.toLong()).toInt()
        consume(dropped)
        return count - dropped
    }

    private fun consume(count: Int) {
        start += count
        if (start == end) {
            start = 0
            end = 0
        }
    }
}
