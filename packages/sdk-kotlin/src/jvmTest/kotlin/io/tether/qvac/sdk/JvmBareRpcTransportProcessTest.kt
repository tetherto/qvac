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
    private fun workerCommand(): List<String> {
        val java = Path.of(System.getProperty("java.home"), "bin", "java").toString()
        return listOf(
            java,
            "-cp",
            System.getProperty("java.class.path"),
            FakeJvmWorker::class.java.name,
        )
    }

    @Test
    fun launchesAnUnauthenticatedWorkerAndSendsRuntimeContext() = runBlocking {
        // Default connect: no auth token, and the worker must receive an
        // __init_config carrying this client's runtime context.
        val transport = JvmBareRpcTransport.connect(command = workerCommand())
        val client = QvacClient(transport)

        val heartbeat = client.heartbeat()

        assertEquals(9.0, heartbeat.number)
        client.close()
    }

    @Test
    fun authenticatesWhenRequested() = runBlocking {
        val transport = JvmBareRpcTransport.connect(
            command = workerCommand(),
            authenticated = true,
            runtimeContext = null,
        )
        val client = QvacClient(transport)

        val heartbeat = client.heartbeat()

        assertEquals(9.0, heartbeat.number)
        client.close()
    }
}

private object FakeJvmWorker {
    @JvmStatic
    fun main(args: Array<String>) {
        val environment = args.last()
        val endpoint = Regex("tcp://127\\.0\\.0\\.1:(\\d+)")
            .find(environment)
            ?.groupValues
            ?.get(1)
            ?.toInt()
            ?: error("worker endpoint missing")
        val authToken = Regex("\\\"QVAC_IPC_AUTH_TOKEN\\\":\\\"([^\\\"]+)\\\"")
            .find(environment)
            ?.groupValues
            ?.get(1)

        val socket = if (authToken != null) {
            // A racing loopback connection without the inherited capability is rejected.
            Socket("127.0.0.1", endpoint).use { unauthenticated ->
                unauthenticated.getOutputStream().write("wrong-token\n".encodeToByteArray())
                unauthenticated.getOutputStream().flush()
            }
            Socket("127.0.0.1", endpoint).also {
                it.getOutputStream().write((authToken + "\n").encodeToByteArray())
                it.getOutputStream().flush()
            }
        } else {
            Socket("127.0.0.1", endpoint)
        }

        socket.use { connection ->
            while (true) {
                val request = assertIs<BareRpcMessage.Request>(
                    BareRpcCodec.decodeFrame(readProcessFrame(connection.getInputStream())),
                )
                val body = request.data?.decodeToString() ?: ""
                val reply = when {
                    body.contains("__init_config") ->
                        if (body.contains("\"runtime\":\"jvm\"") && body.contains("\"platform\"")) {
                            "{\"success\":true}"
                        } else {
                            "{\"success\":false,\"error\":\"missing runtime context\"}"
                        }
                    body.contains("__shutdown__") -> "{\"success\":true}"
                    else -> "{\"type\":\"heartbeat\",\"number\":9}"
                }
                connection.getOutputStream().write(
                    BareRpcCodec.encodeResponse(request.id, reply.encodeToByteArray()),
                )
                if (body.contains("__shutdown__")) break
            }
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
