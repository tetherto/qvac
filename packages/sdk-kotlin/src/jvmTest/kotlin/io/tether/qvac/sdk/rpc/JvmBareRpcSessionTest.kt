package io.tether.qvac.sdk.rpc

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import java.io.InputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertIs

class JvmBareRpcSessionTest {
    @Test
    fun completesUnaryRequests() = runBlocking {
        withSocketPair { host, worker ->
            val session = JvmBareRpcSession(host)
            val workerJob = async(Dispatchers.IO) {
                val request = assertIs<BareRpcMessage.Request>(
                    BareRpcCodec.decodeFrame(readFrame(worker.getInputStream())),
                )
                worker.getOutputStream().write(
                    BareRpcCodec.encodeResponse(
                        id = request.id,
                        data = "{\"type\":\"heartbeat\",\"number\":1}".encodeToByteArray(),
                    ),
                )
            }

            val response = session.request("{\"type\":\"heartbeat\"}".encodeToByteArray())

            assertContentEquals(
                "{\"type\":\"heartbeat\",\"number\":1}".encodeToByteArray(),
                response,
            )
            workerJob.await()
            session.close()
        }
    }

    @Test
    fun acknowledgesAndCollectsResponseStreams() = runBlocking {
        withSocketPair { host, worker ->
            val session = JvmBareRpcSession(host)
            val workerJob = async(Dispatchers.IO) {
                val request = assertIs<BareRpcMessage.Request>(
                    BareRpcCodec.decodeFrame(readFrame(worker.getInputStream())),
                )
                worker.getOutputStream().write(
                    BareRpcCodec.encodeResponse(id = request.id, stream = StreamFlags.OPEN),
                )
                val ack = assertIs<BareRpcMessage.Stream>(
                    BareRpcCodec.decodeFrame(readFrame(worker.getInputStream())),
                )
                assertEquals(StreamFlags.RESPONSE or StreamFlags.OPEN, ack.flags)
                worker.getOutputStream().write(
                    BareRpcCodec.encodeStream(
                        request.id,
                        StreamFlags.RESPONSE or StreamFlags.DATA,
                        "{\"type\":\"chunk\"}\n".encodeToByteArray(),
                    ),
                )
                worker.getOutputStream().write(
                    BareRpcCodec.encodeStream(
                        request.id,
                        StreamFlags.RESPONSE or StreamFlags.END,
                    ),
                )
            }

            val chunks = session.responseStream("{\"type\":\"completionStream\"}".encodeToByteArray())
                .toList()

            assertEquals(1, chunks.size)
            assertContentEquals("{\"type\":\"chunk\"}\n".encodeToByteArray(), chunks.single())
            workerJob.await()
            session.close()
        }
    }

    @Test
    fun pumpsDuplexRequestAndResponseStreams() = runBlocking {
        withSocketPair { host, worker ->
            val session = JvmBareRpcSession(host)
            val workerJob = async(Dispatchers.IO) {
                val request = assertIs<BareRpcMessage.Request>(
                    BareRpcCodec.decodeFrame(readFrame(worker.getInputStream())),
                )
                assertEquals(StreamFlags.OPEN, request.stream)
                worker.getOutputStream().write(
                    BareRpcCodec.encodeStream(
                        request.id,
                        StreamFlags.REQUEST or StreamFlags.OPEN,
                    ),
                )

                val metadata = assertIs<BareRpcMessage.Stream>(
                    BareRpcCodec.decodeFrame(readFrame(worker.getInputStream())),
                )
                val input = assertIs<BareRpcMessage.Stream>(
                    BareRpcCodec.decodeFrame(readFrame(worker.getInputStream())),
                )
                val requestEnd = assertIs<BareRpcMessage.Stream>(
                    BareRpcCodec.decodeFrame(readFrame(worker.getInputStream())),
                )
                assertContentEquals("{\"type\":\"duplex\"}".encodeToByteArray(), metadata.data)
                assertContentEquals("input".encodeToByteArray(), input.data)
                assertEquals(StreamFlags.REQUEST or StreamFlags.END, requestEnd.flags)

                worker.getOutputStream().write(
                    BareRpcCodec.encodeResponse(id = request.id, stream = StreamFlags.OPEN),
                )
                readFrame(worker.getInputStream())
                worker.getOutputStream().write(
                    BareRpcCodec.encodeStream(
                        request.id,
                        StreamFlags.RESPONSE or StreamFlags.DATA,
                        "{\"type\":\"output\"}\n".encodeToByteArray(),
                    ),
                )
                worker.getOutputStream().write(
                    BareRpcCodec.encodeStream(
                        request.id,
                        StreamFlags.RESPONSE or StreamFlags.END,
                    ),
                )
            }

            val output = session.duplex(
                metadata = "{\"type\":\"duplex\"}".encodeToByteArray(),
                input = flowOf("input".encodeToByteArray()),
            ).toList()

            assertContentEquals("{\"type\":\"output\"}\n".encodeToByteArray(), output.single())
            workerJob.await()
            session.close()
        }
    }
}

private suspend fun withSocketPair(block: suspend (Socket, Socket) -> Unit) {
    val server = ServerSocket(0, 1, InetAddress.getLoopbackAddress())
    val worker = Socket(InetAddress.getLoopbackAddress(), server.localPort)
    val host = withContext(Dispatchers.IO) { server.accept() }
    try {
        block(host, worker)
    } finally {
        host.close()
        worker.close()
        server.close()
    }
}

private fun readFrame(input: InputStream): ByteArray {
    val prefix = input.readNBytes(4)
    require(prefix.size == 4)
    val length = (prefix[0].toInt() and 0xff) or
        ((prefix[1].toInt() and 0xff) shl 8) or
        ((prefix[2].toInt() and 0xff) shl 16) or
        ((prefix[3].toInt() and 0xff) shl 24)
    return prefix + input.readNBytes(length)
}
