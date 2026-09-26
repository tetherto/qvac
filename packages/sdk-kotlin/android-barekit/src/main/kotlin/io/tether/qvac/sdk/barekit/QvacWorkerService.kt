package io.tether.qvac.sdk.barekit

import android.app.Service
import android.content.Intent
import android.os.IBinder
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import java.util.concurrent.ConcurrentHashMap

/**
 * Hosts BareKit in a dedicated Android process.
 *
 * The Binder surface carries JSON envelopes and byte chunks, so the UI process
 * never loads BareKit or native inference addons. The service is non-exported
 * by the library manifest; only the owning application can bind to it.
 */
class QvacWorkerService : Service() {
    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val json = Json {
        ignoreUnknownKeys = true
        explicitNulls = false
    }
    private val worker = CompletableDeferred<AndroidBareKitTransport>()
    private class DuplexInput {
        val channel = Channel<ByteArray>(capacity = 8)
        lateinit var job: Job

        // A synchronous Binder acknowledgement provides bounded backpressure and
        // preserves input/EOF order. Never run this on the service's main thread.
        @Synchronized
        fun send(chunk: ByteArray, endOfInput: Boolean) {
            require(chunk.size <= MAX_DUPLEX_CHUNK_BYTES) { "Duplex chunk exceeds Binder input limit" }
            runBlocking {
                if (chunk.isNotEmpty()) channel.send(chunk)
                if (endOfInput) channel.close()
            }
        }

        fun cancel() {
            channel.cancel() // Releases a Binder sender even when its queue is full.
            job.cancel()
        }
    }

    private val duplexInputs = ConcurrentHashMap<String, DuplexInput>()

    // Oversized request envelopes arrive in ordered chunks, then a *Assembled
    // call reads and removes the completed payload.
    private val requestAssembly = ConcurrentHashMap<String, StringBuilder>()

    private val binder = object : IQvacWorkerService.Stub() {
        override fun call(payload: String, callback: IQvacWorkerCallback) = dispatchCall(payload, callback)

        override fun stream(payload: String, callback: IQvacWorkerCallback) = dispatchStream(payload, callback)

        override fun requestChunk(requestId: String, chunk: String, endOfRequest: Boolean) {
            val builder = requestAssembly.getOrPut(requestId) { StringBuilder() }
            synchronized(builder) { builder.append(chunk) }
        }

        override fun callAssembled(requestId: String, callback: IQvacWorkerCallback) =
            dispatchCall(takeAssembledRequest(requestId), callback)

        override fun streamAssembled(requestId: String, callback: IQvacWorkerCallback) =
            dispatchStream(takeAssembledRequest(requestId), callback)

        override fun duplexAssembled(requestId: String, callback: IQvacWorkerCallback) =
            dispatchDuplex(requestId, takeAssembledRequest(requestId), callback)

        override fun duplex(
            requestId: String,
            payload: String,
            callback: IQvacWorkerCallback,
        ) = dispatchDuplex(requestId, payload, callback)

        override fun duplexChunk(requestId: String, chunk: ByteArray, endOfInput: Boolean) {
            val input = duplexInputs[requestId]
                ?: throw IllegalStateException("Duplex request is not active")
            input.send(chunk, endOfInput)
        }

        override fun cancelDuplex(requestId: String) {
            duplexInputs.remove(requestId)?.cancel()
        }

        override fun close() {
            duplexInputs.values.forEach(DuplexInput::cancel)
            serviceScope.launch {
                worker.await().close()
                stopSelf()
            }
        }
    }

    private fun takeAssembledRequest(requestId: String): String {
        val builder = requestAssembly.remove(requestId)
            ?: throw IllegalStateException("Assembled request is not available")
        return builder.toString()
    }

    private fun dispatchCall(payload: String, callback: IQvacWorkerCallback) {
        serviceScope.launch {
            runRpc(callback) {
                sendEnvelope(callback, worker.await().call(parse(payload)).toString())
            }
        }
    }

    private fun dispatchStream(payload: String, callback: IQvacWorkerCallback) {
        serviceScope.launch {
            runRpc(callback) {
                worker.await().stream(parse(payload)).collect { response ->
                    sendEnvelope(callback, response.toString())
                }
            }
        }
    }

    private fun dispatchDuplex(
        requestId: String,
        payload: String,
        callback: IQvacWorkerCallback,
    ) {
        val input = DuplexInput()
        input.job = serviceScope.launch(start = CoroutineStart.LAZY) {
            try {
                runRpc(callback) {
                    worker.await().duplex(parse(payload), input.channel.receiveAsFlow()).collect { response ->
                        sendEnvelope(callback, response.toString())
                    }
                }
            } finally {
                input.channel.cancel()
                duplexInputs.remove(requestId, input)
            }
        }
        // Register before returning to Binder: the caller may send immediately.
        if (duplexInputs.putIfAbsent(requestId, input) != null) {
            input.cancel()
            throw IllegalArgumentException("Duplicate duplex request ID")
        }
        input.job.start()
    }

    override fun onCreate() {
        super.onCreate()
        serviceScope.launch {
            runCatching {
                AndroidBareKitTransport.connect(applicationContext)
            }.onSuccess(worker::complete).onFailure(worker::completeExceptionally)
        }
    }

    override fun onBind(intent: Intent?): IBinder = binder

    override fun onDestroy() {
        duplexInputs.values.forEach(DuplexInput::cancel)
        duplexInputs.clear()
        requestAssembly.clear()
        serviceScope.launch {
            runCatching {
                if (worker.isCompleted) worker.await().close()
            }
            serviceScope.coroutineContext.cancel()
        }
        super.onDestroy()
    }

    private suspend fun runRpc(callback: IQvacWorkerCallback, operation: suspend () -> Unit) {
        try {
            operation()
            callback.onComplete()
        } catch (error: CancellationException) {
            throw error
        } catch (error: Throwable) {
            callback.onError(error.message ?: "QVAC worker request failed")
        }
    }

    /** Binder's transaction buffer is shared and capped near 1 MiB; large JSON is fragmented. */
    private fun sendEnvelope(callback: IQvacWorkerCallback, payload: String) {
        if (payload.length <= MAX_BINDER_CHUNK_CHARS) {
            callback.onNext(payload)
            return
        }
        var offset = 0
        while (offset < payload.length) {
            val end = (offset + MAX_BINDER_CHUNK_CHARS).coerceAtMost(payload.length)
            callback.onChunk(payload.substring(offset, end), end == payload.length)
            offset = end
        }
    }

    private fun parse(payload: String): JsonObject {
        return json.parseToJsonElement(payload).jsonObject
    }

    internal companion object {
        // AIDL strings are UTF-16. 64K chars stays far below Binder's aggregate 1 MiB limit.
        const val MAX_BINDER_CHUNK_CHARS = 64 * 1024
        const val MAX_DUPLEX_CHUNK_BYTES = 64 * 1024
    }
}
