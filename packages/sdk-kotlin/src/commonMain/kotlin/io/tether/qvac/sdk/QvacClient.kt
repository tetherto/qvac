package io.tether.qvac.sdk

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

@Serializable
data class HeartbeatResponse(
    val type: String,
    val number: Double,
)

class QvacClient(
    private val transport: QvacTransport,
    private val json: Json = Json {
        ignoreUnknownKeys = true
        explicitNulls = true
    },
) {
    internal val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    val runtimeProfile: QvacRuntimeProfile? get() = transport.runtimeProfile

    suspend fun heartbeat(): HeartbeatResponse {
        val response = call(buildJsonObject { put("type", "heartbeat") })
        return json.decodeFromJsonElement(response)
    }

    suspend fun call(payload: JsonObject): JsonObject {
        transport.runtimeProfile?.requirePayload(payload)
        return checkResponse(transport.call(payload))
    }

    fun stream(payload: JsonObject): Flow<JsonObject> {
        transport.runtimeProfile?.requirePayload(payload)
        return transport.stream(payload).map(::checkResponse)
    }

    fun duplex(payload: JsonObject, input: Flow<ByteArray>): Flow<JsonObject> {
        transport.runtimeProfile?.requirePayload(payload)
        return transport.duplex(payload, input).map(::checkResponse)
    }

    internal suspend inline fun <reified Request : Any, reified Response : Any> callTyped(
        request: Request,
    ): Response {
        val payload = json.encodeToJsonElement(request).jsonObject
        transport.runtimeProfile?.requirePayload(payload)
        return json.decodeFromJsonElement(checkResponse(transport.call(payload)))
    }

    internal inline fun <reified Request : Any, reified Response : Any> streamTyped(
        request: Request,
    ): Flow<Response> {
        val payload = json.encodeToJsonElement(request).jsonObject
        transport.runtimeProfile?.requirePayload(payload)
        return transport.stream(payload).map { response ->
            json.decodeFromJsonElement(checkResponse(response))
        }
    }

    internal inline fun <reified Request : Any, reified Response : Any> duplexTyped(
        request: Request,
        input: Flow<ByteArray>,
    ): Flow<Response> {
        val payload = json.encodeToJsonElement(request).jsonObject
        transport.runtimeProfile?.requirePayload(payload)
        return transport.duplex(payload, input).map { response ->
            json.decodeFromJsonElement(checkResponse(response))
        }
    }

    internal inline fun <
        reified Request : Any,
        reified Progress : Any,
        reified Response : Any,
        > progressTyped(
        request: Request,
        progressType: String,
    ): Flow<QvacProgressEvent<Progress, Response>> {
        val payload = json.encodeToJsonElement(request).jsonObject
        transport.runtimeProfile?.requirePayload(payload)
        return transport.stream(payload).map { response ->
            val checked = checkResponse(response)
            if (checked["type"]?.jsonPrimitive?.content == progressType) {
                QvacProgressEvent.Progress(json.decodeFromJsonElement<Progress>(checked))
            } else {
                QvacProgressEvent.Result(json.decodeFromJsonElement<Response>(checked))
            }
        }
    }

    suspend fun close() {
        try {
            transport.close()
        } finally {
            scope.cancel()
        }
    }

    private fun checkResponse(response: JsonObject): JsonObject {
        if (response["type"]?.jsonPrimitive?.content == "error") {
            throw QvacException.from(response)
        }
        return response
    }
}
