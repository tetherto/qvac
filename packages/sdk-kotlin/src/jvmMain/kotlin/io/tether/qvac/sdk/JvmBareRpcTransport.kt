package io.tether.qvac.sdk

import io.tether.qvac.sdk.rpc.BareRpcProtocolException
import io.tether.qvac.sdk.rpc.BareRpcLimits
import io.tether.qvac.sdk.rpc.JsonLinesDecoder
import io.tether.qvac.sdk.rpc.JvmBareRpcSession
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketTimeoutException
import java.util.concurrent.TimeUnit
import java.util.UUID
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

class JvmBareRpcTransport internal constructor(
    private val session: JvmBareRpcSession,
    private val process: Process? = null,
    private val diagnostics: WorkerDiagnostics? = null,
    private val rpcLimits: BareRpcLimits = BareRpcLimits(),
    private val json: Json = Json {
        ignoreUnknownKeys = true
        explicitNulls = false
    },
) : QvacTransport {
    private val closeMutex = Mutex()
    private var closed = false
    val isWorkerAlive: Boolean get() = process?.isAlive == true
    val recentWorkerLogs: String get() = diagnostics?.text.orEmpty()
    private val shutdownHook = process?.let { child ->
        Thread({ child.destroyForcibly() }, "qvac-worker-shutdown").also {
            Runtime.getRuntime().addShutdownHook(it)
        }
    }
    override suspend fun call(payload: JsonObject): JsonObject {
        val response = session.request(encode(payload))
        return decode(response)
    }

    override fun stream(payload: JsonObject): Flow<JsonObject> {
        return decodeLines(session.responseStream(encode(payload)))
    }

    override fun duplex(payload: JsonObject, input: Flow<ByteArray>): Flow<JsonObject> {
        return decodeLines(session.duplex(encode(payload), input))
    }

    override suspend fun close(): Unit = withContext(NonCancellable) {
        closeMutex.withLock {
            if (closed) return@withLock
            closed = true
            try {
                if (process != null && process.isAlive) {
                    withTimeoutOrNull(SHUTDOWN_TIMEOUT_MS) {
                        runCatching { session.request("""{"type":"__shutdown__"}""".encodeToByteArray()) }
                    }
                }
            } finally {
                try { session.close() } finally {
                    if (process != null && process.isAlive) {
                        withContext(Dispatchers.IO) {
                            process.destroy()
                            if (!process.waitFor(PROCESS_EXIT_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
                                process.destroyForcibly()
                                process.waitFor(PROCESS_EXIT_TIMEOUT_SECONDS, TimeUnit.SECONDS)
                            }
                        }
                    }
                    shutdownHook?.let { runCatching { Runtime.getRuntime().removeShutdownHook(it) } }
                }
            }
        }
    }

    private fun decodeLines(chunks: Flow<ByteArray>): Flow<JsonObject> = flow {
        val decoder = JsonLinesDecoder(rpcLimits.maxJsonLineBytes)
        chunks.collect { chunk ->
            for (line in decoder.feed(chunk)) emit(decode(line.encodeToByteArray()))
        }
        for (line in decoder.finish()) emit(decode(line.encodeToByteArray()))
    }

    private fun encode(payload: JsonObject): ByteArray {
        return json.encodeToString(JsonObject.serializer(), payload).encodeToByteArray()
    }

    private fun decode(payload: ByteArray): JsonObject {
        return try {
            json.parseToJsonElement(payload.decodeToString()).jsonObject
        } catch (error: Throwable) {
            throw BareRpcProtocolException("worker returned invalid JSON: ${error.message}")
        }
    }

    companion object {
        /**
         * Finds a version-compatible worker using explicit arguments, QVAC_* environment
         * variables, a local/managed @qvac/sdk installation, or the global npm installation.
         */
        suspend fun connectResolved(
            workerPath: String? = null,
            bareExecutable: String? = null,
            sdkDirectory: String? = null,
            installWorkerIfMissing: Boolean = false,
            homeDirectory: String = defaultHomeDirectory(),
            config: JsonObject = JsonObject(emptyMap()),
            runtimeContext: JsonObject? = desktopRuntimeContext(),
            timeoutMs: Int = DEFAULT_CONNECT_TIMEOUT_MS,
            rpcLimits: BareRpcLimits = BareRpcLimits(),
        ): JvmBareRpcTransport {
            val command = try {
                JvmWorkerResolver.resolve(
                    workerPath = workerPath,
                    bareExecutable = bareExecutable,
                    sdkDirectory = sdkDirectory,
                )
            } catch (error: QvacWorkerStartException) {
                val explicitWorker = workerPath != null || sdkDirectory != null ||
                    System.getenv("QVAC_WORKER_PATH") != null || System.getenv("QVAC_SDK_DIR") != null
                if (!installWorkerIfMissing || explicitWorker) throw error
                val installedSdk = JvmWorkerInstaller.install()
                JvmWorkerResolver.resolve(
                    bareExecutable = bareExecutable,
                    sdkDirectory = installedSdk.toString(),
                )
            }
            return connect(
                command = listOf(command.bareExecutable, command.workerPath),
                homeDirectory = homeDirectory,
                config = config,
                runtimeContext = runtimeContext,
                timeoutMs = timeoutMs,
                rpcLimits = rpcLimits,
                authenticated = command.authenticated,
            )
        }

        suspend fun connect(
            workerPath: String,
            bareExecutable: String = "bare",
            homeDirectory: String = defaultHomeDirectory(),
            config: JsonObject = JsonObject(emptyMap()),
            runtimeContext: JsonObject? = desktopRuntimeContext(),
            timeoutMs: Int = DEFAULT_CONNECT_TIMEOUT_MS,
            rpcLimits: BareRpcLimits = BareRpcLimits(),
            authenticated: Boolean = false,
        ): JvmBareRpcTransport {
            return connect(
                command = listOf(bareExecutable, workerPath),
                homeDirectory = homeDirectory,
                config = config,
                runtimeContext = runtimeContext,
                timeoutMs = timeoutMs,
                rpcLimits = rpcLimits,
                authenticated = authenticated,
            )
        }

        suspend fun connect(
            command: List<String>,
            homeDirectory: String = defaultHomeDirectory(),
            config: JsonObject = JsonObject(emptyMap()),
            runtimeContext: JsonObject? = desktopRuntimeContext(),
            timeoutMs: Int = DEFAULT_CONNECT_TIMEOUT_MS,
            rpcLimits: BareRpcLimits = BareRpcLimits(),
            authenticated: Boolean = false,
        ): JvmBareRpcTransport {
            require(command.isNotEmpty()) { "worker command must not be empty" }
            require(timeoutMs > 0) { "timeoutMs must be positive" }
            val server = ServerSocket(0, 1, InetAddress.getLoopbackAddress())
            var process: Process? = null
            var diagnostics: WorkerDiagnostics? = null
            var transport: JvmBareRpcTransport? = null
            try {
                server.soTimeout = timeoutMs
                val endpoint = "tcp://127.0.0.1:${server.localPort}"
                val authToken = UUID.randomUUID().toString() + UUID.randomUUID().toString()
                val workerEnvironment = buildJsonObject {
                    put("QVAC_IPC_SOCKET_PATH", endpoint)
                    if (authenticated) put("QVAC_IPC_AUTH_TOKEN", authToken)
                    put("HOME_DIR", homeDirectory)
                }.toString()

                process = ProcessBuilder(command + workerEnvironment)
                    .redirectErrorStream(true)
                    .start()
                diagnostics = WorkerDiagnostics(process.inputStream)
                val socket = withContext(Dispatchers.IO) {
                    if (authenticated) acceptAuthenticatedWorker(server, authToken, timeoutMs)
                    else server.accept()
                }
                // Authentication has a deadline; inference RPCs do not inherit it.
                socket.soTimeout = 0
                val connected = JvmBareRpcTransport(JvmBareRpcSession(socket, rpcLimits), process, diagnostics, rpcLimits)
                transport = connected
                val effectiveRuntimeContext = runtimeContext ?: JsonObject(emptyMap())
                if (config.isNotEmpty() || effectiveRuntimeContext.isNotEmpty()) {
                    val response = withTimeout(timeoutMs.toLong()) { connected.call(
                        buildJsonObject {
                            put("type", "__init_config")
                            if (config.isNotEmpty()) put("config", config)
                            if (effectiveRuntimeContext.isNotEmpty()) put("runtimeContext", effectiveRuntimeContext)
                        },
                    ) }
                    requireSuccessfulWorkerControlResponse("configuration", response)
                }
                return connected
            } catch (error: SocketTimeoutException) {
                process?.destroyForcibly()
                throw QvacWorkerStartException(
                    "QVAC worker did not connect within ${timeoutMs}ms. ${diagnostics?.text.orEmpty()}",
                    error,
                )
            } catch (error: Throwable) {
                process?.destroyForcibly()
                transport?.close()
                throw QvacWorkerStartException("Failed to start QVAC worker", error)
            } finally {
                server.close()
            }
        }

        private fun desktopRuntimeContext(): JsonObject = buildJsonObject {
            put("runtime", "jvm")
            put("platform", desktopPlatform())
        }

        private fun desktopPlatform(): String {
            val osName = System.getProperty("os.name").orEmpty().lowercase()
            return when {
                osName.contains("mac") || osName.contains("darwin") -> "darwin"
                osName.contains("win") -> "win32"
                else -> "linux"
            }
        }

        private fun defaultHomeDirectory(): String {
            return System.getenv("QVAC_HOME_DIR")
                ?: System.getProperty("user.home")
                ?: System.getProperty("java.io.tmpdir")
        }

        private fun acceptAuthenticatedWorker(
            server: ServerSocket,
            expectedToken: String,
            timeoutMs: Int,
        ): Socket {
            val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMs.toLong())
            while (true) {
                val remainingMs = TimeUnit.NANOSECONDS.toMillis(deadline - System.nanoTime())
                if (remainingMs <= 0) throw SocketTimeoutException("QVAC worker authentication timed out")
                server.soTimeout = remainingMs.coerceAtMost(Int.MAX_VALUE.toLong()).toInt().coerceAtLeast(1)
                val candidate = server.accept()
                try {
                    candidate.soTimeout = server.soTimeout
                    val received = readAuthenticationLine(candidate, MAX_AUTH_TOKEN_BYTES)
                    if (constantTimeEquals(received, expectedToken)) return candidate
                } catch (_: Throwable) {
                    // Reject this connection and continue waiting for the child worker.
                }
                runCatching { candidate.close() }
            }
        }

        private fun readAuthenticationLine(socket: Socket, maxBytes: Int): String {
            val input = socket.getInputStream()
            val bytes = ArrayList<Byte>(maxBytes)
            while (bytes.size < maxBytes) {
                val value = input.read()
                if (value < 0) throw QvacWorkerStartException("Worker closed before authentication")
                if (value == '\n'.code) return bytes.toByteArray().decodeToString()
                bytes += value.toByte()
            }
            throw QvacWorkerStartException("Worker authentication token exceeded $maxBytes bytes")
        }

        private fun constantTimeEquals(left: String, right: String): Boolean {
            val leftBytes = left.encodeToByteArray()
            val rightBytes = right.encodeToByteArray()
            var difference = leftBytes.size xor rightBytes.size
            val count = maxOf(leftBytes.size, rightBytes.size)
            for (index in 0 until count) {
                val a = leftBytes.getOrElse(index) { 0 }
                val b = rightBytes.getOrElse(index) { 0 }
                difference = difference or (a.toInt() xor b.toInt())
            }
            return difference == 0
        }

        private const val DEFAULT_CONNECT_TIMEOUT_MS = 30_000
        private const val SHUTDOWN_TIMEOUT_MS = 10_000L
        private const val PROCESS_EXIT_TIMEOUT_SECONDS = 5L
        private const val MAX_AUTH_TOKEN_BYTES = 256
    }
}
