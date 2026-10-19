package io.tether.qvac.sdk.rpc

import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals

class CompactEncodingTest {
    @Test
    fun encodesUintBoundaryValues() {
        assertContentEquals(byteArrayOf(0xfc.toByte()), CompactEncoding.encodeUint(0xfc))
        assertContentEquals(
            byteArrayOf(0xfd.toByte(), 0xfd.toByte(), 0x00),
            CompactEncoding.encodeUint(0xfd),
        )
        assertContentEquals(
            byteArrayOf(0xfe.toByte(), 0x00, 0x00, 0x01, 0x00),
            CompactEncoding.encodeUint(0x10000),
        )
    }

    @Test
    fun roundTripsSignedIntegers() {
        for (value in listOf(-1024L, -1L, 0L, 1L, 1024L)) {
            val encoded = CompactEncoding.encodeInt(value)
            val decoded = CompactEncoding.decodeInt(encoded)

            assertEquals(value, decoded.value)
            assertEquals(encoded.size, decoded.nextOffset)
        }
    }
}
