package io.tether.qvac.sdk

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
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

        val result = client.models.load(
            source = "registry://qwen",
            modelType = "llamacpp-completion",
        )

        assertEquals("loadModel", transport.lastPayload?.get("type")?.toString()?.trim('"'))
        assertEquals("registry://qwen", transport.lastPayload?.get("modelSrc")?.toString()?.trim('"'))
        assertEquals("qwen", result.modelId)
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
                            add(buildJsonObject { put("type", "contentDelta"); put("text", "hel") })
                            // rawDelta and thinkingDelta also carry `text`; they must not leak
                            // into the answer stream.
                            add(buildJsonObject { put("type", "thinkingDelta"); put("text", "REASON") })
                            add(buildJsonObject { put("type", "rawDelta"); put("text", "RAW") })
                            add(buildJsonObject { put("type", "contentDelta"); put("text", "lo") })
                        },
                    )
                },
            ),
        )
        val client = QvacClient(transport)

        val values = client.completion.text(
            io.tether.qvac.sdk.generated.CompletionStreamRequest(
                history = emptyList(),
                modelId = "qwen",
                stream = true,
                type = "completionStream",
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
