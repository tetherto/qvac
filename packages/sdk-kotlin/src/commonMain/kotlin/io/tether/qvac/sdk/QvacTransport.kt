package io.tether.qvac.sdk

import kotlinx.coroutines.Deferred
import kotlinx.coroutines.flow.Flow
import kotlinx.serialization.json.JsonObject

interface QvacTransport {
    /** Null means capability discovery is unavailable and calls are forwarded unchanged. */
    val runtimeProfile: QvacRuntimeProfile?
        get() = null

    /**
     * Completes once the worker connection has ended, by worker exit or crash or
     * by [close]. Null when the transport cannot tell; sessions on such a
     * transport end only with the owner's [QvacClient.close].
     */
    val lost: Deferred<Unit>?
        get() = null

    suspend fun call(payload: JsonObject): JsonObject

    fun stream(payload: JsonObject): Flow<JsonObject>

    fun duplex(payload: JsonObject, input: Flow<ByteArray>): Flow<JsonObject>

    suspend fun close()
}
