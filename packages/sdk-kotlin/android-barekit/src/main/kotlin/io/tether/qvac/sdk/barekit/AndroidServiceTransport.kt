package io.tether.qvac.sdk.barekit

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.DeadObjectException
import android.os.IBinder
import io.tether.qvac.sdk.QvacTransport
import io.tether.qvac.sdk.QvacRuntimeProfile
import kotlinx.coroutines.CancellableContinuation
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.trySendBlocking
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import java.util.UUID
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.channels.awaitClose

class QvacWorkerRemoteException(
    message: String,
) : Exception(message)

/**
 * Client-side transport for [QvacWorkerService].
 *
 * Every request crosses the Binder boundary as JSON. Streaming callbacks and
 * duplex byte chunks are owned by the service process, so native addon memory
 * never enters the application process.
 */
class AndroidServiceTransport private constructor(
    private val context: Context,
    private val service: IQvacWorkerService,
    private val connection: ServiceConnection,
    private val json: Json,
    override val runtimeProfile: QvacRuntimeProfile,
) : QvacTransport {
    override suspend fun call(payload: JsonObject): JsonObject {
        return suspendCancellableCoroutine { continuation ->
            val callback = unaryCallback(continuation)
            runCatching {
                service.call(payload.toString(), callback)
            }.onFailure { continuation.resumeWithException(asWorkerException(it)) }
        }
    }

    override fun stream(payload: JsonObject): Flow<JsonObject> {
        return callbackFlow {
            // AIDL callbacks are synchronous. Blocking the Binder callback when
            // the Flow buffer is full provides backpressure instead of silently
            // dropping a token when trySend() fails at the default capacity.
            val callback = streamCallback({ trySendBlocking(it) }, { close(it) }, { close() })
            runCatching {
                service.stream(payload.toString(), callback)
            }.onFailure { close(asWorkerException(it)) }
            awaitClose { }
        }
    }

    override fun duplex(payload: JsonObject, input: Flow<ByteArray>): Flow<JsonObject> {
        return callbackFlow {
            val requestId = UUID.randomUUID().toString()
            val callback = streamCallback({ trySendBlocking(it) }, { close(it) }, { close() })
            runCatching {
                service.duplex(requestId, payload.toString(), callback)
            }.onFailure { close(asWorkerException(it)) }

            val inputJob = launch(Dispatchers.IO) {
                runCatching {
                    input.collect { chunk ->
                        // Binder's transaction budget is shared across requests.
                        var offset = 0
                        while (offset < chunk.size) {
                            val end = minOf(offset + QvacWorkerService.MAX_DUPLEX_CHUNK_BYTES, chunk.size)
                            service.duplexChunk(requestId, chunk.copyOfRange(offset, end), false)
                            offset = end
                        }
                    }
                    service.duplexChunk(requestId, ByteArray(0), true)
                }.onFailure {
                    close(asWorkerException(it))
                }
            }
            awaitClose {
                inputJob.cancel()
                runCatching { service.cancelDuplex(requestId) }
            }
        }
    }

    override suspend fun close() {
        withContext(Dispatchers.IO) {
            runCatching { service.close() }
            runCatching { context.unbindService(connection) }
        }
    }

    private fun unaryCallback(
        continuation: CancellableContinuation<JsonObject>,
    ): IQvacWorkerCallback {
        return object : IQvacWorkerCallback.Stub() {
            private val chunkedEnvelope = StringBuilder()

            override fun onNext(payload: String) {
                if (continuation.isActive) {
                    continuation.resume(parse(payload))
                }
            }

            override fun onChunk(payloadChunk: String, endOfEnvelope: Boolean) {
                synchronized(chunkedEnvelope) {
                    chunkedEnvelope.append(payloadChunk)
                    if (endOfEnvelope && continuation.isActive) {
                        val payload = chunkedEnvelope.toString()
                        chunkedEnvelope.clear()
                        continuation.resume(parse(payload))
                    }
                }
            }

            override fun onError(message: String) {
                if (continuation.isActive) {
                    continuation.resumeWithException(QvacWorkerRemoteException(message))
                }
            }

            override fun onComplete() = Unit
        }
    }

    private fun streamCallback(
        emit: (JsonObject) -> Unit,
        fail: (Throwable) -> Unit,
        complete: () -> Unit,
    ): IQvacWorkerCallback {
        return object : IQvacWorkerCallback.Stub() {
            private val chunkedEnvelope = StringBuilder()

            override fun onNext(payload: String) {
                runCatching { parse(payload) }.onSuccess(emit).onFailure(fail)
            }

            override fun onChunk(payloadChunk: String, endOfEnvelope: Boolean) {
                synchronized(chunkedEnvelope) {
                    chunkedEnvelope.append(payloadChunk)
                    if (endOfEnvelope) {
                        val payload = chunkedEnvelope.toString()
                        chunkedEnvelope.clear()
                        runCatching { parse(payload) }.onSuccess(emit).onFailure(fail)
                    }
                }
            }

            override fun onError(message: String) {
                fail(QvacWorkerRemoteException(message))
            }

            override fun onComplete() = complete()
        }
    }

    private fun parse(payload: String): JsonObject {
        return json.parseToJsonElement(payload).jsonObject
    }

    private fun asWorkerException(error: Throwable): Throwable {
        return if (error is DeadObjectException) {
            QvacWorkerRemoteException(
                "QVAC worker stopped. Return to the assistant and reconnect.",
            )
        } else {
            error
        }
    }

    companion object {
        suspend fun connect(
            context: Context,
        ): AndroidServiceTransport {
            return suspendCancellableCoroutine { continuation ->
                val applicationContext = context.applicationContext
                lateinit var connection: ServiceConnection
                connection = object : ServiceConnection {
                    override fun onServiceConnected(name: ComponentName, binder: IBinder) {
                        if (continuation.isActive) {
                            continuation.resume(
                                AndroidServiceTransport(
                                    context = applicationContext,
                                    service = IQvacWorkerService.Stub.asInterface(binder),
                                    connection = connection,
                                    json = Json {
                                        ignoreUnknownKeys = true
                                        explicitNulls = false
                                    },
                                    runtimeProfile = AndroidRuntimeProfile.load(applicationContext),
                                ),
                            )
                        }
                    }

                    override fun onServiceDisconnected(name: ComponentName) {
                        if (continuation.isActive) {
                            continuation.resumeWithException(
                                QvacWorkerRemoteException("QVAC worker service disconnected"),
                            )
                        }
                    }
                }
                val bound = applicationContext.bindService(
                    Intent(applicationContext, QvacWorkerService::class.java),
                    connection,
                    Context.BIND_AUTO_CREATE,
                )
                if (!bound) {
                    continuation.resumeWithException(
                        QvacWorkerRemoteException("Unable to bind QVAC worker service"),
                    )
                }
                continuation.invokeOnCancellation {
                    runCatching { applicationContext.unbindService(connection) }
                }
            }
        }
    }
}
