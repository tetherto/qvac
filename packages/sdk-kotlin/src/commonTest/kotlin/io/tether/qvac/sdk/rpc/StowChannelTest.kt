package io.tether.qvac.sdk.rpc

import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class StowChannelTest {
    @Test
    fun userDataSpansFramesAndSkipsControlFramesBetweenThem() = runTest {
        val inner = ByteSource(
            frame(CONTROL, """{"type":"ready"}""".encodeToByteArray()) +
                frame(USER, "hel".encodeToByteArray()) +
                frame(CONTROL, """{"type":"unknown"}""".encodeToByteArray()) +
                frame(USER, "lo".encodeToByteArray()),
        )
        val channel = StowChannel(inner)

        channel.awaitReady()

        assertContentEquals("hello".encodeToByteArray(), channel.readExactly(5))
    }

    @Test
    fun aLargeFrameIsReadInTheCallersPiecesWithoutBufferingIt() = runTest {
        val payload = ByteArray(1024 * 1024) { (it % 251).toByte() }
        val inner = ByteSource(frame(USER, payload))
        val channel = StowChannel(inner)

        val read = ByteArray(payload.size)
        var offset = 0
        while (offset < payload.size) {
            channel.readExactly(4096).copyInto(read, offset)
            offset += 4096
        }

        assertContentEquals(payload, read)
        assertTrue(inner.largestRead <= 4096, "largest inner read was ${inner.largestRead}")
    }

    @Test
    fun aWorkerErrorBeforeReadyIsWhatAwaitReadyThrows() = runTest {
        val inner = ByteSource(
            frame(CONTROL, """{"type":"error","message":"boom","stack":"at x"}""".encodeToByteArray()),
        )
        val channel = StowChannel(inner)

        val error = assertFailsWith<StowWorkerException> { channel.awaitReady() }

        assertEquals("boom", error.message)
        assertEquals("at x", error.remoteStack)
    }

    @Test
    fun aZeroLengthFrameIsAProtocolError() = runTest {
        val channel = StowChannel(ByteSource(byteArrayOf(0, 0, 0, 0, 1)))

        assertFailsWith<BareRpcProtocolException> { channel.readExactly(1) }
    }

    @Test
    fun aFrameAboveTheCapIsAProtocolError() = runTest {
        val channel = StowChannel(ByteSource(frame(USER, ByteArray(16))), maxFrameBytes = 8)

        assertFailsWith<BareRpcProtocolException> { channel.readExactly(1) }
    }

    private class ByteSource(private val bytes: ByteArray) : BareRpcChannel {
        private var offset = 0
        var largestRead = 0
            private set

        override suspend fun readExactly(count: Int): ByteArray {
            if (offset + count > bytes.size) throw BareRpcProtocolException("end of stream")
            largestRead = maxOf(largestRead, count)
            val result = bytes.copyOfRange(offset, offset + count)
            offset += count
            return result
        }

        override suspend fun write(data: ByteArray) = Unit

        override suspend fun close() = Unit
    }

    private companion object {
        const val CONTROL = 0
        const val USER = 1

        fun frame(tag: Int, payload: ByteArray): ByteArray {
            val length = payload.size + 1
            return byteArrayOf(
                length.toByte(),
                (length ushr 8).toByte(),
                (length ushr 16).toByte(),
                (length ushr 24).toByte(),
                tag.toByte(),
            ) + payload
        }
    }
}
