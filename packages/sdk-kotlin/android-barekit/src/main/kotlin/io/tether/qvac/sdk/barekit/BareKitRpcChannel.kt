package io.tether.qvac.sdk.barekit

import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.CancellableContinuation
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import to.holepunch.bare.kit.IPC
import java.io.IOException
import java.nio.ByteBuffer
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** The BareKit IPC as the byte transport under [io.tether.qvac.sdk.WorkerRpc]. */
internal class BareKitRpcChannel(
    private val ipc: IPC,
) {
    private var closed = false
    private var pendingRead: CancellableContinuation<ByteArray?>? = null
    private var pendingWrite: CancellableContinuation<Unit>? = null

    /** The next bytes the worklet wrote, or null once the IPC ends. */
    suspend fun read(): ByteArray? = withContext(Dispatchers.Main.immediate) {
        check(!closed) { "BareKit IPC is closed" }
        suspendCancellableCoroutine { continuation ->
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

    suspend fun write(data: ByteArray): Unit = withContext(NonCancellable + Dispatchers.Main.immediate) {
        check(!closed) { "BareKit IPC is closed" }
        // BareKit owns one writable callback. Do not let caller cancellation
        // release the RPC write lock until this entire frame has been written.
        // A stalled/failed partial write must close the connection, not allow
        // another frame to overwrite that callback and corrupt the byte stream.
        try {
            withTimeout(WRITE_TIMEOUT_MS) {
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

    suspend fun close(): Unit = withContext(NonCancellable + Dispatchers.Main.immediate) {
        if (closed) return@withContext
        closed = true
        ipc.readable(null)
        ipc.writable(null)
        ipc.close()
        val error = IOException("BareKit IPC closed")
        pendingRead?.takeIf { it.isActive }?.resumeWithException(error)
        pendingWrite?.takeIf { it.isActive }?.resumeWithException(error)
        pendingRead = null
        pendingWrite = null
    }

    private fun ByteBuffer.toByteArray(): ByteArray {
        val bytes = ByteArray(remaining())
        get(bytes)
        return bytes
    }

    private companion object {
        const val WRITE_TIMEOUT_MS = 10_000L
    }
}
