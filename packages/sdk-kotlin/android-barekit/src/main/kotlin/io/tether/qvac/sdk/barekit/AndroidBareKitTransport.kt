package io.tether.qvac.sdk.barekit

import android.content.Context
import io.tether.qvac.sdk.QvacTransport
import io.tether.qvac.sdk.QvacRuntimeProfile
import io.tether.qvac.sdk.QvacWorkerStartException
import io.tether.qvac.sdk.RpcLimits
import io.tether.qvac.sdk.WorkerRpc
import io.tether.qvac.sdk.requireSuccessfulWorkerControlResponse
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import to.holepunch.bare.kit.IPC
import to.holepunch.bare.kit.Worklet

class AndroidBareKitTransport private constructor(
    private val rpc: WorkerRpc,
    private val channel: BareKitRpcChannel,
    private val worklet: Worklet,
    override val runtimeProfile: QvacRuntimeProfile,
) : QvacTransport {
    private val closeMutex = Mutex()
    private var closed = false

    override suspend fun call(payload: JsonObject): JsonObject = rpc.call(payload)

    override fun stream(payload: JsonObject): Flow<JsonObject> = rpc.stream(payload)

    override fun duplex(payload: JsonObject, input: Flow<ByteArray>): Flow<JsonObject> = rpc.duplex(payload, input)

    fun pause(lingerMs: Int = DEFAULT_LINGER_MS) {
        worklet.suspend(lingerMs)
    }

    fun resume() {
        worklet.resume()
    }

    override suspend fun close(): Unit = withContext(NonCancellable + Dispatchers.Main.immediate) {
        closeMutex.withLock {
            if (closed) return@withLock
            closed = true

            withTimeoutOrNull(SHUTDOWN_TIMEOUT_MS) {
                runCatching { rpc.call(buildJsonObject { put("type", "__shutdown__") }) }
            }
            runCatching { rpc.close() }
            runCatching { channel.close() }
            runCatching { worklet.terminate() }
        }
    }

    companion object {
        suspend fun connect(
            context: Context,
            assetName: String = DEFAULT_WORKER_ASSET,
            homeDirectory: String = context.filesDir.absolutePath,
            config: JsonObject = JsonObject(emptyMap()),
            runtimeContext: JsonObject? = null,
            memoryLimitBytes: Int = DEFAULT_MEMORY_LIMIT_BYTES,
            rpcLimits: RpcLimits = RpcLimits(),
        ): AndroidBareKitTransport {
            var started: AndroidBareKitTransport? = null
            try {
                return withContext(Dispatchers.Main.immediate) {
                    connectOnMain(context, assetName, homeDirectory, config, runtimeContext, memoryLimitBytes, rpcLimits)
                        .also { started = it }
                }
            } catch (error: Throwable) {
                // withContext can discard a completed result if the caller is
                // cancelled during the dispatcher handoff. Retain ownership
                // until that handoff succeeds so the worklet cannot leak.
                withContext(NonCancellable) { started?.close() }
                throw error
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

        private suspend fun connectOnMain(
            context: Context,
            assetName: String,
            homeDirectory: String,
            config: JsonObject,
            runtimeContext: JsonObject?,
            memoryLimitBytes: Int,
            rpcLimits: RpcLimits,
        ): AndroidBareKitTransport {
            val options = Worklet.Options().memoryLimit(memoryLimitBytes)
            val worklet = Worklet(options)
            var channel: BareKitRpcChannel? = null
            var rpc: WorkerRpc? = null

            try {
                val arguments = arrayOf(
                    "qvac-sdk-kotlin",
                    "worker.js",
                    buildJsonObject { put("HOME_DIR", homeDirectory) }.toString(),
                )
                context.assets.open(assetName).use { source ->
                    worklet.start(assetName, source, arguments)
                }

                val connectedChannel = BareKitRpcChannel(IPC(worklet))
                channel = connectedChannel
                val connectedRpc = WorkerRpc(read = connectedChannel::read, send = connectedChannel::write, limits = rpcLimits)
                rpc = connectedRpc
                val transport = AndroidBareKitTransport(
                    connectedRpc,
                    connectedChannel,
                    worklet,
                    AndroidRuntimeProfile.load(context),
                )
                val effectiveRuntimeContext = androidRuntimeContext(runtimeContext)
                if (config.isNotEmpty() || effectiveRuntimeContext.isNotEmpty()) {
                    val response = transport.call(
                        buildJsonObject {
                            put("type", "__init_config")
                            if (config.isNotEmpty()) put("config", config)
                            put("runtimeContext", effectiveRuntimeContext)
                        },
                    )
                    requireSuccessfulWorkerControlResponse("configuration", response)
                }
                return transport
            } catch (error: Throwable) {
                withContext(NonCancellable) {
                    runCatching { rpc?.close() }
                    runCatching { channel?.close() }
                    runCatching { worklet.terminate() }
                }
                if (error is CancellationException) throw error
                throw QvacWorkerStartException("Failed to start QVAC BareKit worker", error)
            }
        }

        private const val DEFAULT_WORKER_ASSET = "qvac/worker.bundle"
        private const val DEFAULT_MEMORY_LIMIT_BYTES = 0
        private const val DEFAULT_LINGER_MS = 30_000
        private const val SHUTDOWN_TIMEOUT_MS = 10_000L
    }
}
