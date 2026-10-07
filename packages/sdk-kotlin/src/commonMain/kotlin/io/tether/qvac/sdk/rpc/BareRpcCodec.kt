package io.tether.qvac.sdk.rpc

class BareRpcProtocolException(message: String) : Exception(message)

data class BareRpcRemoteError(
    val message: String,
    val code: String,
    val errno: Long,
)

sealed interface BareRpcMessage {
    val id: Long

    data class Request(
        override val id: Long,
        val command: Long,
        val stream: Long,
        val data: ByteArray?,
    ) : BareRpcMessage

    data class Response(
        override val id: Long,
        val stream: Long,
        val data: ByteArray?,
        val error: BareRpcRemoteError?,
    ) : BareRpcMessage

    data class Stream(
        override val id: Long,
        val flags: Long,
        val data: ByteArray?,
        val error: BareRpcRemoteError?,
    ) : BareRpcMessage
}

object StreamFlags {
    const val OPEN = 0x01L
    const val CLOSE = 0x02L
    const val PAUSE = 0x04L
    const val RESUME = 0x08L
    const val DATA = 0x10L
    const val END = 0x20L
    const val DESTROY = 0x40L
    const val ERROR = 0x80L
    const val REQUEST = 0x100L
    const val RESPONSE = 0x200L
}

object BareRpcCodec {
    private const val REQUEST = 1L
    private const val RESPONSE = 2L
    private const val STREAM = 3L

    fun encodeRequest(
        id: Long,
        command: Long,
        data: ByteArray? = null,
        stream: Long = 0,
    ): ByteArray {
        val parts = mutableListOf(
            CompactEncoding.encodeUint(REQUEST),
            CompactEncoding.encodeUint(id),
            CompactEncoding.encodeUint(command),
            CompactEncoding.encodeUint(stream),
        )
        if (stream == 0L) {
            parts += CompactEncoding.encodeBuffer(data ?: byteArrayOf())
        }
        return frame(CompactEncoding.concat(*parts.toTypedArray()))
    }

    fun encodeResponse(
        id: Long,
        data: ByteArray? = null,
        stream: Long = 0,
        error: BareRpcRemoteError? = null,
    ): ByteArray {
        val parts = mutableListOf(
            CompactEncoding.encodeUint(RESPONSE),
            CompactEncoding.encodeUint(id),
            CompactEncoding.encodeBoolean(error != null),
            CompactEncoding.encodeUint(stream),
        )
        when {
            error != null -> {
                parts += CompactEncoding.encodeUtf8(error.message)
                parts += CompactEncoding.encodeUtf8(error.code)
                parts += CompactEncoding.encodeInt(error.errno)
            }
            stream == 0L -> parts += CompactEncoding.encodeBuffer(data ?: byteArrayOf())
        }
        return frame(CompactEncoding.concat(*parts.toTypedArray()))
    }

    fun encodeStream(
        id: Long,
        flags: Long,
        data: ByteArray? = null,
        error: BareRpcRemoteError? = null,
    ): ByteArray {
        val parts = mutableListOf(
            CompactEncoding.encodeUint(STREAM),
            CompactEncoding.encodeUint(id),
            CompactEncoding.encodeUint(flags),
        )
        when {
            flags and StreamFlags.ERROR != 0L -> {
                val remoteError = error
                    ?: throw BareRpcProtocolException("stream ERROR flag requires an error")
                parts += CompactEncoding.encodeUtf8(remoteError.message)
                parts += CompactEncoding.encodeUtf8(remoteError.code)
                parts += CompactEncoding.encodeInt(remoteError.errno)
            }
            flags and StreamFlags.DATA != 0L -> {
                parts += CompactEncoding.encodeBuffer(data ?: byteArrayOf())
            }
        }
        return frame(CompactEncoding.concat(*parts.toTypedArray()))
    }

    fun decodeFrame(frame: ByteArray): BareRpcMessage {
        if (frame.size < 4) {
            throw BareRpcProtocolException("frame is shorter than its length prefix")
        }

        val declared = CompactEncoding.decodeUint32(frame).value
        if (declared < 0 || frame.size != declared + 4) {
            throw BareRpcProtocolException(
                "frame length mismatch: declared=$declared actual=${frame.size - 4}",
            )
        }

        var offset = 4
        val type = CompactEncoding.decodeUint(frame, offset).also { offset = it.nextOffset }.value
        val id = CompactEncoding.decodeUint(frame, offset).also { offset = it.nextOffset }.value

        return when (type) {
            REQUEST -> decodeRequest(frame, id, offset)
            RESPONSE -> decodeResponse(frame, id, offset)
            STREAM -> decodeStream(frame, id, offset)
            else -> throw BareRpcProtocolException("unknown bare-rpc message type $type")
        }
    }

    private fun decodeRequest(frame: ByteArray, id: Long, start: Int): BareRpcMessage.Request {
        var offset = start
        val command = CompactEncoding.decodeUint(frame, offset).also { offset = it.nextOffset }.value
        val stream = CompactEncoding.decodeUint(frame, offset).also { offset = it.nextOffset }.value
        val data = if (stream == 0L) CompactEncoding.decodeBuffer(frame, offset).value else null
        return BareRpcMessage.Request(id, command, stream, data)
    }

    private fun decodeResponse(frame: ByteArray, id: Long, start: Int): BareRpcMessage.Response {
        var offset = start
        val isError = CompactEncoding.decodeBoolean(frame, offset).also {
            offset = it.nextOffset
        }.value
        val stream = CompactEncoding.decodeUint(frame, offset).also { offset = it.nextOffset }.value
        if (isError) {
            return BareRpcMessage.Response(id, stream, null, decodeError(frame, offset))
        }
        val data = if (stream == 0L) CompactEncoding.decodeBuffer(frame, offset).value else null
        return BareRpcMessage.Response(id, stream, data, null)
    }

    private fun decodeStream(frame: ByteArray, id: Long, start: Int): BareRpcMessage.Stream {
        var offset = start
        val flags = CompactEncoding.decodeUint(frame, offset).also { offset = it.nextOffset }.value
        return when {
            flags and StreamFlags.ERROR != 0L -> {
                BareRpcMessage.Stream(id, flags, null, decodeError(frame, offset))
            }
            flags and StreamFlags.DATA != 0L -> {
                BareRpcMessage.Stream(
                    id,
                    flags,
                    CompactEncoding.decodeBuffer(frame, offset).value,
                    null,
                )
            }
            else -> BareRpcMessage.Stream(id, flags, null, null)
        }
    }

    private fun decodeError(frame: ByteArray, start: Int): BareRpcRemoteError {
        var offset = start
        val message = CompactEncoding.decodeUtf8(frame, offset).also {
            offset = it.nextOffset
        }.value
        val code = CompactEncoding.decodeUtf8(frame, offset).also { offset = it.nextOffset }.value
        val errno = CompactEncoding.decodeInt(frame, offset).value
        return BareRpcRemoteError(message, code, errno)
    }

    private fun frame(body: ByteArray): ByteArray {
        return CompactEncoding.concat(CompactEncoding.encodeUint32(body.size), body)
    }
}
