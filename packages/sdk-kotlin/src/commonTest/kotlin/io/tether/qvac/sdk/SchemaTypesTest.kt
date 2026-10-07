package io.tether.qvac.sdk

import io.tether.qvac.sdk.generated.schema.*
import kotlinx.serialization.json.*
import kotlinx.serialization.SerializationException
import kotlin.test.*

class SchemaTypesTest {
    private val json = Json { ignoreUnknownKeys = true; explicitNulls = false }

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
    fun fieldPresenceUnionRoundTrips() {
        val value = json.decodeFromString<DeleteCacheRequest>("""{"type":"deleteCache","all":true}""")
        assertEquals(true, json.encodeToJsonElement<DeleteCacheRequest>(value).jsonObject.getValue("all").jsonPrimitive.boolean)
    }
}
