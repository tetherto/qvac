package io.tether.qvac.sdk

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import to.holepunch.barerpc.ConnectionClosedException
import to.holepunch.barerpc.Message
import to.holepunch.barerpc.Messages
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

class JvmBareRpcTransportTest {
    @Test
    fun exchangesJsonWithTheWorker() = runBlocking {
        withWorkerSocket { transport, worker ->
            val workerJob = async(Dispatchers.IO) {
                val request = assertIs<Message.Request>(worker.readMessage())
                worker.write(Message.Response(request.id, 0u, "{\"type\":\"heartbeat\",\"number\":7}".encodeToByteArray(), null))
            }

            val response = transport.call(buildJsonObject { put("type", "heartbeat") })

            assertEquals("heartbeat", response["type"]?.jsonPrimitive?.content)
            workerJob.await()
        }
    }

    @Test
    fun duplexSendsThePayloadThenTheInputThenEndsTheRequestStream() = runBlocking {
        withWorkerSocket { transport, worker ->
            val workerJob = async(Dispatchers.IO) {
                val request = assertIs<Message.Request>(worker.readMessage())
                assertEquals(STREAM_OPEN, request.stream)
                assertNull(request.data)
                assertEquals(STREAM_RESPONSE or STREAM_OPEN, assertIs<Message.Stream>(worker.readMessage()).flags)
                worker.write(Message.Stream(request.id, STREAM_REQUEST or STREAM_OPEN, null, null))

                assertContentEquals("{\"type\":\"duplex\"}".encodeToByteArray(), worker.readRequestData())
                assertContentEquals("input".encodeToByteArray(), worker.readRequestData())
                assertEquals(STREAM_REQUEST or STREAM_END, assertIs<Message.Stream>(worker.readMessage()).flags)

                worker.write(Message.Response(request.id, STREAM_OPEN, null, null))
                worker.write(Message.Stream(request.id, STREAM_RESPONSE or STREAM_DATA, "{\"type\":\"output\"}\n".encodeToByteArray(), null))
                worker.write(Message.Stream(request.id, STREAM_RESPONSE or STREAM_END, null, null))
            }

            val output = transport.duplex(
                buildJsonObject { put("type", "duplex") },
                flowOf("input".encodeToByteArray()),
            ).toList()

            assertEquals("output", output.single()["type"]?.jsonPrimitive?.content)
            workerJob.await()
        }
    }

    @Test
    fun cancellingADuplexCollectionEndsTheRequestStream() = runBlocking {
        withWorkerSocket { transport, worker ->
            val workerJob = async(Dispatchers.IO) {
                val request = assertIs<Message.Request>(worker.readMessage())
                worker.readMessage()
                worker.write(Message.Stream(request.id, STREAM_REQUEST or STREAM_OPEN, null, null))
                worker.readRequestData()
                worker.write(Message.Response(request.id, STREAM_OPEN, null, null))
                worker.write(Message.Stream(request.id, STREAM_RESPONSE or STREAM_DATA, "{\"type\":\"partial\"}\n".encodeToByteArray(), null))

                // The input never ends on its own: the client must end it once
                // the collector stops, so the worker's duplex session can finish.
                assertEquals(STREAM_REQUEST or STREAM_END, assertIs<Message.Stream>(worker.readMessage()).flags)
                worker.write(Message.Stream(request.id, STREAM_RESPONSE or STREAM_END, null, null))
            }

            val first = CompletableDeferred<String>()
            val collector = launch {
                transport.duplex(buildJsonObject { put("type", "duplex") }, flow { awaitCancellation() })
                    .collect { first.complete(it["type"]?.jsonPrimitive?.content.orEmpty()) }
            }
            withTimeout(5_000) {
                assertEquals("partial", first.await())
                collector.cancelAndJoin()
                workerJob.await()
            }
        }
    }

    @Test
    fun closingTheTransportFailsAnInFlightDuplexCollection() = runBlocking {
        withWorkerSocket { transport, worker ->
            val workerJob = async(Dispatchers.IO) {
                val request = assertIs<Message.Request>(worker.readMessage())
                worker.readMessage()
                worker.write(Message.Stream(request.id, STREAM_REQUEST or STREAM_OPEN, null, null))
                worker.readRequestData()
                worker.write(Message.Response(request.id, STREAM_OPEN, null, null))
                worker.write(Message.Stream(request.id, STREAM_RESPONSE or STREAM_DATA, "{\"type\":\"partial\"}\n".encodeToByteArray(), null))
            }

            val first = CompletableDeferred<Unit>()
            val failure = async {
                runCatching {
                    transport.duplex(buildJsonObject { put("type", "duplex") }, flow { awaitCancellation() })
                        .collect { first.complete(Unit) }
                }.exceptionOrNull()
            }
            withTimeout(5_000) {
                first.await()
                workerJob.await()
                transport.close()
                // The failure reaches the collector, not the thread's uncaught handler.
                assertIs<ConnectionClosedException>(failure.await())
            }
        }
    }

    @Test
    fun anOversizedReplyFailsOnlyThatCall() = runBlocking {
        withWorkerSocket(RpcLimits(maxFrameBytes = TEST_FRAME_CAP)) { transport, worker ->
            val workerJob = async(Dispatchers.IO) {
                val request = assertIs<Message.Request>(worker.readMessage())
                worker.write(Message.Response(request.id, 0u, ByteArray(TEST_FRAME_CAP), null))
                val next = assertIs<Message.Request>(worker.readMessage())
                worker.write(Message.Response(next.id, 0u, "{\"type\":\"heartbeat\"}".encodeToByteArray(), null))
            }

            withTimeout(20_000) {
                val failure = assertFailsWith<QvacWorkerProtocolException> {
                    transport.call(buildJsonObject { put("type", "big") })
                }
                assertTrue(failure.message.orEmpty().contains("exceeds the cap"), failure.message)
                assertEquals("heartbeat", transport.call(buildJsonObject { put("type", "heartbeat") })["type"]?.jsonPrimitive?.content)
                workerJob.await()
            }
        }
    }

    @Test
    fun aRaisedFrameLimitAcceptsALargerReply() = runBlocking {
        withWorkerSocket(RpcLimits(maxFrameBytes = 4 * TEST_FRAME_CAP)) { transport, worker ->
            val reply = "{\"pad\":\"${"x".repeat(TEST_FRAME_CAP)}\"}".encodeToByteArray()
            val workerJob = async(Dispatchers.IO) {
                val request = assertIs<Message.Request>(worker.readMessage())
                worker.write(Message.Response(request.id, 0u, reply, null))
            }

            withTimeout(20_000) {
                assertEquals(TEST_FRAME_CAP, transport.call(buildJsonObject { put("type", "big") })["pad"]?.jsonPrimitive?.content?.length)
                workerJob.await()
            }
        }
    }

    @Test
    fun anOversizedStreamChunkFailsOnlyThatCollection() = runBlocking {
        withWorkerSocket(RpcLimits(maxFrameBytes = TEST_FRAME_CAP)) { transport, worker ->
            val workerJob = async(Dispatchers.IO) {
                val request = assertIs<Message.Request>(worker.readMessage())
                worker.readMessage()
                worker.write(Message.Response(request.id, STREAM_OPEN, null, null))
                worker.write(Message.Stream(request.id, STREAM_RESPONSE or STREAM_DATA, ByteArray(TEST_FRAME_CAP), null))
                worker.write(Message.Stream(request.id, STREAM_RESPONSE or STREAM_END, null, null))
                val next = assertIs<Message.Request>(worker.readMessage())
                worker.write(Message.Response(next.id, 0u, "{\"type\":\"heartbeat\"}".encodeToByteArray(), null))
            }

            withTimeout(20_000) {
                assertFailsWith<QvacWorkerProtocolException> {
                    transport.stream(buildJsonObject { put("type", "big") }).collect()
                }
                assertEquals("heartbeat", transport.call(buildJsonObject { put("type", "heartbeat") })["type"]?.jsonPrimitive?.content)
                workerJob.await()
            }
        }
    }

    @Test
    fun duplexRepliesPauseTheWorkerUntilTheCollectorCatchesUp() = runBlocking {
        withWorkerSocket { transport, worker ->
            val pauseSeen = CompletableDeferred<Unit>()
            val workerJob = async(Dispatchers.IO) {
                val request = assertIs<Message.Request>(worker.readMessage())
                worker.readMessage()
                worker.write(Message.Stream(request.id, STREAM_REQUEST or STREAM_OPEN, null, null))
                worker.readRequestData()
                assertEquals(STREAM_REQUEST or STREAM_END, assertIs<Message.Stream>(worker.readMessage()).flags)
                worker.replyPastThePauseMark(request.id, pauseSeen)
            }

            var count = 0
            withTimeout(5_000) {
                transport.duplex(buildJsonObject { put("type", "duplex") }, flowOf())
                    .collect { if (count++ == 0) pauseSeen.await() }
                workerJob.await()
            }
            assertEquals(LINES_PAST_THE_PAUSE_MARK, count)
        }
    }

    @Test
    fun streamRepliesPauseTheWorkerUntilTheCollectorCatchesUp() = runBlocking {
        withWorkerSocket { transport, worker ->
            val pauseSeen = CompletableDeferred<Unit>()
            val workerJob = async(Dispatchers.IO) {
                val request = assertIs<Message.Request>(worker.readMessage())
                worker.readMessage()
                worker.replyPastThePauseMark(request.id, pauseSeen)
            }

            var count = 0
            withTimeout(5_000) {
                transport.stream(buildJsonObject { put("type", "stream") })
                    .collect { if (count++ == 0) pauseSeen.await() }
                workerJob.await()
            }
            assertEquals(LINES_PAST_THE_PAUSE_MARK, count)
        }
    }
}

private const val STREAM_OPEN = 0x1uL
private const val STREAM_PAUSE = 0x4uL
private const val STREAM_RESUME = 0x8uL
private const val STREAM_DATA = 0x10uL
private const val STREAM_END = 0x20uL
private const val STREAM_REQUEST = 0x100uL
private const val STREAM_RESPONSE = 0x200uL

private suspend fun withWorkerSocket(
    limits: RpcLimits = RpcLimits(),
    block: suspend CoroutineScope.(JvmBareRpcTransport, Socket) -> Unit,
) = coroutineScope {
    val server = ServerSocket(0, 1, InetAddress.getLoopbackAddress())
    val worker = Socket(InetAddress.getLoopbackAddress(), server.localPort)
    val host = withContext(Dispatchers.IO) { server.accept() }
    val transport = JvmBareRpcTransport(host, rpcLimits = limits)
    try {
        block(transport, worker)
    } finally {
        transport.close()
        worker.close()
        server.close()
    }
}

private fun Socket.readMessage(): Message {
    val input = getInputStream()
    val prefix = input.readNBytes(4)
    require(prefix.size == 4)
    val length = (prefix[0].toInt() and 0xff) or
        ((prefix[1].toInt() and 0xff) shl 8) or
        ((prefix[2].toInt() and 0xff) shl 16) or
        ((prefix[3].toInt() and 0xff) shl 24)
    return Messages.decode(prefix + input.readNBytes(length)).message
}

private fun Socket.readRequestData(): ByteArray? {
    val chunk = assertIs<Message.Stream>(readMessage())
    assertEquals(STREAM_REQUEST or STREAM_DATA, chunk.flags)
    return chunk.data
}

private fun Socket.write(message: Message) {
    getOutputStream().write(Messages.encode(message))
    getOutputStream().flush()
}

/** 20 lines of 2 KiB: well past the library's 16 KiB pause mark while the collector holds the first. */
private const val LINES_PAST_THE_PAUSE_MARK = 20

/** A payload of exactly this many bytes fills a frame cap of the same size; the prefix and header push it over. */
private const val TEST_FRAME_CAP = 64 * 1024

private suspend fun Socket.replyPastThePauseMark(id: ULong, pauseSeen: CompletableDeferred<Unit>) {
    val line = "{\"pad\":\"${"x".repeat(2048)}\"}\n".encodeToByteArray()
    write(Message.Response(id, STREAM_OPEN, null, null))
    repeat(LINES_PAST_THE_PAUSE_MARK) { write(Message.Stream(id, STREAM_RESPONSE or STREAM_DATA, line, null)) }
    assertEquals(STREAM_RESPONSE or STREAM_PAUSE, assertIs<Message.Stream>(readMessage()).flags)
    pauseSeen.complete(Unit)
    assertEquals(STREAM_RESPONSE or STREAM_RESUME, assertIs<Message.Stream>(readMessage()).flags)
    write(Message.Stream(id, STREAM_RESPONSE or STREAM_END, null, null))
}
