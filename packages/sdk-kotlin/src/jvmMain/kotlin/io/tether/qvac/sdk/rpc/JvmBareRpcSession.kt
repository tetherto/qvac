package io.tether.qvac.sdk.rpc

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.withContext
import java.io.EOFException
import java.net.Socket

class JvmBareRpcSession(
    socket: Socket,
    limits: BareRpcLimits = BareRpcLimits(),
) {
    private val session = BareRpcSession(JvmSocketChannel(socket), limits)

    suspend fun request(data: ByteArray, command: Long = 0) = session.request(data, command)

    fun responseStream(data: ByteArray, command: Long = 0) = session.responseStream(data, command)

    fun duplex(
        metadata: ByteArray,
        input: Flow<ByteArray>,
        command: Long = 0,
    ) = session.duplex(metadata, input, command)

    suspend fun close() = session.close()
}

private class JvmSocketChannel(
    private val socket: Socket,
) : BareRpcChannel {
    override suspend fun readExactly(count: Int): ByteArray = withContext(Dispatchers.IO) {
        val bytes = ByteArray(count)
        var offset = 0
        val input = socket.getInputStream()
        while (offset < count) {
            val read = input.read(bytes, offset, count - offset)
            if (read < 0) throw EOFException("bare-rpc socket closed")
            offset += read
        }
        bytes
    }

    override suspend fun write(data: ByteArray) = withContext(Dispatchers.IO) {
        socket.getOutputStream().write(data)
        socket.getOutputStream().flush()
    }

    override suspend fun close() {
        withContext(Dispatchers.IO) {
            socket.close()
        }
    }
}
