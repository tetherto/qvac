package io.tether.qvac.sdk

import io.tether.qvac.sdk.rpc.BareRpcCodec
import io.tether.qvac.sdk.rpc.BareRpcMessage
import io.tether.qvac.sdk.rpc.JvmBareRpcSession
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import java.io.InputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

class JvmBareRpcTransportTest {
    @Test
    fun exchangesJsonWithTheWorkerSession() = runBlocking {
        val server = ServerSocket(0, 1, InetAddress.getLoopbackAddress())
        val worker = Socket(InetAddress.getLoopbackAddress(), server.localPort)
        val host = server.accept()
        val transport = JvmBareRpcTransport(JvmBareRpcSession(host))
        val workerJob = async(Dispatchers.IO) {
            val request = assertIs<BareRpcMessage.Request>(
                BareRpcCodec.decodeFrame(readTransportFrame(worker.getInputStream())),
            )
            worker.getOutputStream().write(
                BareRpcCodec.encodeResponse(
                    request.id,
                    "{\"type\":\"heartbeat\",\"number\":7}".encodeToByteArray(),
                ),
            )
        }

        val response = transport.call(buildJsonObject { put("type", "heartbeat") })

        assertEquals("heartbeat", response["type"]?.jsonPrimitive?.content)
        workerJob.await()
        transport.close()
        worker.close()
        server.close()
    }
}

private fun readTransportFrame(input: InputStream): ByteArray {
    val prefix = input.readNBytes(4)
    require(prefix.size == 4)
    val length = (prefix[0].toInt() and 0xff) or
        ((prefix[1].toInt() and 0xff) shl 8) or
        ((prefix[2].toInt() and 0xff) shl 16) or
        ((prefix[3].toInt() and 0xff) shl 24)
    return prefix + input.readNBytes(length)
}
