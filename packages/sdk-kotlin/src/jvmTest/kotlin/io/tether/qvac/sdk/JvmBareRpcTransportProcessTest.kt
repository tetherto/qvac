package io.tether.qvac.sdk

import io.tether.qvac.sdk.rpc.BareRpcCodec
import io.tether.qvac.sdk.rpc.BareRpcMessage
import kotlinx.coroutines.runBlocking
import java.io.InputStream
import java.io.OutputStream
import java.net.Socket
import java.nio.file.Path
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertIs
import kotlin.test.assertTrue

class JvmBareRpcTransportProcessTest {
    private fun workerCommand(main: String = FakeJvmWorker::class.java.name): List<String> {
        val java = Path.of(System.getProperty("java.home"), "bin", "java").toString()
        return listOf(java, "-cp", System.getProperty("java.class.path"), main)
    }

    @Test
    fun authenticatesByDefaultAndSendsRuntimeContext() = runBlocking {
        // The worker must receive an __init_config carrying this client's
        // runtime context and home folder, after the token handshake.
        val transport = JvmBareRpcTransport.connect(command = workerCommand())
        val client = QvacClient(transport)

        val heartbeat = client.heartbeat()

        assertEquals(9.0, heartbeat.number)
        client.close()
    }

    @Test
    fun connectsWithoutAuthenticationWhenOptedOut() = runBlocking {
        val transport = JvmBareRpcTransport.connect(
            command = workerCommand(),
            authenticated = false,
            runtimeContext = null,
        )
        val client = QvacClient(transport)

        val heartbeat = client.heartbeat()

        assertEquals(9.0, heartbeat.number)
        client.close()
    }

    @Test
    fun tokenlessWorkerFailsAsSoonAsItExits() = runBlocking {
        val started = System.nanoTime()
        val error = assertFailsWith<QvacWorkerStartException> {
            JvmBareRpcTransport.connect(
                command = workerCommand(TokenlessJvmWorker::class.java.name),
                timeoutMs = 60_000,
            )
        }

        val message = error.message.orEmpty()
        assertTrue(message.contains("exited with code 1 before authenticating"), message)
        assertTrue(message.contains("does not send the IPC token"), message)
        assertTrue(System.nanoTime() - started < 30_000_000_000L, "waited for the connect deadline")
    }
}

/** A worker from before token IPC: it dials without the token and exits once dropped. */
private object TokenlessJvmWorker {
    @JvmStatic
    fun main(args: Array<String>) {
        Socket("127.0.0.1", args.last().toInt()).use { socket ->
            socket.shutdownOutput()
            // Exit only once the client has dropped the connection, as a real worker does.
            while (socket.getInputStream().read() >= 0) Unit
        }
        kotlin.system.exitProcess(1)
    }
}

/** Stands in for bare-sidecar's runtime running the SDK's TCP shim. */
private object FakeJvmWorker {
    private const val CONTROL = 0
    private const val DATA = 1

    @JvmStatic
    fun main(args: Array<String>) {
        val port = args.last().toInt()
        val authToken = System.getenv("QVAC_IPC_AUTH_TOKEN")
        check(authToken == null || args.none { authToken in it }) { "auth token leaked into argv" }

        val socket = if (authToken != null) {
            // A racing loopback connection without the inherited capability is rejected.
            Socket("127.0.0.1", port).use { unauthenticated ->
                unauthenticated.getOutputStream().write("wrong-token\n".encodeToByteArray())
                unauthenticated.getOutputStream().flush()
            }
            // A peer that connects first and never writes must not hold up the
            // handshake of the real worker behind it.
            val silent = Socket("127.0.0.1", port)
            Runtime.getRuntime().addShutdownHook(Thread { runCatching { silent.close() } })
            Socket("127.0.0.1", port).also {
                it.getOutputStream().write((authToken + "\n").encodeToByteArray())
                it.getOutputStream().flush()
            }
        } else {
            Socket("127.0.0.1", port)
        }

        socket.use { connection ->
            val output = connection.getOutputStream()
            writeFrame(output, CONTROL, """{"type":"ready"}""".encodeToByteArray())
            while (true) {
                val (tag, payload) = readFrame(connection.getInputStream())
                if (tag == CONTROL) {
                    if (payload.decodeToString().contains("terminate")) {
                        writeFrame(output, CONTROL, """{"type":"exit","code":0}""".encodeToByteArray())
                        break
                    }
                    continue
                }
                val request = assertIs<BareRpcMessage.Request>(BareRpcCodec.decodeFrame(payload))
                val body = request.data?.decodeToString() ?: ""
                val reply = when {
                    body.contains("__init_config") ->
                        if (body.contains("\"homeDir\"") && runtimeContextMatches(body)) {
                            "{\"success\":true}"
                        } else {
                            "{\"success\":false,\"error\":\"missing home folder or runtime context\"}"
                        }
                    else -> "{\"type\":\"heartbeat\",\"number\":9}"
                }
                writeFrame(output, DATA, BareRpcCodec.encodeResponse(request.id, reply.encodeToByteArray()))
            }
        }
    }

    /** A runtime context, when sent, names the JVM and the platform. */
    private fun runtimeContextMatches(body: String): Boolean =
        !body.contains("runtimeContext") ||
            (body.contains("\"runtime\":\"jvm\"") && body.contains("\"platform\""))

    private fun writeFrame(output: OutputStream, tag: Int, payload: ByteArray) {
        val length = payload.size + 1
        output.write(
            byteArrayOf(
                length.toByte(),
                (length ushr 8).toByte(),
                (length ushr 16).toByte(),
                (length ushr 24).toByte(),
                tag.toByte(),
            ) + payload,
        )
        output.flush()
    }

    private fun readFrame(input: InputStream): Pair<Int, ByteArray> {
        val prefix = input.readNBytes(4)
        require(prefix.size == 4) { "worker connection closed" }
        val length = (prefix[0].toInt() and 0xff) or
            ((prefix[1].toInt() and 0xff) shl 8) or
            ((prefix[2].toInt() and 0xff) shl 16) or
            ((prefix[3].toInt() and 0xff) shl 24)
        val body = input.readNBytes(length)
        return body[0].toInt() to body.copyOfRange(1, body.size)
    }
}
