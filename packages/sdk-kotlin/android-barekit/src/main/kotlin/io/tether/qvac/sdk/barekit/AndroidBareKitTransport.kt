package io.tether.qvac.sdk.barekit

import android.content.Context
import io.tether.qvac.sdk.QvacTransport
import io.tether.qvac.sdk.QvacRuntimeProfile
import io.tether.qvac.sdk.QvacWorkerStartException
import io.tether.qvac.sdk.RpcLimits
import io.tether.qvac.sdk.WorkerRpc
import io.tether.qvac.sdk.barekit.worker.start
import io.tether.qvac.sdk.requireSuccessfulWorkerControlResponse
import kotlin.time.Duration.Companion.seconds
import kotlin.time.TimeSource
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import to.holepunch.bare.kit.Worklet
import to.holepunch.bare.stow.host.Ipc

/** The worker started by bare-stow's `bare-kit` harness, with bare-rpc over its `ipc`. */
class AndroidBareKitTransport private constructor(
    private val rpc: WorkerRpc,
    private val ipc: Ipc,
    private val worklet: Worklet,
    override val runtimeProfile: QvacRuntimeProfile,
) : QvacTransport {
    private val closeMutex = Mutex()
    private var closed = false

    override suspend fun call(payload: JsonObject): JsonObject = rpc.call(payload)

    override fun stream(payload: JsonObject): Flow<JsonObject> = rpc.stream(payload)

    override fun duplex(payload: JsonObject, input: Flow<ByteArray>): Flow<JsonObject> = rpc.duplex(payload, input)

    /** Suspends the worker. Does nothing once the worker has exited. */
    fun pause(lingerMs: Int = DEFAULT_LINGER_MS) {
        whileRunning { worklet.suspend(lingerMs) }
    }

    /** Resumes a suspended worker. Does nothing once the worker has exited. */
    fun resume() {
        whileRunning { worklet.resume() }
    }

    // The harness closes the worklet once it exits, after which its methods throw.
    private inline fun whileRunning(block: () -> Unit) {
        try {
            block()
        } catch (_: IllegalStateException) {
        }
    }

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

        /**
         * Starts the worker in this process. Refused once a worker in this process was
         * killed or died before its cleanup finished, since a new worker could crash
         * on the addon state it left behind; restart the process to start one.
         */
        suspend fun connect(
            context: Context,
            homeDirectory: String = context.filesDir.absolutePath,
            config: JsonObject = JsonObject(emptyMap()),
            runtimeContext: JsonObject? = null,
            memoryLimitBytes: Int = DEFAULT_MEMORY_LIMIT_BYTES,
            rpcLimits: RpcLimits = RpcLimits(),
        ): AndroidBareKitTransport {
            if (uncleanStop) {
                throw QvacWorkerStartException(
                    "A QVAC worker in this process stopped before its cleanup finished; " +
                        "restart the process to start a new one",
                )
            }
            val profile = AndroidRuntimeProfile.load(context)
            val launched = TimeSource.Monotonic.markNow()
            val started = try {
                start(
                    context,
                    Worklet.Options(memoryLimit = memoryLimitBytes.toLong()),
                    timeout = START_TIMEOUT,
                    grace = SHUTDOWN_GRACE,
                )
            } catch (error: Throwable) {
                if (error is CancellationException) throw error
                throw QvacWorkerStartException("Failed to start QVAC BareKit worker", error)
            }
            val rpc = WorkerRpc(data = started.ipc.data, send = started.ipc::write, limits = rpcLimits)
            val transport = AndroidBareKitTransport(rpc, started.ipc, started.worklet, profile)
            try {
                val response = withTimeoutOrNull(START_TIMEOUT - launched.elapsedNow()) {
                    transport.call(
                        buildJsonObject {
                            put("type", "__init_config")
                            if (config.isNotEmpty()) put("config", config)
                            put("runtimeContext", androidRuntimeContext(runtimeContext))
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

        // Android hosts report device identity so @qvac/inference can apply its
        // device-specific defaults (e.g. Pixel → llama device=cpu) without the
        // caller configuring anything. Caller-supplied keys override the defaults.
        private fun androidRuntimeContext(override: JsonObject?): JsonObject = buildJsonObject {
            put("platform", "android")
            put("deviceBrand", android.os.Build.MANUFACTURER)
            put("deviceModel", android.os.Build.MODEL)
            override?.forEach { (key, value) -> put(key, value) }
        }

        private const val DEFAULT_MEMORY_LIMIT_BYTES = 0
        private const val DEFAULT_LINGER_MS = 30_000
        private val START_TIMEOUT = 30.seconds
        private val SHUTDOWN_GRACE = 10.seconds

        // Longer than the grace, so a worker killed when the grace runs out still reports its exit.
        private val SHUTDOWN_TIMEOUT = SHUTDOWN_GRACE + 2.seconds
    }
}
