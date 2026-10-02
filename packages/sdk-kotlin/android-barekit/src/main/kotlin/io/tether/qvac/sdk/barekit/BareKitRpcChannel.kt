package io.tether.qvac.sdk.barekit

import io.tether.qvac.sdk.rpc.BareRpcChannel
import io.tether.qvac.sdk.rpc.BareRpcProtocolException
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.CancellableContinuation
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import to.holepunch.bare.kit.IPC
import java.nio.ByteBuffer
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

internal class BareKitRpcChannel(
    private val ipc: IPC,
) : BareRpcChannel {
    private val readMutex = Mutex()
    private var pending = byteArrayOf()
    private var closed = false
    private var pendingRead: CancellableContinuation<ByteArray?>? = null
    private var pendingWrite: CancellableContinuation<Unit>? = null

    override suspend fun readExactly(count: Int): ByteArray = withContext(Dispatchers.Main.immediate) {
        readMutex.withLock {
            require(count >= 0) { "read count must not be negative" }
            while (pending.size < count) {
                val chunk = readChunk()
                if (chunk == null) {
                    throw BareRpcProtocolException("BareKit IPC closed")
                }
                pending += chunk
            }

            val result = pending.copyOfRange(0, count)
            pending = pending.copyOfRange(count, pending.size)
            result
        }
    }

    override suspend fun write(data: ByteArray): Unit = withContext(NonCancellable + Dispatchers.Main.immediate) {
        check(!closed) { "BareKit IPC is closed" }
        // BareKit owns one writable callback. Do not let caller cancellation
        // release the RPC write lock until this entire frame has been written.
        // A stalled/failed partial write must close the connection, not allow
        // another frame to overwrite that callback and corrupt the byte stream.
        try {
            withTimeout(10_000) {
                suspendCancellableCoroutine<Unit> { continuation ->
                    pendingWrite = continuation
                    val buffer = ByteBuffer.allocateDirect(data.size)
                    buffer.put(data)
                    buffer.flip()
                    fun pump() {
                        if (!continuation.isActive) return
                        try {
                            val written = ipc.write(buffer.slice())
                            check(written >= 0 && written <= buffer.remaining()) { "BareKit IPC write failed: $written" }
                            buffer.position(buffer.position() + written)
                            if (buffer.hasRemaining()) {
                                ipc.writable { pump() }
                            } else {
                                ipc.writable(null)
                                continuation.resume(Unit)
                            }
                        } catch (error: Throwable) {
                            ipc.writable(null)
                            continuation.resumeWithException(error)
                        }
                    }
                    pump()
                }
            }
        } catch (error: Throwable) {
            close()
            throw error
        } finally {
            pendingWrite = null
        }
    }

    override suspend fun close(): Unit = withContext(NonCancellable + Dispatchers.Main.immediate) {
        if (closed) return@withContext
        closed = true
        ipc.readable(null)
        ipc.writable(null)
        ipc.close()
        val error = BareRpcProtocolException("BareKit IPC closed")
        pendingRead?.takeIf { it.isActive }?.resumeWithException(error)
        pendingWrite?.takeIf { it.isActive }?.resumeWithException(error)
        pendingRead = null
        pendingWrite = null
    }

    private suspend fun readChunk(): ByteArray? {
        check(!closed) { "BareKit IPC is closed" }
        return suspendCancellableCoroutine { continuation ->
            pendingRead = continuation
            ipc.read(readCallback@{ data, error ->
                pendingRead = null
                if (!continuation.isActive) return@readCallback
                when {
                    error != null -> continuation.resumeWithException(error)
                    data == null -> continuation.resume(null)
                    else -> continuation.resume(data.toByteArray())
                }
            })
        }
    }

    private fun ByteBuffer.toByteArray(): ByteArray {
        val bytes = ByteArray(remaining())
        get(bytes)
        return bytes
    }
}
