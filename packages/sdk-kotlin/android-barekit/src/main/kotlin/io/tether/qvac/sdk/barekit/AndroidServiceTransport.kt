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
import kotlinx.coroutines.NonCancellable
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
import java.util.concurrent.ConcurrentHashMap
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
    // Each in-flight request registers how to fail itself. When the worker
    // process dies, the callback stub stops delivering results, so the binder's
    // death is the only signal that can unblock a pending call() or close a
    // stream()/duplex() flow.
    private val liveRequests = ConcurrentHashMap.newKeySet<(Throwable) -> Unit>()

    @Volatile
    private var deathCause: Throwable? = null

    private val deathRecipient = IBinder.DeathRecipient {
        val error = QvacWorkerRemoteException(WORKER_STOPPED_MESSAGE)
        deathCause = error
        val pending = liveRequests.toList()
        liveRequests.clear()
        pending.forEach { runCatching { it(error) } }
    }

    init {
        runCatching { service.asBinder().linkToDeath(deathRecipient, 0) }
            .onFailure { deathCause = QvacWorkerRemoteException(WORKER_STOPPED_MESSAGE) }
    }

    override suspend fun call(payload: JsonObject): JsonObject {
        deathCause?.let { throw asWorkerException(it) }
        return suspendCancellableCoroutine { continuation ->
            val terminate: (Throwable) -> Unit = { error ->
                if (continuation.isActive) continuation.resumeWithException(asWorkerException(error))
            }
            liveRequests.add(terminate)
            continuation.invokeOnCancellation { liveRequests.remove(terminate) }
            val callback = unaryCallback(continuation) { liveRequests.remove(terminate) }
            runCatching {
                val text = payload.toString()
                if (text.length <= QvacWorkerService.MAX_BINDER_CHUNK_CHARS) {
                    service.call(text, callback)
                } else {
                    val requestId = chunkRequest(text)
                    service.callAssembled(requestId, callback)
                }
            }.onFailure {
                liveRequests.remove(terminate)
                if (continuation.isActive) continuation.resumeWithException(asWorkerException(it))
            }
        }
    }

    override fun stream(payload: JsonObject): Flow<JsonObject> {
        return callbackFlow {
            deathCause?.let { close(asWorkerException(it)); return@callbackFlow }
            val terminate: (Throwable) -> Unit = { close(asWorkerException(it)) }
            liveRequests.add(terminate)
            // AIDL callbacks are synchronous. Blocking the Binder callback when
            // the Flow buffer is full provides backpressure instead of silently
            // dropping a token when trySend() fails at the default capacity.
            val callback = streamCallback({ trySendBlocking(it) }, { close(it) }, { close() })
            runCatching {
                val text = payload.toString()
                if (text.length <= QvacWorkerService.MAX_BINDER_CHUNK_CHARS) {
                    service.stream(text, callback)
                } else {
                    val requestId = chunkRequest(text)
                    service.streamAssembled(requestId, callback)
                }
            }.onFailure { close(asWorkerException(it)) }
            awaitClose { liveRequests.remove(terminate) }
        }
    }

    override fun duplex(payload: JsonObject, input: Flow<ByteArray>): Flow<JsonObject> {
        return callbackFlow {
            deathCause?.let { close(asWorkerException(it)); return@callbackFlow }
            val requestId = UUID.randomUUID().toString()
            val terminate: (Throwable) -> Unit = { close(asWorkerException(it)) }
            liveRequests.add(terminate)
            val callback = streamCallback({ trySendBlocking(it) }, { close(it) }, { close() })
            runCatching {
                val text = payload.toString()
                if (text.length <= QvacWorkerService.MAX_BINDER_CHUNK_CHARS) {
                    service.duplex(requestId, text, callback)
                } else {
                    chunkRequest(text, requestId)
                    service.duplexAssembled(requestId, callback)
                }
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
                liveRequests.remove(terminate)
                inputJob.cancel()
                runCatching { service.cancelDuplex(requestId) }
            }
        }
    }

    override suspend fun close() {
        withContext(NonCancellable + Dispatchers.IO) {
            runCatching { service.asBinder().unlinkToDeath(deathRecipient, 0) }
            runCatching { service.close() }
            runCatching { context.unbindService(connection) }
        }
    }

    // A request JSON envelope crosses the boundary as a single AIDL String.
    // Inline base64 (image/audio inputs) can pass Binder's ~1 MiB transaction
    // limit, so send an oversized envelope through the same chunk channel the
    // service uses for replies, then dispatch by requestId. For duplex the id
    // also keys the input stream; request assembly completes before any input
    // chunk arrives, so the two never overlap.
    private fun chunkRequest(
        text: String,
        requestId: String = UUID.randomUUID().toString(),
    ): String {
        var offset = 0
        while (offset < text.length) {
            val end = (offset + QvacWorkerService.MAX_BINDER_CHUNK_CHARS).coerceAtMost(text.length)
            service.requestChunk(requestId, text.substring(offset, end), end == text.length)
            offset = end
        }
        return requestId
    }

    private fun unaryCallback(
        continuation: CancellableContinuation<JsonObject>,
        onSettle: () -> Unit,
    ): IQvacWorkerCallback {
        return object : IQvacWorkerCallback.Stub() {
            private val chunkedEnvelope = StringBuilder()

            override fun onNext(payload: String) {
                onSettle()
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
                        onSettle()
                        continuation.resume(parse(payload))
                    }
                }
            }

            override fun onError(message: String) {
                onSettle()
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
            QvacWorkerRemoteException(WORKER_STOPPED_MESSAGE)
        } else {
            error
        }
    }

    companion object {
        private const val WORKER_STOPPED_MESSAGE =
            "QVAC worker stopped. Return to the assistant and reconnect."

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
