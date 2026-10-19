package io.tether.qvac.sdk.rpc

import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.*
import kotlin.test.*

class FlowControlTest {
    private val limits = BareRpcLimits(maxFrameBytes = 128, maxDiscardBytes = 2048,
        pauseBytes = 64, resumeBytes = 16, maxBufferedBytes = 256, maxBufferedChunks = 8)

    @Test
    fun rejectionBeforeStreamOpenDoesNotHangOrKillOtherCalls() = runBlocking<Unit> {
        withTimeout(5_000) {
            val channel = TestWireChannel()
            val session = BareRpcSession(channel, limits)
            try {
                val run = async { runCatching { session.responseStream(byteArrayOf()).toList() } }
                channel.feed(BareRpcCodec.encodeResponse(channel.request().id, error = BareRpcRemoteError("invalid request", "INVALID", 0)))
                assertIs<BareRpcRemoteException>(run.await().exceptionOrNull())
                val ping = async { session.request(byteArrayOf()) }
                channel.feed(BareRpcCodec.encodeResponse(channel.request().id, byteArrayOf()))
                ping.await()
            } finally { session.close() }
        }
    }

    @Test
    fun slowConsumerPausesThenResumesWithoutBlockingOtherRequests() = runBlocking<Unit> {
        withTimeout(5_000) {
            val channel = TestWireChannel()
            val session = BareRpcSession(channel, limits)
            val entered = CompletableDeferred<Unit>()
            val release = CompletableDeferred<Unit>()
            val collector = async {
                session.responseStream(byteArrayOf()).onEach { entered.complete(Unit); release.await() }.toList()
            }
            try {
                val id = channel.request().id
                channel.feed(BareRpcCodec.encodeStream(id, StreamFlags.RESPONSE or StreamFlags.DATA, ByteArray(70)))
                entered.await()
                assertTrue(channel.stream().flags and StreamFlags.PAUSE != 0L)
                val ping = async { session.request(byteArrayOf()) }
                channel.feed(BareRpcCodec.encodeResponse(channel.request().id, byteArrayOf(9)))
                assertContentEquals(byteArrayOf(9), ping.await())
                release.complete(Unit)
                assertTrue(channel.stream().flags and StreamFlags.RESUME != 0L)
                channel.feed(BareRpcCodec.encodeStream(id, StreamFlags.RESPONSE or StreamFlags.END))
                assertEquals(1, collector.await().size)
            } finally { collector.cancel(); session.close() }
        }
    }

    @Test
    fun oversizedReplyFailsOnlyItsRequestAndDrainsBeforeNextFrame() = runBlocking<Unit> {
        withTimeout(5_000) {
            val channel = TestWireChannel()
            val session = BareRpcSession(channel, limits)
            try {
                val oversized = async { runCatching { session.request(byteArrayOf()) } }
                channel.feed(BareRpcCodec.encodeResponse(channel.request().id, ByteArray(512)))
                assertIs<BareRpcLimitException>(oversized.await().exceptionOrNull())
                val ping = async { session.request(byteArrayOf()) }
                channel.feed(BareRpcCodec.encodeResponse(channel.request().id, byteArrayOf(7)))
                assertContentEquals(byteArrayOf(7), ping.await())
            } finally { session.close() }
        }
    }

    @Test
    fun duplexHonorsPeerPauseBeforeProducingInputAndCanResume() = runBlocking<Unit> {
        withTimeout(5_000) {
            val channel = TestWireChannel()
            val session = BareRpcSession(channel, limits)
            val producing = CompletableDeferred<Unit>()
            val run = async {
                session.duplex(byteArrayOf(1), flow { producing.complete(Unit); emit(byteArrayOf(2)) }).toList()
            }
            try {
                val id = channel.request().id
                channel.feed(BareRpcCodec.encodeStream(id, StreamFlags.REQUEST or StreamFlags.PAUSE))
                channel.feed(BareRpcCodec.encodeStream(id, StreamFlags.REQUEST or StreamFlags.OPEN))
                // A reply behind PAUSE/OPEN is a deterministic reader barrier.
                val ping = async { session.request(byteArrayOf()) }
                channel.feed(BareRpcCodec.encodeResponse(channel.request().id, byteArrayOf()))
                ping.await()
                assertFalse(producing.isCompleted)
                assertTrue(channel.outgoing.tryReceive().isFailure)
                channel.feed(BareRpcCodec.encodeStream(id, StreamFlags.REQUEST or StreamFlags.RESUME))
                assertContentEquals(byteArrayOf(1), channel.stream().data)
                assertContentEquals(byteArrayOf(2), channel.stream().data)
                assertTrue(channel.stream().flags and StreamFlags.END != 0L)
                channel.feed(BareRpcCodec.encodeStream(id, StreamFlags.RESPONSE or StreamFlags.END))
                run.await()
            } finally { run.cancel(); session.close() }
        }
    }

    @Test
    fun peerIgnoringPauseCannotGrowQueueOrKillSession() = runBlocking<Unit> {
        withTimeout(5_000) {
            val channel = TestWireChannel()
            val session = BareRpcSession(channel, limits)
            val release = CompletableDeferred<Unit>()
            val run = async { runCatching {
                session.responseStream(byteArrayOf()).onEach { release.await() }.collect()
            } }
            try {
                val id = channel.request().id
                repeat(9) { channel.feed(BareRpcCodec.encodeStream(id, StreamFlags.RESPONSE or StreamFlags.DATA, byteArrayOf())) }
                assertTrue(channel.stream().flags and StreamFlags.PAUSE != 0L)
                assertTrue(channel.stream().flags and StreamFlags.DESTROY != 0L)
                release.complete(Unit)
                assertIs<BareRpcLimitException>(run.await().exceptionOrNull())
                val ping = async { session.request(byteArrayOf()) }
                channel.feed(BareRpcCodec.encodeResponse(channel.request().id, byteArrayOf()))
                ping.await()
            } finally { run.cancel(); session.close() }
        }
    }
}

private class TestWireChannel : BareRpcChannel {
    private val incoming = Channel<ByteArray>(Channel.UNLIMITED)
    val outgoing = Channel<BareRpcMessage>(Channel.UNLIMITED)
    private var buffered = byteArrayOf()
    suspend fun feed(frame: ByteArray) { incoming.send(frame) }
    suspend fun request() = outgoing.receive() as BareRpcMessage.Request
    suspend fun stream() = outgoing.receive() as BareRpcMessage.Stream
    override suspend fun readExactly(count: Int): ByteArray {
        while (buffered.size < count) buffered += incoming.receive()
        return buffered.copyOfRange(0, count).also { buffered = buffered.copyOfRange(count, buffered.size) }
    }
    override suspend fun write(data: ByteArray) { outgoing.send(BareRpcCodec.decodeFrame(data)) }
    override suspend fun close() { incoming.close() }
}
