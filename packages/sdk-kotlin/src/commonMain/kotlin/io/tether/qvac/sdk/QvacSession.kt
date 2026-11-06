package io.tether.qvac.sdk

import io.tether.qvac.sdk.generated.schema.CloseSessionRequest
import io.tether.qvac.sdk.generated.schema.OpenSessionRequest
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.emitAll
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.flow.update
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlin.concurrent.Volatile

/**
 * A caller session on a shared runtime. It is a [QvacClient] whose every
 * request carries the session id, so `cancel` reaches only this session's
 * requests, `loadModel` takes a lease the session's `unloadModel` releases,
 * and [close] ends the session without shutting the runtime down.
 *
 * Only the owner [QvacClient]'s `close()` stops the runtime, and it ends every
 * session with it. The operations that change the runtime for every session
 * (`suspend`, `resume`, `deleteCache`, `startRpcServer`, `stopRpcServer`)
 * throw [QvacOwnerOnlyException] on a session.
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

    /**
     * Whether this session loaded `modelId` and has not unloaded it. Stays true
     * after the session ends: a call naming such a model then fails with
     * [QvacModelHandleInvalidatedException] instead of [QvacSessionClosedException].
     */
    fun isModelHeld(modelId: String): Boolean = transport.isModelHeld(modelId)

    /**
     * Cancels this session's requests, releases its model leases and ends the
     * handle. Throws [QvacSessionClosedException] when the session already
     * ended, by its own close, the owner's close or the loss of the worker.
     */
    override suspend fun close() {
        transport.ended?.let { throw QvacSessionClosedException(sessionId, it) }
        transport.markEnded("closed")
        owner.unregisterSession(transport)
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
    /** Why the session ended, or null while it is usable. The first reason is kept. */
    @Volatile
    var ended: String? = null
        private set

    // Model ids this session loaded and has not unloaded, kept after the session
    // ends so a call naming one gets the model error, not the session error.
    private val heldModels = MutableStateFlow<Set<String>>(emptySet())

    override val runtimeProfile: QvacRuntimeProfile? get() = inner.runtimeProfile

    fun markEnded(reason: String) {
        if (ended == null) ended = reason
    }

    fun isModelHeld(modelId: String): Boolean = modelId in heldModels.value

    // The handle's id replaces any id the payload carries, so a caller cannot send a
    // request as another session. Only the session methods themselves name the
    // session they act on.
    private suspend fun stamp(payload: JsonObject): JsonObject {
        ended?.let { throw endedError(payload, it) }
        val type = payload["type"]?.jsonPrimitive?.content
        if (type != null && type in OWNER_ONLY_OPERATIONS) throw QvacOwnerOnlyException(type, sessionId)
        opened.await()
        ended?.let { throw endedError(payload, it) }
        if (type == "openSession" || type == "closeSession") return payload
        return JsonObject(payload + ("sessionId" to JsonPrimitive(sessionId)))
    }

    private fun endedError(payload: JsonObject, reason: String): QvacFeatureException {
        val modelId = payload["modelId"]?.jsonPrimitive?.contentOrNull
        if (modelId != null && isModelHeld(modelId)) {
            return QvacModelHandleInvalidatedException(modelId, sessionId, reason)
        }
        return QvacSessionClosedException(sessionId, reason)
    }

    // A `loadModel` reply names the model this session now holds; an `unloadModel`
    // reply that released the lease drops it. Both arrive on the unary call and,
    // for a load with progress, as the last frame of the stream.
    private fun trackHeldModel(request: JsonObject, response: JsonObject) {
        val type = request["type"]?.jsonPrimitive?.content
        if (response["type"]?.jsonPrimitive?.content != type) return
        if (response["success"]?.jsonPrimitive?.booleanOrNull == false) return
        when (type) {
            "loadModel" -> response["modelId"]?.jsonPrimitive?.contentOrNull?.let { modelId ->
                heldModels.update { it + modelId }
            }
            "unloadModel" -> {
                if (response["released"]?.jsonPrimitive?.booleanOrNull == false) return
                request["modelId"]?.jsonPrimitive?.contentOrNull?.let { modelId ->
                    heldModels.update { it - modelId }
                }
            }
        }
    }

    override suspend fun call(payload: JsonObject): JsonObject {
        val stamped = stamp(payload)
        return inner.call(stamped).also { trackHeldModel(stamped, it) }
    }

    override fun stream(payload: JsonObject): Flow<JsonObject> = flow {
        val stamped = stamp(payload)
        emitAll(inner.stream(stamped).onEach { trackHeldModel(stamped, it) })
    }

    override fun duplex(payload: JsonObject, input: Flow<ByteArray>): Flow<JsonObject> = flow {
        emitAll(inner.duplex(stamp(payload), input))
    }

    override suspend fun close() = Unit
}

/**
 * A call on a session handle after the session ended. Raised locally, before any
 * wire traffic. [reason] is `closed` after the handle's own close, `shutdown`
 * after the owner's close and `crashed` after the worker was lost.
 */
class QvacSessionClosedException(val sessionId: String, val reason: String = "closed") :
    QvacFeatureException("Session \"$sessionId\" is no longer usable ($reason); open a new session")

/**
 * A call naming a model this session loaded, after the session ended. The
 * model is gone with the session: load it again through a new session.
 */
class QvacModelHandleInvalidatedException(val modelId: String, val sessionId: String, val reason: String) :
    QvacFeatureException(
        "Model \"$modelId\" is no longer loaded: session \"$sessionId\" that held it is no longer usable ($reason); load it again",
    )

/**
 * Operations that change the shared runtime for every session. The worker
 * refuses them from a session too; the session transport refuses them first,
 * before any wire traffic, like a call on an ended session.
 */
internal val OWNER_ONLY_OPERATIONS = setOf("suspend", "resume", "deleteCache", "startRpcServer", "stopRpcServer")

/** A runtime-wide operation called on a session handle; only the owner client may call it. */
class QvacOwnerOnlyException(val operation: String, val sessionId: String) :
    QvacFeatureException("Operation \"$operation\" is reserved for the runtime owner; session \"$sessionId\" cannot call it")

/** `openSession` called on a session handle instead of the owner client. */
class QvacNestedSessionException(val sessionId: String) :
    QvacFeatureException("Session \"$sessionId\" cannot open a session; open it on the owner client")

/**
 * Opens a caller session and returns its handle at once. The `openSession`
 * round trip runs in the background; calls on the handle wait for it.
 */
fun QvacClient.openSession(name: String? = null): QvacSession {
    // A session's transport stamps its own id over every call, so a session opened
    // on top of another would run as its parent and never be closable on its own.
    if (this is QvacSession) throw QvacNestedSessionException(sessionId)
    val sessionId = qvacRequestId()
    val opened = scope.async {
        openSession(OpenSessionRequest(sessionId = sessionId, name = name))
        Unit
    }
    val transport = SessionTransport(transportForSessions, sessionId, opened)
    registerSession(transport)
    return QvacSession(sessionId, name, this, transport, json)
}
