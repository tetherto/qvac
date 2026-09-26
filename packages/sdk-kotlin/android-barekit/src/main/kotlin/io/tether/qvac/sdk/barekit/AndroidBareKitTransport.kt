package io.tether.qvac.sdk.barekit

import android.content.Context
import io.tether.qvac.sdk.QvacTransport
import io.tether.qvac.sdk.QvacRuntimeProfile
import io.tether.qvac.sdk.QvacWorkerStartException
import io.tether.qvac.sdk.requireSuccessfulWorkerControlResponse
import io.tether.qvac.sdk.rpc.BareRpcProtocolException
import io.tether.qvac.sdk.rpc.BareRpcSession
import io.tether.qvac.sdk.rpc.JsonLinesDecoder
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import to.holepunch.bare.kit.IPC
import to.holepunch.bare.kit.Worklet

class AndroidBareKitTransport private constructor(
    private val session: BareRpcSession,
    private val worklet: Worklet,
    private val json: Json,
    override val runtimeProfile: QvacRuntimeProfile,
    private val rpcLimits: io.tether.qvac.sdk.rpc.BareRpcLimits,
) : QvacTransport {
    private val closeMutex = Mutex()
    private var closed = false

    override suspend fun call(payload: JsonObject): JsonObject {
        return decode(session.request(encode(payload)))
    }

    override fun stream(payload: JsonObject): Flow<JsonObject> {
        return decodeLines(session.responseStream(encode(payload)))
    }

    override fun duplex(payload: JsonObject, input: Flow<ByteArray>): Flow<JsonObject> {
        return decodeLines(session.duplex(encode(payload), input))
    }

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
                runCatching {
                    session.request("""{"type":"__shutdown__"}""".encodeToByteArray())
                }
            }
            runCatching { session.close() }
            runCatching { worklet.terminate() }
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
        suspend fun connect(
            context: Context,
            assetName: String = DEFAULT_WORKER_ASSET,
            homeDirectory: String = context.filesDir.absolutePath,
            config: JsonObject = JsonObject(emptyMap()),
            runtimeContext: JsonObject? = null,
            memoryLimitBytes: Int = DEFAULT_MEMORY_LIMIT_BYTES,
            rpcLimits: io.tether.qvac.sdk.rpc.BareRpcLimits = io.tether.qvac.sdk.rpc.BareRpcLimits(),
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
            rpcLimits: io.tether.qvac.sdk.rpc.BareRpcLimits,
        ): AndroidBareKitTransport {
            val json = Json {
                ignoreUnknownKeys = true
                explicitNulls = false
            }
            val options = Worklet.Options().memoryLimit(memoryLimitBytes)
            val worklet = Worklet(options)
            var channel: BareKitRpcChannel? = null
            var session: BareRpcSession? = null

            try {
                val arguments = arrayOf(
                    "qvac-sdk-kotlin",
                    "worker.js",
                    buildJsonObject { put("HOME_DIR", homeDirectory) }.toString(),
                )
                context.assets.open(assetName).use { source ->
                    worklet.start(assetName, source, arguments)
                }

                val ipc = IPC(worklet)
                val connectedChannel = BareKitRpcChannel(ipc)
                channel = connectedChannel
                val connectedSession = BareRpcSession(connectedChannel, rpcLimits)
                session = connectedSession
                val transport = AndroidBareKitTransport(
                    connectedSession,
                    worklet,
                    json,
                    AndroidRuntimeProfile.load(context),
                    rpcLimits,
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
                    val failedSession = session
                    if (failedSession == null) {
                        runCatching { channel?.close() }
                    } else {
                        runCatching { failedSession.close() }
                    }
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
