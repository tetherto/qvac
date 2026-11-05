package io.tether.qvac.sdk

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class QvacClientTest {
    @Test
    fun heartbeatUsesTheWorkerContract() = runTest {
        val transport = RecordingTransport(
            response = buildJsonObject {
                put("type", "heartbeat")
                put("number", 42)
            },
        )
        val client = QvacClient(transport)

        val response = client.heartbeat()

        assertEquals("heartbeat", transport.lastRequest?.get("type")?.jsonPrimitive?.content)
        assertEquals(42.0, response.number)
    }

    @Test
    fun callReconstructsWorkerErrors() = runTest {
        val transport = RecordingTransport(
            response = buildJsonObject {
                put("type", "error")
                put("name", "MODEL_NOT_FOUND")
                put("code", 52002)
                put("message", "Model was not found")
            },
        )
        val client = QvacClient(transport)

        val error = assertFailsWith<QvacException> {
            client.call(buildJsonObject { put("type", "getModelInfo") })
        }

        assertEquals("MODEL_NOT_FOUND", error.errorName)
        assertEquals(52002, error.code)
        assertEquals(52002, error.knownCode)
    }

    @Test
    fun streamChecksEveryErrorEnvelope() = runTest {
        val transport = RecordingTransport(
            response = JsonObject(emptyMap()),
            stream = flowOf(
                buildJsonObject {
                    put("type", "error")
                    put("name", "STREAM_FAILED")
                    put("code", 50001)
                    put("message", "Stream failed")
                },
            ),
        )
        val client = QvacClient(transport)

        assertFailsWith<QvacException> {
            client.stream(buildJsonObject { put("type", "completionStream") }).collect {}
        }
    }
}

private class RecordingTransport(
    private val response: JsonObject,
    private val stream: Flow<JsonObject> = emptyFlow(),
) : QvacTransport {
    var lastRequest: JsonObject? = null

    override suspend fun call(payload: JsonObject): JsonObject {
        lastRequest = payload
        return response
    }

    override fun stream(payload: JsonObject): Flow<JsonObject> {
        lastRequest = payload
        return stream
    }

    override fun duplex(payload: JsonObject, input: Flow<ByteArray>): Flow<JsonObject> {
        lastRequest = payload
        return stream
    }

    override suspend fun close() = Unit
}
