package io.tether.qvac.sdk.sample

import io.tether.qvac.sdk.QvacClient
import io.tether.qvac.sdk.QvacTransport
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class QwenDemoTest {
    @Test
    fun downloadUsesQwenModelAndReportsProgress() = runTest {
        val transport = ScriptedTransport(
            flowOf(
                buildJsonObject {
                    put("type", "modelProgress")
                    put("downloaded", 191_078_240)
                    put("total", 382_156_480)
                    put("percentage", 50)
                    put("downloadKey", "qwen")
                },
                buildJsonObject {
                    put("type", "downloadAsset")
                    put("success", true)
                    put("assetId", QwenModel.SOURCE)
                },
            ),
        )
        val progress = mutableListOf<ModelProgress>()

        QwenDemo(QvacClient(transport)).downloadModel(progress::add)

        assertEquals(QwenModel.SOURCE, transport.requests.single()["assetSrc"]?.jsonPrimitive?.content)
        assertTrue(transport.requests.single()["withProgress"]?.jsonPrimitive?.content == "true")
        assertEquals(50, progress.single().percentage)
    }

    @Test
    fun loadReturnsWorkerModelId() = runTest {
        val transport = ScriptedTransport(
            flowOf(
                buildJsonObject {
                    put("type", "loadModel")
                    put("success", true)
                    put("modelId", "loaded-qwen")
                },
            ),
        )

        val modelId = QwenDemo(QvacClient(transport)).loadModel {}

        assertEquals("loaded-qwen", modelId)
        val request = transport.requests.single()
        assertEquals("llamacpp-completion", request["modelType"]?.jsonPrimitive?.content)
        assertEquals(QwenModel.NAME, request["modelName"]?.jsonPrimitive?.content)
        assertEquals("-1", request["modelConfig"]?.jsonObject?.get("reasoning_budget")?.jsonPrimitive?.content)
    }

    @Test
    fun completionAggregatesStreamedContent() = runTest {
        val transport = ScriptedTransport(
            flowOf(
                buildJsonObject {
                    put("type", "completionStream")
                    put(
                        "events",
                        buildJsonArray {
                            add(buildJsonObject {
                                put("type", "thinkingDelta")
                                put("seq", -1)
                                put("text", "Private reasoning must not become the answer")
                            })
                            add(
                                buildJsonObject {
                                    put("type", "contentDelta")
                                    put("seq", 0)
                                    put("text", "Hello ")
                                },
                            )
                            add(
                                buildJsonObject {
                                    put("type", "contentDelta")
                                    put("seq", 1)
                                    put("text", "Android")
                                },
                            )
                            add(
                                buildJsonObject {
                                    put("type", "completionStats")
                                    put("seq", 2)
                                    put(
                                        "stats",
                                        buildJsonObject {
                                            put("tokensPerSecond", 12.5)
                                        },
                                    )
                                },
                            )
                            add(
                                buildJsonObject {
                                    put("type", "completionDone")
                                    put("seq", 3)
                                    put("stopReason", "eos")
                                },
                            )
                        },
                    )
                },
            ),
        )
        val deltas = mutableListOf<String>()

        val result = QwenDemo(QvacClient(transport)).complete(
            modelId = "loaded-qwen",
            prompt = "Say hello",
            onContent = deltas::add,
        )

        assertEquals(listOf("Hello ", "Android"), deltas)
        assertEquals("Hello Android", result.text)
        assertEquals("true", transport.requests.single()["captureThinking"]?.jsonPrimitive?.content)
        assertEquals(12.5, result.tokensPerSecond)
        assertEquals("eos", result.stopReason)
        assertEquals("-1", transport.requests.single()["generationParams"]?.jsonObject
            ?.get("reasoning_budget")?.jsonPrimitive?.content)
        assertEquals(
            "-1",
            transport.requests.single()["generationParams"]
                ?.jsonObject
                ?.get("predict")
                ?.jsonPrimitive
                ?.content,
        )
    }
}

private class ScriptedTransport(
    private val responses: Flow<JsonObject>,
) : QvacTransport {
    val requests = mutableListOf<JsonObject>()

    override suspend fun call(payload: JsonObject): JsonObject {
        error("Unexpected unary request: $payload")
    }

    override fun stream(payload: JsonObject): Flow<JsonObject> {
        requests += payload
        return responses
    }

    override fun duplex(payload: JsonObject, input: Flow<ByteArray>): Flow<JsonObject> {
        error("Unexpected duplex request: $payload")
    }

    override suspend fun close() = Unit
}
