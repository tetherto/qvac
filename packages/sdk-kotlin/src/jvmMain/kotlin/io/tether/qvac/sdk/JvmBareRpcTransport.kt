package io.tether.qvac.sdk

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketTimeoutException
import java.io.IOException
import java.util.Collections
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

class JvmBareRpcTransport internal constructor(
    private val socket: Socket,
    private val stow: StowChannel,
    private val process: Process?,
    private val diagnostics: WorkerDiagnostics?,
    rpcLimits: RpcLimits,
) : QvacTransport {
    private val rpc = WorkerRpc(read = stow::read, send = stow::write, limits = rpcLimits)
    private val closeMutex = Mutex()
    private var closed = false
    val isWorkerAlive: Boolean get() = process?.isAlive == true
    val recentWorkerLogs: String get() = diagnostics?.text.orEmpty()
    private val shutdownHook = process?.let { child ->
        Thread({ child.destroyForcibly() }, "qvac-worker-shutdown").also {
            Runtime.getRuntime().addShutdownHook(it)
        }
    }

    override suspend fun call(payload: JsonObject): JsonObject = rpc.call(payload)

    override fun stream(payload: JsonObject): Flow<JsonObject> = rpc.stream(payload)

    override fun duplex(payload: JsonObject, input: Flow<ByteArray>): Flow<JsonObject> = rpc.duplex(payload, input)

    override suspend fun close(): Unit = withContext(NonCancellable) {
        closeMutex.withLock {
            if (closed) return@withLock
            closed = true
            try {
                if (process != null && process.isAlive) {
                    withTimeoutOrNull(SHUTDOWN_TIMEOUT_MS) { runCatching { stow.terminate() } }
                }
            } finally {
                try {
                    rpc.close()
                    withContext(Dispatchers.IO) { socket.close() }
                } finally {
                    if (process != null && process.isAlive) {
                        withContext(Dispatchers.IO) {
                            if (!process.waitFor(PROCESS_EXIT_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
                                process.destroy()
                            }
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

    companion object {
        /** Puts bare-stow framing over [socket] and starts bare-rpc once the worker signals ready. */
        internal suspend fun attach(
            socket: Socket,
            process: Process? = null,
            diagnostics: WorkerDiagnostics? = null,
            rpcLimits: RpcLimits = RpcLimits(),
        ): JvmBareRpcTransport {
            val stow = StowChannel(receive = socket::readChunk, send = socket::writeAll)
            stow.awaitReady()
            return JvmBareRpcTransport(socket, stow, process, diagnostics, rpcLimits)
        }

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
            rpcLimits: RpcLimits = RpcLimits(),
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
                command = command.argv(),
                homeDirectory = homeDirectory,
                config = config,
                runtimeContext = runtimeContext,
                timeoutMs = timeoutMs,
                rpcLimits = rpcLimits,
            )
        }

        /**
         * Starts [workerPath] with the worker shim of the `@qvac/sdk` it belongs to,
         * on [bareExecutable] or that SDK's bare-sidecar runtime.
         */
        suspend fun connect(
            workerPath: String,
            bareExecutable: String? = null,
            homeDirectory: String = defaultHomeDirectory(),
            config: JsonObject = JsonObject(emptyMap()),
            runtimeContext: JsonObject? = desktopRuntimeContext(),
            timeoutMs: Int = DEFAULT_CONNECT_TIMEOUT_MS,
            rpcLimits: RpcLimits = RpcLimits(),
        ): JvmBareRpcTransport {
            val command = JvmWorkerResolver.resolve(workerPath = workerPath, bareExecutable = bareExecutable)
            return connect(
                command = command.argv(),
                homeDirectory = homeDirectory,
                config = config,
                runtimeContext = runtimeContext,
                timeoutMs = timeoutMs,
                rpcLimits = rpcLimits,
            )
        }

        /**
         * Starts [command] with this client's loopback port appended. The worker
         * connects back to it, sending the auth token first when [authenticated],
         * and speaks bare-stow framing from then on.
         */
        suspend fun connect(
            command: List<String>,
            homeDirectory: String = defaultHomeDirectory(),
            config: JsonObject = JsonObject(emptyMap()),
            runtimeContext: JsonObject? = desktopRuntimeContext(),
            timeoutMs: Int = DEFAULT_CONNECT_TIMEOUT_MS,
            rpcLimits: RpcLimits = RpcLimits(),
            authenticated: Boolean = true,
        ): JvmBareRpcTransport {
            require(command.isNotEmpty()) { "worker command must not be empty" }
            require(timeoutMs > 0) { "timeoutMs must be positive" }
            val server = ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))
            var process: Process? = null
            var diagnostics: WorkerDiagnostics? = null
            var socket: Socket? = null
            var transport: JvmBareRpcTransport? = null
            try {
                server.soTimeout = timeoutMs
                val authToken = UUID.randomUUID().toString() + UUID.randomUUID().toString()
                val processBuilder = ProcessBuilder(command + server.localPort.toString())
                    .redirectErrorStream(true)
                // Environment, not argv: other local users can read a process's argv.
                processBuilder.environment().remove(IPC_AUTH_TOKEN_ENV)
                if (authenticated) processBuilder.environment()[IPC_AUTH_TOKEN_ENV] = authToken
                process = processBuilder.start()
                diagnostics = WorkerDiagnostics(process.inputStream)
                val accepted = withContext(Dispatchers.IO) {
                    if (authenticated) acceptAuthenticatedWorker(server, authToken, timeoutMs, process)
                    else server.accept()
                }
                socket = accepted
                // Authentication has a deadline; inference RPCs do not inherit it.
                accepted.soTimeout = 0
                val connected = withTimeout(timeoutMs.toLong()) {
                    attach(accepted, process, diagnostics, rpcLimits)
                }
                transport = connected
                val response = withTimeout(timeoutMs.toLong()) { connected.call(
                    buildJsonObject {
                        put("type", "__init_config")
                        put("homeDir", homeDirectory)
                        if (config.isNotEmpty()) put("config", config)
                        if (runtimeContext != null && runtimeContext.isNotEmpty()) {
                            put("runtimeContext", runtimeContext)
                        }
                    },
                ) }
                requireSuccessfulWorkerControlResponse("configuration", response)
                return connected
            } catch (error: WorkerAuthenticationException) {
                process?.destroyForcibly()
                throw QvacWorkerStartException("${error.message} ${diagnostics?.text.orEmpty()}".trimEnd(), error)
            } catch (error: SocketTimeoutException) {
                process?.destroyForcibly()
                throw QvacWorkerStartException(
                    "QVAC worker did not connect within ${timeoutMs}ms. ${diagnostics?.text.orEmpty()}",
                    error,
                )
            } catch (error: Throwable) {
                process?.destroyForcibly()
                if (transport != null) transport.close() else socket?.close()
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

        /**
         * Accepts until one connection presents [expectedToken]. Each handshake runs on
         * its own thread with its own deadline, so a peer that connects and stays silent
         * cannot hold the accept loop and burn the connect deadline before the child
         * worker is served. Gives up as soon as [worker] exits.
         */
        private fun acceptAuthenticatedWorker(
            server: ServerSocket,
            expectedToken: String,
            timeoutMs: Int,
            worker: Process,
        ): Socket {
            val winner = CompletableFuture<Socket>()
            val rejected = AtomicInteger()
            val pending = Collections.synchronizedSet(HashSet<Socket>())
            val handshakeTimeoutMs = minOf(HANDSHAKE_TIMEOUT_MS, timeoutMs)
            val acceptor = Thread({
                try {
                    while (true) {
                        val candidate = server.accept()
                        pending += candidate
                        Thread({
                            val authenticated = runCatching {
                                candidate.soTimeout = handshakeTimeoutMs
                                constantTimeEquals(readAuthenticationLine(candidate, MAX_AUTH_TOKEN_BYTES), expectedToken)
                            }.getOrDefault(false)
                            pending -= candidate
                            if (!authenticated) rejected.incrementAndGet()
                            if (!authenticated || !winner.complete(candidate)) runCatching { candidate.close() }
                        }, "qvac-worker-handshake").apply { isDaemon = true }.start()
                    }
                } catch (_: IOException) {
                    // The server socket was closed or hit its deadline: stop accepting.
                }
            }, "qvac-worker-accept").apply { isDaemon = true }
            server.soTimeout = timeoutMs
            acceptor.start()
            try {
                try {
                    CompletableFuture.anyOf(winner, worker.onExit()).get(timeoutMs.toLong(), TimeUnit.MILLISECONDS)
                } catch (_: TimeoutException) {
                    // Fall through: the winner check below decides.
                }
                // A handshake finishing after the deadline must not leak its socket.
                if (winner.cancel(false)) {
                    val detail = rejected.get().let { count ->
                        if (count == 0) "" else " ($count connection(s) rejected; a worker older than this " +
                            "client does not send the IPC token)"
                    }
                    val cause = if (worker.isAlive) "did not authenticate within ${timeoutMs}ms"
                    else "exited with code ${worker.exitValue()} before authenticating"
                    throw WorkerAuthenticationException("QVAC worker $cause$detail.")
                }
                return winner.get()
            } finally {
                runCatching { server.close() }
                synchronized(pending) { pending.toList() }.forEach { runCatching { it.close() } }
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
        private const val HANDSHAKE_TIMEOUT_MS = 10_000
        private const val IPC_AUTH_TOKEN_ENV = "QVAC_IPC_AUTH_TOKEN"
    }
}

private class WorkerAuthenticationException(message: String) : IOException(message)

private const val READ_CHUNK_BYTES = 64 * 1024

private suspend fun Socket.readChunk(): ByteArray? = withContext(Dispatchers.IO) {
    val buffer = ByteArray(READ_CHUNK_BYTES)
    val count = getInputStream().read(buffer)
    if (count < 0) null else buffer.copyOf(count)
}

private suspend fun Socket.writeAll(bytes: ByteArray) = withContext(Dispatchers.IO) {
    getOutputStream().write(bytes)
    getOutputStream().flush()
}
