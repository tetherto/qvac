package io.tether.qvac.sdk

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class QvacRuntimeProfileTest {
    @Test
    fun decisionsCapabilityIsCheckedBeforeDispatch() = runTest {
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
                    if (operation == "loadModel") put("modelType", "llamacpp-decisions")
                })
            }
            assertEquals(QvacCapability.DECISIONS, error.capability)
            assertFalse(transport.dispatched)
        }
    }

    @Test
    fun decisionsCapabilityFromManifestAllowsDispatch() = runTest {
        val profile = Json.decodeFromString<QvacRuntimeProfile>(
            """{"name":"aio","sdkVersion":"0.21.0","capabilities":["DECISIONS"],"plugins":["@qvac/sdk/llamacpp-decisions/plugin"]}""",
        )
        val transport = ProfileTransport(profile)
        val client = QvacClient(transport)

        for (operation in listOf("decide", "loadModel")) {
            transport.dispatched = false
            client.call(buildJsonObject {
                put("type", operation)
                if (operation == "loadModel") put("modelType", "llamacpp-decisions")
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
