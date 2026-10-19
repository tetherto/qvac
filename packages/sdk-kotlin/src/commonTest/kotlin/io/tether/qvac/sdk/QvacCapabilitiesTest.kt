package io.tether.qvac.sdk

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals

class QvacCapabilitiesTest {
    @Test
    fun modelCapabilityBuildsTypedLoadRequest() = runTest {
        val transport = CapabilityRecordingTransport(
            unaryResponse = buildJsonObject {
                put("type", "loadModel")
                put("success", true)
                put("modelId", "qwen")
            },
        )
        val client = QvacClient(transport)

        val modelConfig = buildJsonObject { put("ctx_size", 2048) }
        val result = client.models.load(
            source = "registry://qwen",
            modelType = "llamacpp-completion",
            modelName = "Qwen",
            modelConfig = modelConfig,
        )

        val payload = transport.lastPayload
        assertEquals("loadModel", payload?.get("type")?.jsonPrimitive?.content)
        assertEquals("registry://qwen", payload?.get("modelSrc")?.jsonPrimitive?.content)
        assertEquals("llamacpp-completion", payload?.get("modelType")?.jsonPrimitive?.content)
        assertEquals("Qwen", payload?.get("modelName")?.jsonPrimitive?.content)
        assertEquals(modelConfig, payload?.get("modelConfig"))
        assertEquals("qwen", result.modelId)
    }

    @Test
    fun loadWithProgressRequestsProgressFrames() = runTest {
        val transport = CapabilityRecordingTransport(
            streamResponses = flowOf(
                buildJsonObject {
                    put("type", "modelProgress")
                    put("downloaded", 5)
                    put("total", 10)
                    put("percentage", 50)
                    put("downloadKey", "qwen")
                },
                buildJsonObject {
                    put("type", "loadModel")
                    put("success", true)
                    put("modelId", "qwen")
                },
            ),
        )
        val client = QvacClient(transport)

        val events = client.models.loadWithProgress(
            source = "registry://qwen",
            modelType = "custom-engine",
        ).toList()

        assertEquals("custom-engine", transport.lastPayload?.get("modelType")?.jsonPrimitive?.content)
        assertEquals(true, transport.lastPayload?.get("withProgress")?.jsonPrimitive?.boolean)
        assertEquals(null, transport.lastPayload?.get("modelConfig"))
        assertEquals(2, events.size)
        assertEquals("qwen", (events.last() as QvacProgressEvent.Result).value.modelId)
    }

    @Test
    fun completionTextCapabilityAggregatesOnlyContentDeltas() = runTest {
        val transport = CapabilityRecordingTransport(
            streamResponses = flowOf(
                buildJsonObject {
                    put("type", "completionStream")
                    put(
                        "events",
                        kotlinx.serialization.json.buildJsonArray {
                            add(buildJsonObject { put("type", "contentDelta"); put("seq", 0); put("text", "hel") })
                            // rawDelta and thinkingDelta also carry `text`; they must not leak
                            // into the answer stream.
                            add(buildJsonObject { put("type", "thinkingDelta"); put("seq", 1); put("text", "REASON") })
                            add(buildJsonObject { put("type", "rawDelta"); put("seq", 2); put("text", "RAW") })
                            add(buildJsonObject { put("type", "contentDelta"); put("seq", 3); put("text", "lo") })
                        },
                    )
                },
            ),
        )
        val client = QvacClient(transport)

        val values = client.completion.text(
            io.tether.qvac.sdk.generated.schema.CompletionStreamRequest(
                history = emptyList(),
                modelId = "qwen",
                stream = true,
            ),
        ).toList()

        assertEquals(listOf("hello"), values)
    }

    private class CapabilityRecordingTransport(
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
