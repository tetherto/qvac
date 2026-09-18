package io.tether.qvac.sdk.rpc

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.channelFlow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

interface BareRpcChannel {
    suspend fun readExactly(count: Int): ByteArray

    suspend fun write(data: ByteArray)

    suspend fun close()
}

class BareRpcRemoteException(
    val remote: BareRpcRemoteError,
) : Exception(remote.message)

/** Resource limits are per stream/frame, not a limit on generated text. */
data class BareRpcLimits(
    val maxFrameBytes: Int = 16 * 1024 * 1024,
    val maxDiscardBytes: Int = 256 * 1024 * 1024,
    val pauseBytes: Int = 1024 * 1024,
    val resumeBytes: Int = 512 * 1024,
    val maxBufferedBytes: Int = 32 * 1024 * 1024,
    val maxBufferedChunks: Int = 1024,
    val maxJsonLineBytes: Int = 16 * 1024 * 1024,
) {
    init {
        require(maxFrameBytes >= 32 && maxDiscardBytes >= maxFrameBytes)
        require(resumeBytes >= 0 && pauseBytes > resumeBytes)
        require(maxBufferedBytes >= maxFrameBytes && maxBufferedBytes >= pauseBytes)
        require(maxBufferedChunks >= 4)
        require(maxJsonLineBytes > 0)
    }
}

class BareRpcLimitException(message: String) : Exception(message)

class BareRpcSession(
    private val channel: BareRpcChannel,
    private val limits: BareRpcLimits = BareRpcLimits(),
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val stateMutex = Mutex()
    private val writeMutex = Mutex()
    private val pendingReplies = mutableMapOf<Long, CompletableDeferred<ByteArray>>()
    private val pendingStreams = mutableMapOf<Long, Inbox>()
    private val pendingRequestOpens = mutableMapOf<Long, CompletableDeferred<Unit>>()
    private val requestWriters = mutableMapOf<Long, MutableStateFlow<WriteState>>()
    private var nextId = 0L
    private var closed = false

    init {
        scope.launch {
            try {
                readLoop()
            } catch (error: Throwable) {
                fail(error)
            }
        }
    }

    suspend fun request(data: ByteArray, command: Long = 0): ByteArray {
        val pending = CompletableDeferred<ByteArray>()
        val id = stateMutex.withLock {
            ensureOpen()
            val requestId = ++nextId
            pendingReplies[requestId] = pending
            requestId
        }

        try {
            sendFrame(BareRpcCodec.encodeRequest(id, command, data))
            return pending.await()
        } finally {
            withContext(NonCancellable) { stateMutex.withLock { pendingReplies.remove(id) } }
        }
    }

    fun responseStream(data: ByteArray, command: Long = 0): Flow<ByteArray> = flow {
        val id = stateMutex.withLock {
            ensureOpen()
            val requestId = ++nextId
            requestId
        }
        val response = Inbox(id)
        stateMutex.withLock { ensureOpen(); pendingStreams[id] = response }

        try {
            sendFrame(BareRpcCodec.encodeRequest(id, command, data))
            for (chunk in response.queue) {
                emit(chunk)
                response.consumed(chunk)
            }
        } finally {
            withContext(NonCancellable) {
                val removed = stateMutex.withLock { pendingStreams.remove(id) != null }
                response.queue.cancel()
                if (removed && !isClosed()) destroyResponse(id)
            }
        }
    }

    fun duplex(
        metadata: ByteArray,
        input: Flow<ByteArray>,
        command: Long = 0,
    ): Flow<ByteArray> = channelFlow {
        val requestOpen = CompletableDeferred<Unit>()
        val writer = MutableStateFlow(WriteState())
        val id = stateMutex.withLock {
            ensureOpen()
            val requestId = ++nextId
            pendingRequestOpens[requestId] = requestOpen
            requestWriters[requestId] = writer
            requestId
        }
        val response = Inbox(id)
        stateMutex.withLock { ensureOpen(); pendingStreams[id] = response }

        try {
            sendFrame(
                BareRpcCodec.encodeRequest(
                    id = id,
                    command = command,
                    stream = StreamFlags.OPEN,
                ),
            )

            val inputPump = launch {
                requestOpen.await()
                writer.awaitWritable()
                sendFrame(
                    BareRpcCodec.encodeStream(id, StreamFlags.REQUEST or StreamFlags.DATA, metadata),
                )
                input.collect { chunk ->
                    writer.awaitWritable()
                    sendFrame(BareRpcCodec.encodeStream(id, StreamFlags.REQUEST or StreamFlags.DATA, chunk))
                }
                writer.awaitWritable()
                sendFrame(BareRpcCodec.encodeStream(id, StreamFlags.REQUEST or StreamFlags.END))
            }

            try {
                for (chunk in response.queue) {
                    send(chunk)
                    response.consumed(chunk)
                }
            } finally {
                inputPump.cancelAndJoin()
            }
        } finally {
            withContext(NonCancellable) {
                stateMutex.withLock {
                    pendingStreams.remove(id)
                    pendingRequestOpens.remove(id)
                    requestWriters.remove(id)
                }
                response.queue.cancel()
                if (!isClosed()) {
                    withTimeoutOrNull(5_000) {
                        // We own the outgoing request stream: CLOSE terminates
                        // the peer's incoming stream. DESTROY addresses a peer's
                        // outgoing stream and is ignored for this direction.
                        sendFrame(BareRpcCodec.encodeStream(id, StreamFlags.REQUEST or StreamFlags.CLOSE))
                        destroyResponse(id)
                    }
                }
            }
        }
    }

    suspend fun close() {
        fail(BareRpcProtocolException("bare-rpc session closed"))
    }

    private suspend fun readLoop() {
        while (true) {
            val prefix = channel.readExactly(4)
            val bodyLength = CompactEncoding.decodeUint32(prefix).value.toLong() and 0xffffffffL
            if (bodyLength > limits.maxDiscardBytes) {
                throw BareRpcProtocolException("bare-rpc frame exceeds discard safety limit: $bodyLength")
            }
            if (bodyLength > limits.maxFrameBytes) {
                discardOversizedFrame(bodyLength.toInt())
                continue
            }
            val frame = prefix + channel.readExactly(bodyLength.toInt())
            dispatch(BareRpcCodec.decodeFrame(frame))
        }
    }

    private suspend fun dispatch(message: BareRpcMessage) {
        when (message) {
            is BareRpcMessage.Request -> Unit
            is BareRpcMessage.Response -> dispatchResponse(message)
            is BareRpcMessage.Stream -> dispatchStream(message)
        }
    }

    private suspend fun dispatchResponse(message: BareRpcMessage.Response) {
        if (message.stream and StreamFlags.OPEN != 0L) {
            val knownStream = stateMutex.withLock { pendingStreams.containsKey(message.id) }
            if (knownStream) {
                sendFrame(
                    BareRpcCodec.encodeStream(
                        message.id,
                        StreamFlags.RESPONSE or StreamFlags.OPEN,
                    ),
                )
            }
            return
        }

        val pending = stateMutex.withLock { pendingReplies.remove(message.id) }
        if (pending == null) {
            // The peer can reject a streaming call before opening its stream.
            // Deliver its unary error/result rather than leaving the collector suspended.
            val stream = stateMutex.withLock { pendingStreams.remove(message.id) } ?: return
            if (message.error != null) stream.queue.close(BareRpcRemoteException(message.error))
            else {
                stream.offer(message.data ?: byteArrayOf())
                stream.queue.close()
            }
            return
        }
        if (message.error != null) {
            pending.completeExceptionally(BareRpcRemoteException(message.error))
        } else {
            pending.complete(message.data ?: byteArrayOf())
        }
    }

    private suspend fun dispatchStream(message: BareRpcMessage.Stream) {
        if (message.flags and StreamFlags.REQUEST != 0L) {
            val writer = stateMutex.withLock { requestWriters[message.id] }
            when {
                message.flags and (StreamFlags.DESTROY or StreamFlags.CLOSE or StreamFlags.ERROR) != 0L -> {
                    val error = message.error?.let(::BareRpcRemoteException)
                        ?: BareRpcProtocolException("remote closed request stream")
                    writer?.value = WriteState(failure = error)
                    stateMutex.withLock { pendingRequestOpens.remove(message.id) }?.completeExceptionally(error)
                }
                message.flags and StreamFlags.PAUSE != 0L && writer?.value?.failure == null -> writer?.value = WriteState(paused = true)
                message.flags and StreamFlags.RESUME != 0L && writer?.value?.failure == null -> writer?.value = WriteState()
            }
        }
        if (message.flags and StreamFlags.OPEN != 0L) {
            if (message.flags and StreamFlags.REQUEST != 0L) {
                stateMutex.withLock { pendingRequestOpens.remove(message.id) }?.complete(Unit)
            }
            return
        }

        if (message.flags and StreamFlags.RESPONSE == 0L) return

        val response = stateMutex.withLock { pendingStreams[message.id] } ?: return
        when {
            message.flags and StreamFlags.ERROR != 0L -> {
                stateMutex.withLock { pendingStreams.remove(message.id) }
                response.queue.close(
                    BareRpcRemoteException(
                        message.error ?: BareRpcRemoteError("remote stream error", "", 0),
                    ),
                )
            }
            message.flags and StreamFlags.DATA != 0L -> {
                // A collector may cancel after this stream was looked up but before
                // the frame is delivered. That is a per-stream lifecycle event,
                // never a fatal read-loop failure for unrelated RPCs.
                response.offer(message.data ?: byteArrayOf())
            }
            message.flags and (StreamFlags.END or StreamFlags.CLOSE) != 0L -> {
                stateMutex.withLock { pendingStreams.remove(message.id) }
                response.queue.close()
            }
            message.flags and StreamFlags.DESTROY != 0L -> {
                stateMutex.withLock { pendingStreams.remove(message.id) }
                response.queue.close(BareRpcProtocolException("remote destroyed response stream"))
            }
        }
    }

    private suspend fun sendFrame(frame: ByteArray) {
        writeMutex.withLock {
            channel.write(frame)
        }
    }

    private suspend fun destroyResponse(id: Long) {
        withTimeoutOrNull(5_000) {
            sendFrame(BareRpcCodec.encodeStream(id, StreamFlags.RESPONSE or StreamFlags.DESTROY))
        }
    }

    private suspend fun fail(error: Throwable) {
        val replies: List<CompletableDeferred<ByteArray>>
        val streams: List<Inbox>
        val requestOpens: List<CompletableDeferred<Unit>>
        stateMutex.withLock {
            if (closed) return
            closed = true
            replies = pendingReplies.values.toList()
            streams = pendingStreams.values.toList()
            requestOpens = pendingRequestOpens.values.toList()
            pendingReplies.clear()
            pendingStreams.clear()
            pendingRequestOpens.clear()
            requestWriters.values.forEach { it.value = WriteState(failure = error) }
            requestWriters.clear()
        }

        replies.forEach { it.completeExceptionally(error) }
        streams.forEach { it.queue.close(error) }
        requestOpens.forEach { it.completeExceptionally(error) }
        try { channel.close() } finally { scope.cancel() }
    }

    private suspend fun isClosed() = stateMutex.withLock { closed }

    private fun ensureOpen() {
        check(!closed) { "bare-rpc session is closed" }
    }

    private data class WriteState(val paused: Boolean = false, val failure: Throwable? = null)

    private suspend fun MutableStateFlow<WriteState>.awaitWritable() {
        first { !it.paused || it.failure != null }.failure?.let { throw it }
    }

    /** Never suspend the multiplexed reader on an individual slow consumer. */
    private inner class Inbox(private val id: Long) {
        // The byte AND chunk counters below bound this queue, including zero-length chunks.
        val queue = Channel<ByteArray>(Channel.UNLIMITED)
        private val mutex = Mutex()
        private var bytes = 0L
        private var chunks = 0
        private var paused = false

        suspend fun offer(data: ByteArray) = mutex.withLock {
            if (bytes + data.size > limits.maxBufferedBytes || chunks >= limits.maxBufferedChunks) {
                queue.close(BareRpcLimitException("peer exceeded stream buffer limit"))
                stateMutex.withLock { pendingStreams.remove(id) }
                sendFrame(BareRpcCodec.encodeStream(id, StreamFlags.RESPONSE or StreamFlags.DESTROY))
                return@withLock
            }
            if (queue.trySend(data).isSuccess) {
                bytes += data.size
                chunks++
                if (!paused && (bytes >= limits.pauseBytes || chunks >= limits.maxBufferedChunks / 2)) {
                    paused = true
                    sendFrame(BareRpcCodec.encodeStream(id, StreamFlags.RESPONSE or StreamFlags.PAUSE))
                }
            }
        }

        suspend fun consumed(data: ByteArray) = mutex.withLock {
            bytes -= data.size
            chunks--
            if (paused && bytes <= limits.resumeBytes && chunks < limits.maxBufferedChunks / 4) {
                paused = false
                if (stateMutex.withLock { pendingStreams.containsKey(id) }) {
                    sendFrame(BareRpcCodec.encodeStream(id, StreamFlags.RESPONSE or StreamFlags.RESUME))
                }
            }
        }
    }

    private suspend fun discardOversizedFrame(length: Int) {
        // type and request id each occupy at most nine compact-encoding bytes.
        val header = channel.readExactly(minOf(length, 18))
        val type = CompactEncoding.decodeUint(header)
        val id = CompactEncoding.decodeUint(header, type.nextOffset).value
        if (type.value !in 2L..3L || id <= 0) {
            throw BareRpcProtocolException("unaddressable oversized bare-rpc frame")
        }
        val error = BareRpcLimitException("frame for request $id exceeds ${limits.maxFrameBytes} bytes ($length)")
        stateMutex.withLock {
            pendingReplies.remove(id)?.completeExceptionally(error)
            pendingStreams.remove(id)?.queue?.close(error)
            pendingRequestOpens.remove(id)?.completeExceptionally(error)
            requestWriters[id]?.value = WriteState(failure = error)
        }
        var remaining = length - header.size
        while (remaining > 0) {
            val count = minOf(remaining, 64 * 1024)
            channel.readExactly(count)
            remaining -= count
        }
        if (type.value == 3L) {
            sendFrame(BareRpcCodec.encodeStream(id, StreamFlags.RESPONSE or StreamFlags.DESTROY))
        }
    }
}
