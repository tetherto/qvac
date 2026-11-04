package io.tether.qvac.sdk

import io.tether.qvac.sdk.generated.schema.CloseSessionRequest
import io.tether.qvac.sdk.generated.schema.OpenSessionRequest
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.emitAll
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * A caller session on a shared runtime. It is a [QvacClient] whose every
 * request carries the session id, so `cancel` reaches only this session's
 * requests, `loadModel` takes a lease the session's `unloadModel` releases,
 * and [close] ends the session without shutting the runtime down.
 *
 * Only the owner [QvacClient]'s `close()` stops the runtime, and it ends every
 * session with it.
 */
class QvacSession internal constructor(
    val sessionId: String,
    val name: String?,
    private val owner: QvacClient,
    private val transport: SessionTransport,
    json: Json,
) : QvacClient(transport, json) {
    /** Completes once the worker registered the session. Calls wait for it on their own. */
    val opened: Deferred<Unit> get() = transport.opened

    /** Cancels this session's requests, releases its model leases and ends the handle. */
    override suspend fun close() {
        transport.markClosed()
        try {
            opened.await()
            owner.closeSession(CloseSessionRequest(sessionId = sessionId))
        } finally {
            scope.cancel()
        }
    }
}

/**
 * Stamps every payload with the session id and holds calls until the
 * `openSession` round trip is done. Closing it never closes the inner
 * transport: that is the owner's shutdown.
 */
internal class SessionTransport(
    private val inner: QvacTransport,
    private val sessionId: String,
    val opened: Deferred<Unit>,
) : QvacTransport {
    private var closed = false

    override val runtimeProfile: QvacRuntimeProfile? get() = inner.runtimeProfile

    fun markClosed() {
        closed = true
    }

    // A payload that already names a session (`openSession`, `closeSession`) keeps its own id.
    private suspend fun stamp(payload: JsonObject): JsonObject {
        if (closed) throw QvacSessionClosedException(sessionId)
        opened.await()
        if (closed) throw QvacSessionClosedException(sessionId)
        if (payload.containsKey("sessionId")) return payload
        return JsonObject(payload + ("sessionId" to JsonPrimitive(sessionId)))
    }

    override suspend fun call(payload: JsonObject): JsonObject = inner.call(stamp(payload))

    override fun stream(payload: JsonObject): Flow<JsonObject> = flow {
        emitAll(inner.stream(stamp(payload)))
    }

    override fun duplex(payload: JsonObject, input: Flow<ByteArray>): Flow<JsonObject> = flow {
        emitAll(inner.duplex(stamp(payload), input))
    }

    override suspend fun close() = Unit
}

/** A call on a session handle after its `close()`. Raised locally, before any wire traffic. */
class QvacSessionClosedException(val sessionId: String) :
    QvacFeatureException("Session \"$sessionId\" is closed; open a new session")

/**
 * Opens a caller session and returns its handle at once. The `openSession`
 * round trip runs in the background; calls on the handle wait for it.
 */
fun QvacClient.openSession(name: String? = null): QvacSession {
    val sessionId = qvacRequestId()
    val opened = scope.async {
        openSession(OpenSessionRequest(sessionId = sessionId, name = name))
        Unit
    }
    return QvacSession(sessionId, name, this, SessionTransport(transportForSessions, sessionId, opened), json)
}
