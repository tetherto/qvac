package io.tether.qvac.sdk

import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

class QvacVlaApiTest {
    @Test
    fun runUsesTheSameTypedArrayWireFormatAsJavaScript() = runTest {
        val transport = VlaRecordingTransport(
            buildJsonObject {
                put("type", "pluginInvoke")
                put("result", buildJsonObject {
                    put("actions", "AADAPwAAAMA=")
                    put("actionDim", 1)
                    put("chunkSize", 2)
                })
            },
        )
        val result = QvacClient(transport).vla.run(
            modelId = "robot",
            images = listOf(floatArrayOf(1f)),
            imgWidth = 1,
            imgHeight = 1,
            state = floatArrayOf(2f),
            tokens = intArrayOf(3),
            mask = byteArrayOf(1, 0), // Wire API does not require mask length == token count.
        )

        assertContentEquals(floatArrayOf(1.5f, -2f), result.actions)
        assertEquals("vlaRun", transport.request?.get("handler")?.jsonPrimitive?.content)
        val params = transport.request?.get("params")?.jsonObject
        assertEquals("AACAPw==", params?.get("images")?.jsonArray?.single()?.jsonPrimitive?.content)
        assertEquals("AAAAQA==", params?.get("state")?.jsonPrimitive?.content)
        assertEquals("AwAAAA==", params?.get("tokens")?.jsonPrimitive?.content)
        assertEquals("AQA=", params?.get("mask")?.jsonPrimitive?.content)
    }

    @Test
    fun hparamsAndEmbodimentAreTyped() = runTest {
        val transport = VlaRecordingTransport(
            buildJsonObject {
                put("type", "pluginInvoke")
                put("result", buildJsonObject {
                    put("backendName", "Vulkan")
                    put("hparams", hparams())
                })
            },
        )
        val result = QvacClient(transport).vla.hparams("robot")

        assertEquals("Vulkan", result.backendName)
        assertEquals(2, result.hparams.numCameras)
        assertEquals(512, result.hparams.visionImageSize)
        assertEquals("vlaHparams", transport.request?.get("handler")?.jsonPrimitive?.content)
        assertFailsWith<IllegalArgumentException> { QvacVlaEmbodiment.CategoryId(32).toJson() }
    }

    @Test
    fun preprocessingAndPaddingMatchTheJavaScriptHelpers() {
        val image = qvacVlaPreprocessImage(
            pixels = floatArrayOf(0f, 127.5f, 255f),
            width = 1,
            height = 1,
            size = 1,
        )
        assertContentEquals(floatArrayOf(-1f, 0f, 1f), image)
        assertContentEquals(floatArrayOf(1f, 2f, 0f, 0f), qvacVlaPadState(floatArrayOf(1f, 2f), 4))
    }

    private fun hparams() = buildJsonObject {
        put("chunkSize", 4)
        put("actionDim", 7)
        put("maxActionDim", 32)
        put("maxStateDim", 32)
        put("tokenizerMaxLength", 48)
        put("visionImageSize", 512)
        put("numCameras", 2)
    }
}

private class VlaRecordingTransport(private val response: JsonObject) : QvacTransport {
    var request: JsonObject? = null

    override suspend fun call(payload: JsonObject): JsonObject {
        request = payload
        return response
    }

    override fun stream(payload: JsonObject): Flow<JsonObject> = emptyFlow()

    override fun duplex(payload: JsonObject, input: Flow<ByteArray>): Flow<JsonObject> = emptyFlow()

    override suspend fun close() = Unit
}
