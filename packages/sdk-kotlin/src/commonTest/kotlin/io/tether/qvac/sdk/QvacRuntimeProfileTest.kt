package io.tether.qvac.sdk

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertFailsWith

class QvacRuntimeProfileTest {
    @Test
    fun omittedCapabilityFailsBeforeDispatch() = runTest {
        val transport = ProfileTransport(
            QvacRuntimeProfile(
                name = "assistant",
                sdkVersion = "0.19.1",
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
                sdkVersion = "0.19.1",
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
