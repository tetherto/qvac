package io.tether.qvac.sdk.rpc

class JsonLinesDecoder(private val maxLineBytes: Int = 16 * 1024 * 1024) {
    private var pending = byteArrayOf()
    init { require(maxLineBytes > 0) }

    fun feed(chunk: ByteArray): List<String> {
        if (chunk.isEmpty()) return emptyList()

        val bytes = CompactEncoding.concat(pending, chunk)
        val lines = mutableListOf<String>()
        var lineStart = 0

        for (index in bytes.indices) {
            if (bytes[index] == '\n'.code.toByte()) {
                checkLength(index - lineStart)
                addLine(bytes, lineStart, index, lines)
                lineStart = index + 1
            }
        }

        checkLength(bytes.size - lineStart)
        pending = bytes.copyOfRange(lineStart, bytes.size)
        return lines
    }

    private fun checkLength(length: Int) {
        if (length > maxLineBytes) {
            pending = byteArrayOf()
            throw BareRpcLimitException("JSON line exceeds $maxLineBytes bytes")
        }
    }

    fun finish(): List<String> {
        if (pending.isEmpty()) return emptyList()

        val lines = mutableListOf<String>()
        addLine(pending, 0, pending.size, lines)
        pending = byteArrayOf()
        return lines
    }

    private fun addLine(
        bytes: ByteArray,
        start: Int,
        end: Int,
        destination: MutableList<String>,
    ) {
        val value = bytes.copyOfRange(start, end).decodeToString()
        if (value.isNotBlank()) destination += value
    }
}
