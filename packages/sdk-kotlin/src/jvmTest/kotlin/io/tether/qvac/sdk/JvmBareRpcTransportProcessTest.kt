package io.tether.qvac.sdk

import io.tether.qvac.sdk.rpc.BareRpcCodec
import io.tether.qvac.sdk.rpc.BareRpcMessage
import kotlinx.coroutines.runBlocking
import java.io.InputStream
import java.net.Socket
import java.nio.file.Path
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs

class JvmBareRpcTransportProcessTest {
    @Test
    fun launchesAWorkerCommandAndCompletesHeartbeat() = runBlocking {
        val java = Path.of(System.getProperty("java.home"), "bin", "java").toString()
        val command = listOf(
            java,
            "-cp",
            System.getProperty("java.class.path"),
            FakeJvmWorker::class.java.name,
        )
        val transport = JvmBareRpcTransport.connect(command = command)
        val client = QvacClient(transport)

        val heartbeat = client.heartbeat()

        assertEquals(9.0, heartbeat.number)
        client.close()
    }
}

private object FakeJvmWorker {
    @JvmStatic
    fun main(args: Array<String>) {
        val endpoint = Regex("tcp://127\\.0\\.0\\.1:(\\d+)")
            .find(args.last())
            ?.groupValues
            ?.get(1)
            ?.toInt()
            ?: error("worker endpoint missing")
        val authToken = Regex("\\\"QVAC_IPC_AUTH_TOKEN\\\":\\\"([^\\\"]+)\\\"")
            .find(args.last())
            ?.groupValues
            ?.get(1)
            ?: error("worker authentication token missing")

        // A racing loopback connection without the inherited capability is rejected.
        Socket("127.0.0.1", endpoint).use { unauthenticated ->
            unauthenticated.getOutputStream().write("wrong-token\n".encodeToByteArray())
            unauthenticated.getOutputStream().flush()
        }
        Socket("127.0.0.1", endpoint).use { socket ->
            socket.getOutputStream().write((authToken + "\n").encodeToByteArray())
            socket.getOutputStream().flush()
            val heartbeat = assertIs<BareRpcMessage.Request>(
                BareRpcCodec.decodeFrame(readProcessFrame(socket.getInputStream())),
            )
            socket.getOutputStream().write(
                BareRpcCodec.encodeResponse(
                    heartbeat.id,
                    "{\"type\":\"heartbeat\",\"number\":9}".encodeToByteArray(),
                ),
            )

            val shutdown = assertIs<BareRpcMessage.Request>(
                BareRpcCodec.decodeFrame(readProcessFrame(socket.getInputStream())),
            )
            socket.getOutputStream().write(
                BareRpcCodec.encodeResponse(
                    shutdown.id,
                    "{\"success\":true}".encodeToByteArray(),
                ),
            )
        }
    }
}

private fun readProcessFrame(input: InputStream): ByteArray {
    val prefix = input.readNBytes(4)
    require(prefix.size == 4)
    val length = (prefix[0].toInt() and 0xff) or
        ((prefix[1].toInt() and 0xff) shl 8) or
        ((prefix[2].toInt() and 0xff) shl 16) or
        ((prefix[3].toInt() and 0xff) shl 24)
    return prefix + input.readNBytes(length)
}
