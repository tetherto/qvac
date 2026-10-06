package io.tether.qvac.sdk

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class QvacFeatureApisTest {
    @Test
    fun transcriptionAndOcrReturnAggregatedTypedResults() = runTest {
        val transport = FeatureTransport()
        val client = QvacClient(transport)

        // Default metadata=false: the worker streams text frames, no segments.
        transport.responses = flowOf(buildJsonObject {
            put("type", "transcribe")
            put("text", "hello")
            put("done", true)
        })
        val transcript = client.speech.transcribe("asr", QvacDataInput.FilePath("/audio.wav"))
        assertEquals("hello", transcript.text)
        assertEquals(false, transport.lastPayload?.get("metadata")?.jsonPrimitive?.content?.toBoolean())
        assertEquals("filePath", transport.lastPayload?.get("audioChunk")?.jsonObject
            ?.get("type")?.jsonPrimitive?.content)

        // metadata=true: the worker streams segment frames, no top-level text.
        transport.responses = flowOf(buildJsonObject {
            put("type", "transcribe")
            put("segment", buildJsonObject {
                put("text", "hello")
                put("startMs", 0)
                put("endMs", 500)
                put("append", false)
                put("id", 0)
            })
            put("done", true)
        })
        val segmented = client.speech.transcribe("asr", QvacDataInput.FilePath("/audio.wav"), metadata = true)
        assertEquals("", segmented.text)
        assertEquals(500.0, segmented.segments.single().endMs)

        transport.responses = flowOf(buildJsonObject {
            put("type", "ocrStream")
            put("blocks", buildJsonArray {
                add(buildJsonObject {
                    put("text", "QVAC")
                    put("confidence", 0.99)
                })
            })
            put("done", true)
        })
        val ocr = client.vision.ocr("ocr", QvacDataInput.FilePath("/image.png"))
        assertEquals("QVAC", ocr.text)
        assertEquals(0.99, ocr.blocks.single().confidence)

        transport.responses = flowOf(buildJsonObject {
            put("type", "bciTranscribe")
            put("text", "neural text")
            put("done", true)
        })
        val bci = client.bci.transcribe("bci", QvacDataInput.Base64("AQID"), metadata = false)
        assertEquals("neural text", bci.text)
        assertEquals("base64", transport.lastPayload?.get("neuralData")?.jsonObject
            ?.get("type")?.jsonPrimitive?.content)
        client.close()
    }

    @Test
    fun translationPicksTheContractArmFromModelType() = runTest {
        val transport = FeatureTransport()
        val client = QvacClient(transport)
        transport.responses = flowOf(buildJsonObject {
            put("type", "translate")
            put("token", "hola")
            put("done", true)
        })
        try {
            assertEquals("hola", client.translation.run("llm", "hello", "llamacpp-completion", to = "es").text())
            assertEquals("es", transport.lastPayload?.get("to")?.jsonPrimitive?.content)
            assertEquals("hola", client.translation.run("nmt", "hello", "nmtcpp-translation").text())
            assertEquals(null, transport.lastPayload?.get("to"))
            assertEquals("nmtcpp-translation", transport.lastPayload?.get("modelType")?.jsonPrimitive?.content)
            assertFailsWith<IllegalArgumentException> {
                client.translation.run("nmt", "hello", "nmtcpp-translation", to = "es")
            }
            assertFailsWith<IllegalArgumentException> { client.translation.run("llm", "hello", "llamacpp-completion") }
            assertFailsWith<IllegalArgumentException> { client.translation.run("x", "hello", "unknown-engine", to = "es") }
        } finally {
            client.close()
        }
    }

    @Test
    fun voiceOptionsMapOntoContractEnums() = runTest {
        val transport = FeatureTransport()
        val client = QvacClient(transport)
        transport.responses = flowOf(buildJsonObject {
            put("type", "textToSpeech")
            put("buffer", buildJsonArray { add(JsonPrimitive(0.5)) })
            put("done", true)
        })
        try {
            val result = client.speech.synthesize("tts", "hi", QvacVoiceOptions(emotion = "proper noun", pace = "slow"))
            assertEquals(listOf(0.5), result.samples)
            assertEquals("proper noun", transport.lastPayload?.get("emotion")?.jsonPrimitive?.content)
            assertEquals("slow", transport.lastPayload?.get("pace")?.jsonPrimitive?.content)
            assertFailsWith<IllegalArgumentException> {
                client.speech.synthesize("tts", "hi", QvacVoiceOptions(pace = "warp"))
            }
        } finally {
            client.close()
        }
    }

    private class FeatureTransport : QvacTransport {
        var responses: Flow<JsonObject> = flowOf()
        var lastPayload: JsonObject? = null
        override suspend fun call(payload: JsonObject): JsonObject = JsonObject(emptyMap())
        override fun stream(payload: JsonObject): Flow<JsonObject> {
            lastPayload = payload
            return responses
        }
        override fun duplex(payload: JsonObject, input: Flow<ByteArray>) = responses
        override suspend fun close() = Unit
    }
}
