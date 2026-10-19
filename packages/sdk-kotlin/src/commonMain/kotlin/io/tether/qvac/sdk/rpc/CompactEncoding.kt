package io.tether.qvac.sdk.rpc

internal data class DecodeResult<T>(
    val value: T,
    val nextOffset: Int,
)

internal object CompactEncoding {
    fun encodeUint(value: Long): ByteArray {
        require(value >= 0) { "compact uint cannot encode a negative value" }

        return when {
            value <= 0xfc -> byteArrayOf(value.toByte())
            value <= 0xffff -> byteArrayOf(
                0xfd.toByte(),
                value.toByte(),
                (value shr 8).toByte(),
            )
            value <= 0xffffffffL -> byteArrayOf(
                0xfe.toByte(),
                value.toByte(),
                (value shr 8).toByte(),
                (value shr 16).toByte(),
                (value shr 24).toByte(),
            )
            else -> byteArrayOf(
                0xff.toByte(),
                value.toByte(),
                (value shr 8).toByte(),
                (value shr 16).toByte(),
                (value shr 24).toByte(),
                (value shr 32).toByte(),
                (value shr 40).toByte(),
                (value shr 48).toByte(),
                (value shr 56).toByte(),
            )
        }
    }

    fun decodeUint(bytes: ByteArray, offset: Int = 0): DecodeResult<Long> {
        requireAvailable(bytes, offset, 1)
        val marker = bytes[offset].toInt() and 0xff

        return when (marker) {
            in 0..0xfc -> DecodeResult(marker.toLong(), offset + 1)
            0xfd -> DecodeResult(readLittleEndian(bytes, offset + 1, 2), offset + 3)
            0xfe -> DecodeResult(readLittleEndian(bytes, offset + 1, 4), offset + 5)
            else -> DecodeResult(readLittleEndian(bytes, offset + 1, 8), offset + 9)
        }
    }

    fun encodeInt(value: Long) = encodeUint((value shl 1) xor (value shr 63))

    fun decodeInt(bytes: ByteArray, offset: Int = 0): DecodeResult<Long> {
        val decoded = decodeUint(bytes, offset)
        val value = (decoded.value ushr 1) xor -(decoded.value and 1)
        return DecodeResult(value, decoded.nextOffset)
    }

    fun encodeBoolean(value: Boolean) = byteArrayOf(if (value) 1 else 0)

    fun decodeBoolean(bytes: ByteArray, offset: Int = 0): DecodeResult<Boolean> {
        requireAvailable(bytes, offset, 1)
        return when (bytes[offset].toInt()) {
            0 -> DecodeResult(false, offset + 1)
            1 -> DecodeResult(true, offset + 1)
            else -> throw BareRpcProtocolException("invalid compact boolean")
        }
    }

    fun encodeBuffer(value: ByteArray) = concat(encodeUint(value.size.toLong()), value)

    fun decodeBuffer(bytes: ByteArray, offset: Int = 0): DecodeResult<ByteArray> {
        val length = decodeUint(bytes, offset)
        if (length.value > Int.MAX_VALUE) {
            throw BareRpcProtocolException("buffer length exceeds supported size")
        }

        val size = length.value.toInt()
        requireAvailable(bytes, length.nextOffset, size)
        return DecodeResult(
            bytes.copyOfRange(length.nextOffset, length.nextOffset + size),
            length.nextOffset + size,
        )
    }

    fun encodeUtf8(value: String) = encodeBuffer(value.encodeToByteArray())

    fun decodeUtf8(bytes: ByteArray, offset: Int = 0): DecodeResult<String> {
        val decoded = decodeBuffer(bytes, offset)
        return DecodeResult(decoded.value.decodeToString(), decoded.nextOffset)
    }

    fun encodeUint32(value: Int) = byteArrayOf(
        value.toByte(),
        (value ushr 8).toByte(),
        (value ushr 16).toByte(),
        (value ushr 24).toByte(),
    )

    fun decodeUint32(bytes: ByteArray, offset: Int = 0): DecodeResult<Int> {
        requireAvailable(bytes, offset, 4)
        val value = (bytes[offset].toInt() and 0xff) or
            ((bytes[offset + 1].toInt() and 0xff) shl 8) or
            ((bytes[offset + 2].toInt() and 0xff) shl 16) or
            ((bytes[offset + 3].toInt() and 0xff) shl 24)
        return DecodeResult(value, offset + 4)
    }

    private fun readLittleEndian(bytes: ByteArray, offset: Int, count: Int): Long {
        requireAvailable(bytes, offset, count)
        var value = 0L
        for (index in 0 until count) {
            value = value or ((bytes[offset + index].toLong() and 0xff) shl (index * 8))
        }
        return value
    }

    private fun requireAvailable(bytes: ByteArray, offset: Int, count: Int) {
        if (offset < 0 || count < 0 || offset > bytes.size - count) {
            throw BareRpcProtocolException("compact value exceeds frame bounds")
        }
    }

    internal fun concat(vararg parts: ByteArray): ByteArray {
        val output = ByteArray(parts.sumOf(ByteArray::size))
        var offset = 0
        for (part in parts) {
            part.copyInto(output, offset)
            offset += part.size
        }
        return output
    }
}
