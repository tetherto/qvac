package io.tether.qvac.sdk

import io.tether.qvac.sdk.generated.schema.*
import kotlinx.serialization.json.*
import kotlinx.serialization.SerializationException
import kotlin.test.*

class SchemaTypesTest {
    private val json = Json { ignoreUnknownKeys = true; explicitNulls = false }

    @Test
    fun orderedHistoryPartsRoundTripWithoutUnionWrapperFields() {
        val input = Json.parseToJsonElement("""{"role":"user","content":[{"type":"text","text":"First:"},{"type":"media","path":"/a.jpg"},{"type":"text","text":"Second:"},{"type":"media","path":"/b.jpg"}]}""")
        val stream = json.decodeFromJsonElement<CompletionStreamRequestHistoryItem>(input)
        assertIs<CompletionStreamRequestHistoryItemContent.Variant2>(stream.content)
        assertEquals(input, json.encodeToJsonElement<CompletionStreamRequestHistoryItem>(stream))
        val batch = json.decodeFromJsonElement<BatchCompletionStreamRequestPromptsItemHistoryItem>(input)
        assertIs<BatchCompletionStreamRequestPromptsItemHistoryItemContent.Variant2>(batch.content)
        assertEquals(input, json.encodeToJsonElement<BatchCompletionStreamRequestPromptsItemHistoryItem>(batch))
    }

    @Test
    fun legacyHistoryTextRoundTripsAndMalformedPartsReject() {
        val input = Json.parseToJsonElement("""{"role":"user","content":"Hello"}""")
        val stream = json.decodeFromJsonElement<CompletionStreamRequestHistoryItem>(input)
        assertIs<CompletionStreamRequestHistoryItemContent.Variant1>(stream.content)
        assertEquals(input, json.encodeToJsonElement<CompletionStreamRequestHistoryItem>(stream))
        val batch = json.decodeFromJsonElement<BatchCompletionStreamRequestPromptsItemHistoryItem>(input)
        assertEquals(input, json.encodeToJsonElement<BatchCompletionStreamRequestPromptsItemHistoryItem>(batch))
        for (content in listOf("""[{"type":"media"}]""", """[{"type":"image","path":"/a.jpg"}]""")) {
            val malformed = Json.parseToJsonElement("""{"role":"user","content":$content}""")
            assertFailsWith<SerializationException> { json.decodeFromJsonElement<CompletionStreamRequestHistoryItem>(malformed) }
            assertFailsWith<SerializationException> { json.decodeFromJsonElement<BatchCompletionStreamRequestPromptsItemHistoryItem>(malformed) }
        }
    }

    @Test
    fun numericConstantArmsRoundTripAcrossIntegerAndDecimalJsonSpelling() {
        val value = json.decodeFromString<LoadModelSrcRequestLlamacppCompletionModelConfigPredict>("-1")
        val encoded = json.encodeToString(LoadModelSrcRequestLlamacppCompletionModelConfigPredict.serializer(), value)
        assertEquals(value, json.decodeFromString<LoadModelSrcRequestLlamacppCompletionModelConfigPredict>(encoded))
    }

    @Test
    fun constructingTypedNestedConfigurationEmitsDiscriminatorsWithDefaultJsonSettings() {
        val request = LoadModelRequest.LoadModelSrcRequest(LoadModelSrcRequest.LlamacppCompletion(
            LoadModelSrcRequestLlamacppCompletion(modelSrc = "registry:model",
                modelConfig = LoadModelSrcRequestLlamacppCompletionModelConfig(ctx_size = 2048.0, gpu_layers = 0.0))))
        val encoded = Json.encodeToJsonElement<LoadModelRequest>(request).jsonObject
        assertEquals("loadModel", encoded.getValue("type").jsonPrimitive.content)
        assertEquals("llamacpp-completion", encoded.getValue("modelType").jsonPrimitive.content)
        assertFalse("value" in encoded)
    }

    @Test
    fun discriminatedCancelUnionRoundTripsWithoutWrapperFields() {
        val input = Json.parseToJsonElement("""{"type":"cancel","operation":"request","requestId":"test"}""")
        val value = json.decodeFromJsonElement<CancelRequest>(input)
        assertIs<CancelRequest.Request>(value)
        val encoded = json.encodeToJsonElement<CancelRequest>(value).jsonObject
        assertEquals("request", encoded["operation"]?.jsonPrimitive?.content)
        assertEquals("cancel", encoded["type"]?.jsonPrimitive?.content)
        assertFalse("value" in encoded)
    }

    @Test
    fun nestedModelConfigurationIsTypedAndPreservesWireNames() {
        val input = Json.parseToJsonElement("""{"type":"loadModel","modelSrc":"registry:model","modelType":"llamacpp-completion","modelConfig":{"ctx_size":2048,"gpu_layers":99}}""")
        val value = json.decodeFromJsonElement<LoadModelRequest>(input)
        val encoded = json.encodeToJsonElement<LoadModelRequest>(value).jsonObject
        assertEquals(2048.0, encoded.getValue("modelConfig").jsonObject.getValue("ctx_size").jsonPrimitive.double)
        assertEquals("llamacpp-completion", encoded.getValue("modelType").jsonPrimitive.content)
    }

    @Test
    fun unknownDiscriminatorFails() {
        assertFailsWith<SerializationException> {
            json.decodeFromString<CancelRequest>("""{"type":"cancel","operation":"not-a-real-operation"}""")
        }
    }

    @Test
    fun optionalConstFieldDecodesAsAbsentWhenOmitted() {
        val done = json.decodeFromString<CompletionOrchestrateResponse>("""{"type":"completionOrchestrate","done":true}""")
        assertNull(done.stopReason)
        val limited = json.decodeFromString<CompletionOrchestrateResponse>(
            """{"type":"completionOrchestrate","done":true,"stopReason":"maxToolTurns"}""",
        )
        assertEquals("maxToolTurns", limited.stopReason)
    }

    @Test
    fun fieldPresenceUnionRoundTrips() {
        val value = json.decodeFromString<DeleteCacheRequest>("""{"type":"deleteCache","all":true}""")
        assertEquals(true, json.encodeToJsonElement<DeleteCacheRequest>(value).jsonObject.getValue("all").jsonPrimitive.boolean)
    }
}
