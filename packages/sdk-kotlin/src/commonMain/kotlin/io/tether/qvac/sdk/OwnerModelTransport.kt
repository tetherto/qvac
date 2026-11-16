package io.tether.qvac.sdk

import kotlinx.coroutines.Deferred
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.emitAll
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.flow.update
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive

/**
 * The owner client's transport. It records the models the owner loads, and
 * once the runtime stops, by the owner's close or the loss of the worker, an
 * owner call naming one of them fails locally with
 * [QvacModelHandleInvalidatedException] until a load returns that id again.
 * Session calls pass through untouched: their session transport tracks them.
 */
internal class OwnerModelTransport(private val inner: QvacTransport) : QvacTransport {
    // Model ids the owner loaded on the running runtime and has not unloaded.
    private val ownerModels = MutableStateFlow<Set<String>>(emptySet())

    // Model ids the owner loaded on a runtime that has since stopped, with why it stopped.
    private val invalidModels = MutableStateFlow<Map<String, String>>(emptyMap())

    override val runtimeProfile: QvacRuntimeProfile? get() = inner.runtimeProfile

    override val lost: Deferred<Unit>? get() = inner.lost

    /** The runtime stopped: every model the owner held is gone with it. */
    fun invalidate(reason: String) {
        val held = ownerModels.value
        ownerModels.update { it - held }
        invalidModels.update { invalid -> invalid + held.associateWith { reason } }
    }

    private fun check(payload: JsonObject) {
        if (payload.containsKey("sessionId")) return
        if (payload["type"]?.jsonPrimitive?.contentOrNull in REQUESTS_WITHOUT_MODEL_HANDLE) return
        val modelId = payload["modelId"]?.jsonPrimitive?.contentOrNull ?: return
        val reason = invalidModels.value[modelId] ?: return
        throw QvacModelHandleInvalidatedException(modelId, OWNER_HANDLE_ID, reason)
    }

    private fun track(request: JsonObject, response: JsonObject) {
        if (request.containsKey("sessionId")) return
        val (modelId, held) = heldModelChange(request, response) ?: return
        if (held) {
            invalidModels.update { it - modelId }
            ownerModels.update { it + modelId }
        } else {
            ownerModels.update { it - modelId }
        }
    }

    override suspend fun call(payload: JsonObject): JsonObject {
        check(payload)
        return inner.call(payload).also { track(payload, it) }
    }

    override fun stream(payload: JsonObject): Flow<JsonObject> = flow {
        check(payload)
        emitAll(inner.stream(payload).onEach { track(payload, it) })
    }

    override fun duplex(payload: JsonObject, input: Flow<ByteArray>): Flow<JsonObject> = flow {
        check(payload)
        emitAll(inner.duplex(payload, input))
    }

    override suspend fun close() = inner.close()
}

// Owner requests whose `modelId` does not need the model loaded: `deleteCache`
// uses it only to locate cache files on disk, and a `cancel` by model on a
// runtime that no longer has the model finds nothing to cancel.
private val REQUESTS_WITHOUT_MODEL_HANDLE = setOf("deleteCache", "cancel")
