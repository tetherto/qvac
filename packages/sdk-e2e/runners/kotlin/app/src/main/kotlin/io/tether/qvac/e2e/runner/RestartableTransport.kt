package io.tether.qvac.e2e.runner

import io.tether.qvac.sdk.QvacRuntimeProfile
import io.tether.qvac.sdk.QvacTransport
import kotlinx.coroutines.flow.Flow
import kotlinx.serialization.json.JsonObject

/** A worker transport that [restart] replaces with a new worker, so the client holding it stays usable. */
class RestartableTransport private constructor(
    private var current: QvacTransport,
    private val connect: suspend () -> QvacTransport,
) : QvacTransport {
    override val runtimeProfile: QvacRuntimeProfile? get() = current.runtimeProfile

    override suspend fun call(payload: JsonObject): JsonObject = current.call(payload)

    override fun stream(payload: JsonObject): Flow<JsonObject> = current.stream(payload)

    override fun duplex(payload: JsonObject, input: Flow<ByteArray>): Flow<JsonObject> = current.duplex(payload, input)

    override suspend fun close() = current.close()

    /** Stops the worker with the models it holds and starts a new one. */
    suspend fun restart() {
        current.close()
        current = connect()
    }

    companion object {
        suspend fun connect(connect: suspend () -> QvacTransport) = RestartableTransport(connect(), connect)
    }
}
