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
import to.holepunch.barerpc.BareRpc
import to.holepunch.barerpc.Message
import to.holepunch.barerpc.Messages
import to.holepunch.barerpc.RemoteError
import to.holepunch.barerpc.RemoteException
import to.holepunch.compactencoding.State
import to.holepunch.compactencoding.uint
import to.holepunch.compactencoding.uint32

/** The worker broke the JSON contract on top of bare-rpc. */
class QvacWorkerProtocolException(message: String) : Exception(message)

/**
 * JSON requests to the worker over one bare-rpc connection.
 *
 * [read] returns the next bytes the transport received, or null once it ends.
 * [send] writes one frame. The read loop runs until the transport ends or a
 * frame cannot be read. [close] fails the pending and later calls; the owner
 * then closes the transport, which ends the loop.
 *
 * Frames are split here, before the library sees them, so that a frame over
 * [RpcLimits.maxFrameBytes] fails only the call it addresses: the library
 * would fail the whole connection. The rest of such a frame is read and
 * dropped.
 */
class WorkerRpc(
    read: suspend () -> ByteArray?,
    send: suspend (ByteArray) -> Unit,
    private val limits: RpcLimits = RpcLimits(),
) {
    private val maxFrameBytes = limits.maxFrameBytes.toLong()

    // Several full-size frames can be on the wire before the worker sees a
    // pause, and a single frame must never trip the per-stream cap.
    private val maxBufferedBytes = 4 * maxFrameBytes

    private val rpc = BareRpc(
        send = send,
        maxFrameSize = maxFrameBytes.toUInt(),
        maxBufferedBytes = maxBufferedBytes.toUInt(),
    )
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val json = Json {
        ignoreUnknownKeys = true
        explicitNulls = false
    }

    init {
        scope.launch {
            try {
                readFrames(read)
            } catch (_: Throwable) {
                // A frame receive already failed the connection with its cause; a
                // transport read error means the owner is closing it.
            } finally {
                withContext(NonCancellable) { rpc.close() }
            }
        }
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

    /** Fails pending and later calls. The read loop ends when the owner closes the transport. */
    suspend fun close() = rpc.close()

    private suspend fun readFrames(read: suspend () -> ByteArray?) {
        val frames = FrameBuffer()
        var dropping = 0L
        while (true) {
            val chunk = read() ?: break
            var from = 0
            if (dropping > 0) {
                from = minOf(dropping, chunk.size.toLong()).toInt()
                dropping -= from
                if (from == chunk.size) continue
            }
            frames.append(chunk, from)
            while (true) {
                val length = frames.frameLength() ?: break
                val frameBytes = FRAME_PREFIX_BYTES + length
                if (frameBytes > maxFrameBytes) {
                    val head = frames.take(FRAME_PREFIX_BYTES + MAX_HEADER_BYTES) ?: break
                    rejectOversized(head, frameBytes)
                    dropping = frames.drop(length - MAX_HEADER_BYTES)
                    if (dropping > 0) break
                    continue
                }
                val frame = frames.take(frameBytes) ?: break
                rpc.receive(frame)
            }
        }
    }

    /**
     * Fails the call an oversized frame addresses with the error the library
     * would report for a peer error, so the library tears down only that call.
     * [head] is the frame's length prefix and the start of its body; the body's
     * first fields are the message type, the request id and, for a stream
     * frame, its flags. An oversized frame that addresses no reply is fed to
     * the library as is, which fails the connection with its own cap error.
     */
    private suspend fun rejectOversized(head: ByteArray, frameBytes: Long) {
        val state = State(head).apply { start = FRAME_PREFIX_BYTES.toInt() }
        val type = uint.decode(state)
        val id = uint.decode(state)
        val error = RemoteError(
            "frame of $frameBytes bytes exceeds the cap of $maxFrameBytes bytes",
            FRAME_TOO_LARGE,
            0,
        )
        val failure = when {
            id == 0uL -> null
            type == MESSAGE_RESPONSE -> Message.Response(id, 0u, null, error)
            type == MESSAGE_STREAM && uint.decode(state) and STREAM_RESPONSE != 0uL ->
                Message.Stream(id, STREAM_RESPONSE or STREAM_CLOSE or STREAM_ERROR, null, error)
            else -> null
        }
        rpc.receive(if (failure == null) head.copyOf(FRAME_PREFIX_BYTES.toInt()) else Messages.encode(failure))
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
