package io.tether.qvac.sdk

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class QvacRuntimeProfileTest {
    @Test
    fun embeddingMethodsRequireTheCapabilityTheirInputsNeed() = runTest {
        val text = buildJsonObject { put("input", "query") }
        val image = buildJsonObject { put("input", buildJsonObject { put("image", "AQID") }) }
        val media = buildJsonObject {
            put("inputs", buildJsonArray {
                add(buildJsonArray {
                    add(buildJsonObject {
                        put("media", buildJsonObject {
                            put("type", "base64")
                            put("value", "AQID")
                        })
                    })
                })
            })
        }
        val cases = mapOf(
            QvacCapability.EMBEDDINGS to mapOf(text to true, image to false, media to true),
            QvacCapability.IMAGE_EMBEDDINGS to mapOf(text to false, image to true, media to true),
            QvacCapability.LLM to mapOf(text to false, image to false, media to false),
        )
        for ((capability, payloads) in cases) {
            val transport = ProfileTransport(QvacRuntimeProfile("profile", "0.23.0", setOf(capability)))
            val client = QvacClient(transport)
            for ((fields, allowed) in payloads) {
                for (operation in listOf("embed", "embedBatch")) {
                    transport.dispatched = false
                    val payload = JsonObject(fields + ("type" to JsonPrimitive(operation)))
                    if (allowed) {
                        client.call(payload)
                    } else {
                        assertFailsWith<UnsupportedCapabilityException> { client.call(payload) }
                    }
                    assertEquals(allowed, transport.dispatched, "$capability $operation $fields")
                }
            }
        }
    }

    @Test
    fun decisionCapabilityIsCheckedBeforeDispatch() = runTest {
        val transport = ProfileTransport(
            QvacRuntimeProfile(
                name = "llm",
                sdkVersion = "0.21.0",
                capabilities = setOf(QvacCapability.LLM, QvacCapability.EMBEDDINGS),
            ),
        )
        val client = QvacClient(transport)

        for (operation in listOf("decide", "loadModel")) {
            val error = assertFailsWith<UnsupportedCapabilityException> {
                client.call(buildJsonObject {
                    put("type", operation)
                    if (operation == "loadModel") put("modelType", "llamacpp-decision")
                })
            }
            assertEquals(QvacCapability.DECISION, error.capability)
            assertFalse(transport.dispatched)
        }
    }

    @Test
    fun decisionCapabilityFromManifestAllowsDispatch() = runTest {
        val profile = Json.decodeFromString<QvacRuntimeProfile>(
            """{"name":"aio","sdkVersion":"0.21.0","capabilities":["DECISION"],"plugins":["@qvac/sdk/llamacpp-decision/plugin"]}""",
        )
        val transport = ProfileTransport(profile)
        val client = QvacClient(transport)

        for (operation in listOf("decide", "loadModel")) {
            transport.dispatched = false
            client.call(buildJsonObject {
                put("type", operation)
                if (operation == "loadModel") put("modelType", "llamacpp-decision")
            })
            assertTrue(transport.dispatched)
        }
    }

    @Test
    fun rerankCapabilityIsCheckedBeforeDispatch() = runTest {
        val transport = ProfileTransport(
            QvacRuntimeProfile(
                name = "llm",
                sdkVersion = "0.21.0",
                capabilities = setOf(QvacCapability.LLM, QvacCapability.EMBEDDINGS),
            ),
        )
        val client = QvacClient(transport)

        for (operation in listOf("rerank", "loadModel")) {
            val error = assertFailsWith<UnsupportedCapabilityException> {
                client.call(buildJsonObject {
                    put("type", operation)
                    if (operation == "loadModel") put("modelType", "llamacpp-rerank")
                })
            }
            assertEquals(QvacCapability.RERANK, error.capability)
            assertFalse(transport.dispatched)
        }
    }

    @Test
    fun rerankCapabilityFromManifestAllowsDispatch() = runTest {
        val profile = Json.decodeFromString<QvacRuntimeProfile>(
            """{"name":"aio","sdkVersion":"0.21.0","capabilities":["RERANK"],"plugins":["@qvac/sdk/llamacpp-rerank/plugin"]}""",
        )
        val transport = ProfileTransport(profile)
        val client = QvacClient(transport)

        for (operation in listOf("rerank", "loadModel")) {
            transport.dispatched = false
            client.call(buildJsonObject {
                put("type", operation)
                if (operation == "loadModel") put("modelType", "llamacpp-rerank")
            })
            assertTrue(transport.dispatched)
        }
    }

    @Test
    fun omittedCapabilityFailsBeforeDispatch() = runTest {
        val transport = ProfileTransport(
            QvacRuntimeProfile(
                name = "assistant",
                sdkVersion = "0.20.1",
                capabilities = setOf(QvacCapability.LLM, QvacCapability.TRANSCRIPTION),
            ),
        )
        val client = QvacClient(transport)

        assertFailsWith<UnsupportedCapabilityException> {
            client.call(buildJsonObject { put("type", "textToSpeech") })
        }
        kotlin.test.assertFalse(transport.dispatched)
    }

    @Test
    fun vlaPluginHandlerIsCheckedBeforeDispatch() = runTest {
        val transport = ProfileTransport(
            QvacRuntimeProfile(
                name = "llm",
                sdkVersion = "0.20.1",
                capabilities = setOf(QvacCapability.LLM),
            ),
        )
        val client = QvacClient(transport)

        assertFailsWith<UnsupportedCapabilityException> {
            client.vla.hparams("robot")
        }
        kotlin.test.assertFalse(transport.dispatched)
    }

    private class ProfileTransport(
        override val runtimeProfile: QvacRuntimeProfile,
    ) : QvacTransport {
        var dispatched = false
        override suspend fun call(payload: JsonObject): JsonObject {
            dispatched = true
            return JsonObject(emptyMap())
        }
        override fun stream(payload: JsonObject): Flow<JsonObject> {
            dispatched = true
            return emptyFlow()
        }
        override fun duplex(payload: JsonObject, input: Flow<ByteArray>): Flow<JsonObject> {
            dispatched = true
            return emptyFlow()
        }
        override suspend fun close() = Unit
    }
}
