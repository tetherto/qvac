package io.tether.qvac.sdk

import kotlinx.coroutines.async
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertTrue

class StowChannelTest {
    @Test
    fun userDataSpansFramesAndChunksAndSkipsControlFramesBetweenThem() = runTest {
        val wire = frame(CONTROL, """{"type":"ready"}""".encodeToByteArray()) +
            frame(USER, "hel".encodeToByteArray()) +
            frame(CONTROL, """{"type":"unknown"}""".encodeToByteArray()) +
            frame(USER, "lo".encodeToByteArray())
        val channel = StowChannel(chunks(wire, 3), send = {})

        channel.awaitReady()

        assertContentEquals("hello".encodeToByteArray(), readAll(channel))
    }

    @Test
    fun aLargeUserFrameIsPassedThroughInTheTransportsPieces() = runTest {
        val payload = ByteArray(1024 * 1024) { (it % 251).toByte() }
        val channel = StowChannel(chunks(frame(USER, payload), 4096), send = {})

        var largest = 0
        val read = ArrayList<Byte>(payload.size)
        while (true) {
            val piece = channel.read() ?: break
            largest = maxOf(largest, piece.size)
            read += piece.toList()
        }

        assertContentEquals(payload, read.toByteArray())
        assertTrue(largest <= 4096, "largest piece was $largest")
    }

    @Test
    fun aWorkerErrorBeforeReadyIsWhatAwaitReadyThrows() = runTest {
        val wire = frame(CONTROL, """{"type":"error","message":"boom","stack":"at x"}""".encodeToByteArray())
        val channel = StowChannel(chunks(wire, wire.size), send = {})

        val error = assertFailsWith<StowWorkerException> { channel.awaitReady() }

        assertEquals("boom", error.message)
        assertEquals("at x", error.remoteStack)
    }

    @Test
    fun aTransportThatEndsBeforeReadyFailsAwaitReady() = runTest {
        val channel = StowChannel(chunks(ByteArray(0), 1), send = {})

        assertFailsWith<QvacWorkerProtocolException> { channel.awaitReady() }
    }

    @Test
    fun terminateSendsTheControlFrameAndReturnsTheExitCode() = runTest {
        val sent = ArrayList<ByteArray>()
        val wire = frame(CONTROL, """{"type":"ready"}""".encodeToByteArray()) +
            frame(CONTROL, """{"type":"exit","code":3}""".encodeToByteArray())
        val channel = StowChannel(chunks(wire, wire.size), send = { sent += it })
        channel.awaitReady()

        val code = async { channel.terminate() }
        assertNull(channel.read())

        assertEquals(3, code.await())
        assertContentEquals(frame(CONTROL, """{"type":"terminate"}""".encodeToByteArray()), sent.single())
    }

    @Test
    fun writeWrapsTheBytesInAUserFrame() = runTest {
        val sent = ArrayList<ByteArray>()
        val channel = StowChannel(chunks(ByteArray(0), 1), send = { sent += it })

        channel.write("abc".encodeToByteArray())

        assertContentEquals(frame(USER, "abc".encodeToByteArray()), sent.single())
    }

    @Test
    fun aZeroLengthFrameIsAProtocolError() = runTest {
        val channel = StowChannel(chunks(byteArrayOf(0, 0, 0, 0, 1), 5), send = {})

        assertFailsWith<QvacWorkerProtocolException> { channel.read() }
    }

    @Test
    fun aControlFrameAboveTheCapIsAProtocolError() = runTest {
        val wire = frame(CONTROL, ByteArray(16))
        val channel = StowChannel(chunks(wire, wire.size), send = {}, maxControlBytes = 8)

        assertFailsWith<QvacWorkerProtocolException> { channel.read() }
    }

    private suspend fun readAll(channel: StowChannel): ByteArray {
        val read = ArrayList<Byte>()
        while (true) read += (channel.read() ?: break).toList()
        return read.toByteArray()
    }

    private companion object {
        const val CONTROL = 0
        const val USER = 1

        fun chunks(bytes: ByteArray, size: Int): suspend () -> ByteArray? {
            var offset = 0
            return {
                if (offset >= bytes.size) {
                    null
                } else {
                    val end = minOf(offset + size, bytes.size)
                    bytes.copyOfRange(offset, end).also { offset = end }
                }
            }
        }

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
