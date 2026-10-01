package io.tether.qvac.sdk.rpc

import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertContentEquals

class BareRpcSessionTest {
    @Test
    fun unaryRequestWorksAcrossPartialChannelReads() = runTest {
        val channel = ReplyingChannel()
        val session = BareRpcSession(channel)

        assertContentEquals("pong".encodeToByteArray(), session.request("ping".encodeToByteArray()))

        session.close()
    }

    @Test
    fun cancellingOneStreamKeepsTheSessionUsable() = runTest {
        val channel = StreamingReplyingChannel()
        val session = BareRpcSession(channel)

        assertContentEquals(
            "first".encodeToByteArray(),
            session.responseStream("stream".encodeToByteArray()).first(),
        )
        assertContentEquals("pong".encodeToByteArray(), session.request("ping".encodeToByteArray()))

        session.close()
    }
}

private class ReplyingChannel : BareRpcChannel {
    private val incoming = Channel<ByteArray>(Channel.UNLIMITED)
    private var pending = byteArrayOf()

    override suspend fun readExactly(count: Int): ByteArray {
        while (pending.size < count) {
            pending += incoming.receive()
        }
        val result = pending.copyOfRange(0, count)
        pending = pending.copyOfRange(count, pending.size)
        return result
    }

    override suspend fun write(data: ByteArray) {
        val request = BareRpcCodec.decodeFrame(data) as BareRpcMessage.Request
        val response = BareRpcCodec.encodeResponse(
            id = request.id,
            data = "pong".encodeToByteArray(),
        )
        val midpoint = response.size / 2
        incoming.send(response.copyOfRange(0, midpoint))
        incoming.send(response.copyOfRange(midpoint, response.size))
    }

    override suspend fun close() {
        incoming.close()
    }
}

private class StreamingReplyingChannel : BareRpcChannel {
    private val incoming = Channel<ByteArray>(Channel.UNLIMITED)
    private var pending = byteArrayOf()
    private var streamId: Long? = null

    override suspend fun readExactly(count: Int): ByteArray {
        while (pending.size < count) pending += incoming.receive()
        val result = pending.copyOfRange(0, count)
        pending = pending.copyOfRange(count, pending.size)
        return result
    }

    override suspend fun write(data: ByteArray) {
        when (val message = BareRpcCodec.decodeFrame(data)) {
            is BareRpcMessage.Request -> {
                if (message.data?.decodeToString() == "stream") {
                    streamId = message.id
                    incoming.send(BareRpcCodec.encodeResponse(message.id, stream = StreamFlags.OPEN))
                } else {
                    incoming.send(BareRpcCodec.encodeResponse(message.id, "pong".encodeToByteArray()))
                }
            }
            is BareRpcMessage.Stream -> when {
                message.flags and StreamFlags.OPEN != 0L -> {
                    incoming.send(
                        BareRpcCodec.encodeStream(
                            message.id,
                            StreamFlags.RESPONSE or StreamFlags.DATA,
                            "first".encodeToByteArray(),
                        ),
                    )
                }
                message.flags and StreamFlags.DESTROY != 0L && message.id == streamId -> {
                    // A late peer frame after local cancellation must be ignored,
                    // not treated as a fatal error for the whole session.
                    incoming.send(
                        BareRpcCodec.encodeStream(
                            message.id,
                            StreamFlags.RESPONSE or StreamFlags.DATA,
                            "late".encodeToByteArray(),
                        ),
                    )
                }
            }
            is BareRpcMessage.Response -> Unit
        }
    }

    override suspend fun close() {
        incoming.close()
    }
}
