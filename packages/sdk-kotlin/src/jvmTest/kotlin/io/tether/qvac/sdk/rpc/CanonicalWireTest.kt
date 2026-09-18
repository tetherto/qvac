package io.tether.qvac.sdk.rpc

import java.nio.file.Files
import java.nio.file.Path
import kotlinx.serialization.json.*
import kotlin.test.*

class CanonicalWireTest {
    @Test
    fun matchesLockedBareRpcAndCompactEncodingBytes() {
        val root = Json.parseToJsonElement(Files.readString(Path.of("test-fixtures/bare-rpc.json"))).jsonObject
        for (entry in root.getValue("frames").jsonArray) {
            val bytes = entry.jsonObject.getValue("hex").jsonPrimitive.content.hexBytes()
            val decoded = BareRpcCodec.decodeFrame(bytes)
            assertEquals(entry.jsonObject.getValue("id").jsonPrimitive.long, decoded.id)
            val encoded = when (decoded) {
                is BareRpcMessage.Request -> BareRpcCodec.encodeRequest(decoded.id, decoded.command, decoded.data, decoded.stream)
                is BareRpcMessage.Response -> BareRpcCodec.encodeResponse(decoded.id, decoded.data, decoded.stream, decoded.error)
                is BareRpcMessage.Stream -> BareRpcCodec.encodeStream(decoded.id, decoded.flags, decoded.data, decoded.error)
            }
            assertContentEquals(bytes, encoded)
        }
        for ((key, signed) in listOf("uints" to false, "ints" to true)) {
            for (entry in root.getValue(key).jsonArray) {
                val value = entry.jsonObject.getValue("value").jsonPrimitive.long
                val bytes = entry.jsonObject.getValue("hex").jsonPrimitive.content.hexBytes()
                assertContentEquals(bytes, if (signed) CompactEncoding.encodeInt(value) else CompactEncoding.encodeUint(value))
                assertEquals(value, if (signed) CompactEncoding.decodeInt(bytes).value else CompactEncoding.decodeUint(bytes).value)
            }
        }
    }

    private fun String.hexBytes() = chunked(2).map { it.toInt(16).toByte() }.toByteArray()
}
