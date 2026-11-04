package io.tether.qvac.e2e.runner

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** The verdicts and messages other clients give, for the same inputs. */
class ChecksTest {
    @Test
    fun `validation matches the framework helpers`() {
        assertTrue(Validation.validate("The Answer is 42", mapOf("validation" to "contains-all", "contains" to listOf("answer", "42"))).passed)
        assertEquals(
            "Missing required strings: Paris. Got: london",
            Validation.validate("London", mapOf("validation" to "contains-all", "contains" to listOf("Paris"))).output,
        )
        assertTrue(Validation.validate(listOf(1, 2), mapOf("validation" to "type", "expectedType" to "array", "minLength" to 2L)).passed)
        assertEquals("Expected string, got number", Validation.validate(1L, mapOf("validation" to "type", "expectedType" to "string")).output)
        assertTrue(Validation.validate("12", mapOf("validation" to "numeric-range", "min" to 10L, "max" to 20L)).passed)
        // JS Number(): null and false are 0, true is 1; undefined is not a number.
        assertTrue(Validation.validate(null, mapOf("validation" to "numeric-range", "min" to 0L, "max" to 0L)).passed)
        assertTrue(Validation.validate(true, mapOf("validation" to "numeric-range", "min" to 1L, "max" to 1L)).passed)
        assertFalse(Validation.validate(Missing, mapOf("validation" to "numeric-range", "min" to 0L)).passed)
        assertTrue(Validation.validate(null, mapOf("validation" to "function")).incomplete)
    }

    @Test
    fun `named assertions`() {
        val structured = Assertions.named.getValue("errorIsStructured")
        assertTrue(structured(mapOf("code" to "52001", "hasCause" to false), emptyMap()).passed)
        assertFalse(structured(mapOf("code" to "", "hasCause" to false, "message" to "boom"), emptyMap()).passed)

        val fields = Assertions.named.getValue("fieldsPresent")
        // Key presence, not truthiness: an explicit null is present.
        assertTrue(fields(mapOf("a" to null), mapOf("fields" to listOf("a"))).passed)
        assertFalse(fields(mapOf("b" to 1), mapOf("fields" to listOf("a"))).passed)

        // The same `!== undefined` reading for anyFieldPresent.
        val any = Assertions.named.getValue("anyFieldPresent")
        assertTrue(any(mapOf("a" to null), mapOf("fields" to listOf("a"))).passed)
        assertTrue(Assertions.named.getValue("isAbsent")(Missing, emptyMap()).passed)

        val tool = Assertions.named.getValue("toolCallShape")
        val calls = listOf(mapOf("name" to "get_weather", "arguments" to mapOf("city" to "Paris")))
        assertTrue(tool(calls, mapOf("declared" to listOf("get_weather"), "name" to "get_weather", "argKeys" to listOf("city"))).passed)
        assertFalse(tool(emptyList<Any?>(), mapOf("declared" to listOf("get_weather"))).passed)

        val moss = Assertions.named.getValue("mossSoundEffect")
        val pcm = List(48000) { if (it % 2 == 0) 0.1 else -0.1 }
        assertTrue(moss(mapOf("done" to true, "sampleRate" to 48000L, "pcm" to pcm), mapOf("seconds" to 1L)).passed)
        assertEquals("expected empty PCM", Assertions.named.getValue("emptyArray")(listOf(1), emptyMap()).output)
    }

    @Test
    fun `every refusal this client raises carries the SDK's code for it`() {
        // An unknown name binds `code: ""`, which errorIsStructured reads as an unstructured error.
        val names = listOf(
            "CANCEL_FAILED", "COMPLETION_FAILED", "DELETE_CACHE_FAILED", "DOWNLOAD_ASSET_FAILED",
            "INFERENCE_CANCELLED", "INVALID_DELETE_CACHE_PARAMS", "MODEL_LOAD_FAILED", "MODEL_TYPE_REQUIRED",
            "MODEL_UNLOAD_FAILED", "QVAC_MODEL_REGISTRY_QUERY_FAILED", "RAG_DELETE_FAILED", "RAG_SAVE_FAILED",
            "RAG_WORKSPACE_CLOSE_FAILED", "TEXT_TO_SPEECH_STREAM_FAILED", "TRANSCRIPTION_FAILED", "VECTOR_INDEX_FAILED",
        )
        for (name in names) assertTrue(Wire.refusal(name, "x").code != null, name)
    }

    @Test
    fun `comparisons`() {
        val bytes = Assertions.comparisons.getValue("identicalBytes")
        assertTrue(bytes(byteArrayOf(1, 2), listOf(1L, 2L), emptyMap()).passed)
        assertTrue(Assertions.comparisons.getValue("greaterThan")(3.5, 2L, emptyMap()).passed)
        assertEquals("expected 1 > 2", Assertions.comparisons.getValue("greaterThan")(1L, 2L, emptyMap()).output)
        val reuse = Assertions.comparisons.getValue("prefillReuse")
        assertTrue(reuse(30L, 12L, mapOf("primedTokens" to 18L)).passed)
        assertEquals("cold=30, warm=12, primed=17", reuse(30L, 12L, mapOf("primedTokens" to 17L)).output)
        assertFalse(reuse(30L, 12L, mapOf("primedTokens" to null)).passed)
    }

    @Test
    fun `values print the way JavaScript prints them`() {
        assertEquals("2", jsString(2.0))
        assertEquals("2.5", jsString(2.5))
        assertEquals("1,2", jsString(listOf(1L, 2L)))
        assertTrue(jsEquals(mapOf("a" to listOf(1L)), mapOf("a" to listOf(1.0))))
        assertEquals("object", jsType(byteArrayOf()))
        // JSON.stringify writes null for what JSON cannot hold.
        assertEquals("[null,null,1.5]", toJson(listOf(Double.NaN, Float.POSITIVE_INFINITY, 1.5)).toString())
    }

    @Test
    fun `media helpers`() {
        val png = byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 1, 0, 0, 0, 0, 64)
        assertEquals(256 to 64, Media.pngDimensions(png))
        assertEquals(48000 * 2 * 2 * 4, Media.synthesizeTone("2s-440hz").size)
        assertEquals(listOf<Byte>(0, 1, -1), Media.synthesizeBytes("0001ff").toList())
        // JS's Math.round: a half rounds toward +Infinity.
        assertEquals(listOf<Byte>(-1, 127), Media.f32ToS16LeBytes(floatArrayOf(1f)).toList())
    }
}
