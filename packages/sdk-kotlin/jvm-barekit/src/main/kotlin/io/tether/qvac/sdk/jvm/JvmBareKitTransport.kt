package io.tether.qvac.sdk.jvm

import io.tether.qvac.sdk.QvacRuntimeProfile
import io.tether.qvac.sdk.QvacTransport
import io.tether.qvac.sdk.QvacWorkerStartException
import io.tether.qvac.sdk.RpcLimits
import io.tether.qvac.sdk.WorkerRpc
import io.tether.qvac.sdk.jvm.worker.start
import io.tether.qvac.sdk.requireSuccessfulWorkerControlResponse
import kotlin.time.Duration.Companion.seconds
import kotlin.time.TimeSource
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import to.holepunch.bare.kit.Worklet
import to.holepunch.bare.stow.host.Ipc
import to.holepunch.bare.stow.host.WorkerError

/** The worker started in this JVM by bare-stow's `bare-kit` harness, with bare-rpc over its `ipc`. */
class JvmBareKitTransport private constructor(
    private val rpc: WorkerRpc,
    private val ipc: Ipc,
    private val worklet: Worklet,
    override val runtimeProfile: QvacRuntimeProfile,
) : QvacTransport {
    private val closeMutex = Mutex()
    private var closed = false

    // Ends with the worker's ipc: the worker exited, crashed or was killed, or close() stopped it.
    override val lost: Deferred<Unit> = exitWatch.async {
        runCatching { ipc.wait() }
        Unit
    }

    override suspend fun call(payload: JsonObject): JsonObject = rpc.call(payload)

    override fun stream(payload: JsonObject): Flow<JsonObject> = rpc.stream(payload)

    override fun duplex(payload: JsonObject, input: Flow<ByteArray>): Flow<JsonObject> = rpc.duplex(payload, input)

    override suspend fun close(): Unit = withContext(NonCancellable) {
        closeMutex.withLock {
            if (closed) return@withLock
            closed = true

            runCatching { rpc.close() }
            val exitCode = withTimeoutOrNull(SHUTDOWN_TIMEOUT) {
                runCatching { ipc.terminate() }.getOrNull()
            }
            // A worker that did not report its exit was killed or died before its
            // cleanup finished, which leaves addon state behind in this process.
            if (exitCode == null) uncleanStop = true
            runCatching { worklet.close() }
        }
    }

    companion object {
        @Volatile
        private var uncleanStop = false

        private val exitWatch = CoroutineScope(SupervisorJob() + Dispatchers.Default)

        /**
         * Watches a started worker until its transport ends. One that ends without
         * reporting its exit was killed or died before its cleanup finished, whether
         * or not its transport was closed.
         */
        internal fun watchExit(ipc: Ipc, onUncleanStop: () -> Unit = { uncleanStop = true }): Job =
            exitWatch.launch {
                if (ipc.wait() == null) onUncleanStop()
            }

        /**
         * Runs [start]. A start that fails hands back no `Ipc` for [watchExit], so the
         * bare-stow-host error code is the only sign of whether the worker reported its
         * exit; one that did not may have loaded addons before it was killed.
         */
        internal suspend fun <T> startWorker(
            onUncleanStop: () -> Unit = { uncleanStop = true },
            start: suspend () -> T,
        ): T =
            try {
                start()
            } catch (error: Throwable) {
                if (error is CancellationException) throw error
                if (error is WorkerError && error.code in UNREPORTED_EXIT_CODES) onUncleanStop()
                throw QvacWorkerStartException("Failed to start QVAC BareKit worker", error)
            }

        /** bare-stow-host codes for a worker that ended before ready without reporting its exit. */
        private val UNREPORTED_EXIT_CODES = setOf("WORKER_TIMEOUT", "WORKER_CLOSED", "WORKER_KILLED", "TRANSPORT_ERROR")

        /**
         * Starts the worker in this JVM. Refused once a worker in this process was
         * killed or died before its cleanup finished, since a new worker could crash
         * on the addon state it left behind; restart the process to start one.
         */
        suspend fun connect(
            homeDirectory: String = defaultHomeDirectory(),
            config: JsonObject = JsonObject(emptyMap()),
            runtimeContext: JsonObject? = null,
            memoryLimitBytes: Int = DEFAULT_MEMORY_LIMIT_BYTES,
            rpcLimits: RpcLimits = RpcLimits(),
        ): JvmBareKitTransport {
            if (uncleanStop) {
                throw QvacWorkerStartException(
                    "A QVAC worker in this process stopped before its cleanup finished; " +
                        "restart the process to start a new one",
                )
            }
            val profile = loadProfile()
            val launched = TimeSource.Monotonic.markNow()
            val started = startWorker {
                start(
                    Worklet.Options(memoryLimit = memoryLimitBytes.toLong()),
                    timeout = START_TIMEOUT,
                    grace = SHUTDOWN_GRACE,
                )
            }
            watchExit(started.ipc)
            val rpc = WorkerRpc(data = started.ipc.data, send = started.ipc::write, limits = rpcLimits)
            val transport = JvmBareKitTransport(rpc, started.ipc, started.worklet, profile)
            try {
                val response = withTimeoutOrNull(START_TIMEOUT - launched.elapsedNow()) {
                    transport.call(
                        buildJsonObject {
                            put("type", "__init_config")
                            if (config.isNotEmpty()) put("config", config)
                            put("runtimeContext", desktopRuntimeContext(runtimeContext))
                            put("homeDir", homeDirectory)
                        },
                    )
                } ?: throw QvacWorkerStartException(
                    "QVAC worker did not start within $START_TIMEOUT",
                )
                requireSuccessfulWorkerControlResponse("configuration", response)
                return transport
            } catch (error: Throwable) {
                transport.close()
                if (error is CancellationException || error is QvacWorkerStartException) throw error
                throw QvacWorkerStartException("Failed to start QVAC BareKit worker", error)
            }
        }

        private val json = Json { ignoreUnknownKeys = true }

        private fun loadProfile(): QvacRuntimeProfile {
            val resource = JvmBareKitTransport::class.java.classLoader.getResourceAsStream(PROFILE_RESOURCE)
                ?: throw QvacWorkerStartException("QVAC runtime profile $PROFILE_RESOURCE is missing from the classpath")
            return resource.bufferedReader().use { json.decodeFromString<QvacRuntimeProfile>(it.readText()) }
        }

        // Caller-supplied keys override the defaults.
        private fun desktopRuntimeContext(override: JsonObject?): JsonObject = buildJsonObject {
            put("runtime", "jvm")
            put("platform", desktopPlatform())
            override?.forEach { (key, value) -> put(key, value) }
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

        private const val PROFILE_RESOURCE = "qvac/profile.json"
        private const val DEFAULT_MEMORY_LIMIT_BYTES = 0
        private val START_TIMEOUT = 30.seconds
        private val SHUTDOWN_GRACE = 10.seconds

        // Longer than the grace, so a worker killed when the grace runs out still reports its exit.
        private val SHUTDOWN_TIMEOUT = SHUTDOWN_GRACE + 2.seconds
    }
}
