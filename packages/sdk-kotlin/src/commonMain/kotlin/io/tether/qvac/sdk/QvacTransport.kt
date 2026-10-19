package io.tether.qvac.sdk

import kotlinx.coroutines.flow.Flow
import kotlinx.serialization.json.JsonObject

interface QvacTransport {
    /** Null means capability discovery is unavailable and calls are forwarded unchanged. */
    val runtimeProfile: QvacRuntimeProfile?
        get() = null

    suspend fun call(payload: JsonObject): JsonObject

    fun stream(payload: JsonObject): Flow<JsonObject>

    fun duplex(payload: JsonObject, input: Flow<ByteArray>): Flow<JsonObject>

    suspend fun close()
}
