package io.tether.qvac.sdk.rpc

class JsonLinesDecoder(private val maxLineBytes: Int = 16 * 1024 * 1024) {
    // A single JSON line can span many feed() chunks (multi-MB base64 frames).
    // Keep one growable buffer and only scan bytes that are new since the last
    // feed, so assembling an N-byte line costs O(N) rather than O(N^2).
    private var buffer = ByteArray(0)
    private var size = 0
    private var scanned = 0
    init { require(maxLineBytes > 0) }

    fun feed(chunk: ByteArray): List<String> {
        if (chunk.isEmpty()) return emptyList()

        val searchStart = scanned
        append(chunk)
        val lines = mutableListOf<String>()
        var lineStart = 0
        var index = searchStart
        while (index < size) {
            if (buffer[index] == '\n'.code.toByte()) {
                checkLength(index - lineStart)
                addLine(buffer, lineStart, index, lines)
                lineStart = index + 1
            }
            index++
        }

        checkLength(size - lineStart)
        compact(lineStart)
        scanned = size
        return lines
    }

    private fun checkLength(length: Int) {
        if (length > maxLineBytes) {
            reset()
            throw BareRpcLimitException("JSON line exceeds $maxLineBytes bytes")
        }
    }

    fun finish(): List<String> {
        if (size == 0) return emptyList()

        val lines = mutableListOf<String>()
        addLine(buffer, 0, size, lines)
        reset()
        return lines
    }

    private fun append(chunk: ByteArray) {
        if (size + chunk.size > buffer.size) {
            val grown = ByteArray(maxOf(size + chunk.size, buffer.size * 2))
            buffer.copyInto(grown, 0, 0, size)
            buffer = grown
        }
        chunk.copyInto(buffer, size, 0, chunk.size)
        size += chunk.size
    }

    private fun compact(consumed: Int) {
        if (consumed == 0) return
        buffer.copyInto(buffer, 0, consumed, size)
        size -= consumed
    }

    private fun reset() {
        buffer = ByteArray(0)
        size = 0
        scanned = 0
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
