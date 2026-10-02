package io.tether.qvac.sdk

import io.tether.qvac.sdk.generated.HeartbeatRequest
import io.tether.qvac.sdk.generated.LoadModelRequest
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs

class TypedMethodsTest {
    @Test
    fun unaryMethodSerializesRequestAndResponse() = runTest {
        val transport = TypedRecordingTransport(
            unaryResponse = buildJsonObject {
                put("type", "heartbeat")
                put("number", 7)
            },
        )
        val client = QvacClient(transport)

        val response = client.heartbeat(HeartbeatRequest(type = "heartbeat"))

        assertEquals("heartbeat", transport.lastPayload?.get("type")?.toString()?.trim('"'))
        assertEquals(7.0, response.number)
    }

    @Test
    fun progressMethodDecodesProgressAndFinalFrames() = runTest {
        val transport = TypedRecordingTransport(
            streamResponses = flowOf(
                buildJsonObject {
                    put("type", "modelProgress")
                    put("downloadKey", "download")
                    put("downloaded", 50)
                    put("percentage", 50)
                    put("total", 100)
                },
                buildJsonObject {
                    put("type", "loadModel")
                    put("success", true)
                    put("modelId", "model")
                },
            ),
        )
        val client = QvacClient(transport)

        val events = client.loadModelWithProgress(LoadModelRequest(type = "loadModel")).toList()

        assertIs<QvacProgressEvent.Progress<*>>(events[0])
        assertIs<QvacProgressEvent.Result<*>>(events[1])
        assertEquals("loadModel", transport.lastPayload?.get("type")?.toString()?.trim('"'))
    }

    private class TypedRecordingTransport(
        private val unaryResponse: JsonObject = JsonObject(emptyMap()),
        private val streamResponses: Flow<JsonObject> = flowOf(),
    ) : QvacTransport {
        var lastPayload: JsonObject? = null

        override suspend fun call(payload: JsonObject): JsonObject {
            lastPayload = payload
            return unaryResponse
        }

        override fun stream(payload: JsonObject): Flow<JsonObject> {
            lastPayload = payload
            return streamResponses
        }

        override fun duplex(payload: JsonObject, input: Flow<ByteArray>): Flow<JsonObject> {
            lastPayload = payload
            return streamResponses
        }

        override suspend fun close() = Unit
    }
}
