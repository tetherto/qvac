package io.tether.qvac.sdk.rpc

import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNull

class BareRpcCodecTest {
    @Test
    fun encodesUnaryRequestFrame() {
        val frame = BareRpcCodec.encodeRequest(
            id = 1,
            command = 0,
            data = "{}".encodeToByteArray(),
        )

        assertContentEquals(
            byteArrayOf(7, 0, 0, 0, 1, 1, 0, 0, 2, 0x7b, 0x7d),
            frame,
        )
    }

    @Test
    fun decodesUnaryResponseFrame() {
        val message = BareRpcCodec.decodeFrame(
            byteArrayOf(7, 0, 0, 0, 2, 1, 0, 0, 2, 0x7b, 0x7d),
        )

        val response = assertIs<BareRpcMessage.Response>(message)
        assertEquals(1, response.id)
        assertContentEquals("{}".encodeToByteArray(), response.data)
        assertNull(response.error)
    }

    @Test
    fun roundTripsResponseStreamControlAndDataFrames() {
        val open = BareRpcCodec.decodeFrame(
            BareRpcCodec.encodeStream(2, StreamFlags.RESPONSE or StreamFlags.OPEN),
        )
        val data = BareRpcCodec.decodeFrame(
            BareRpcCodec.encodeStream(
                2,
                StreamFlags.RESPONSE or StreamFlags.DATA,
                "{\"type\":\"heartbeat\"}\n".encodeToByteArray(),
            ),
        )

        val openMessage = assertIs<BareRpcMessage.Stream>(open)
        assertEquals(StreamFlags.RESPONSE or StreamFlags.OPEN, openMessage.flags)

        val dataMessage = assertIs<BareRpcMessage.Stream>(data)
        assertContentEquals("{\"type\":\"heartbeat\"}\n".encodeToByteArray(), dataMessage.data)
    }

    @Test
    fun rejectsTruncatedFrames() {
        kotlin.test.assertFailsWith<BareRpcProtocolException> {
            BareRpcCodec.decodeFrame(byteArrayOf(8, 0, 0, 0, 2, 1))
        }
    }
}
