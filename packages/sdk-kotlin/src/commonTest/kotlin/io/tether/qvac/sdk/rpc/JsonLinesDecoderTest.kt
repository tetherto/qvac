package io.tether.qvac.sdk.rpc

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class JsonLinesDecoderTest {
    @Test
    fun limitsApplyPerLineIncludingSplitUnterminatedLines() {
        val decoder = JsonLinesDecoder(4)
        assertEquals(listOf("1234", "1234"), decoder.feed("1234\n1234\n".encodeToByteArray()))
        decoder.feed("123".encodeToByteArray())
        assertFailsWith<BareRpcLimitException> { decoder.feed("45".encodeToByteArray()) }
    }
    @Test
    fun decodesLinesSplitAcrossChunks() {
        val decoder = JsonLinesDecoder()

        assertEquals(emptyList(), decoder.feed("{\"one\":".encodeToByteArray()))
        assertEquals(
            listOf("{\"one\":1}", "{\"two\":2}"),
            decoder.feed("1}\n{\"two\":2}\n".encodeToByteArray()),
        )
        assertEquals(emptyList(), decoder.finish())
    }

    @Test
    fun emitsAnUnterminatedFinalLine() {
        val decoder = JsonLinesDecoder()

        decoder.feed("{\"done\":true}".encodeToByteArray())

        assertEquals(listOf("{\"done\":true}"), decoder.finish())
    }
}
