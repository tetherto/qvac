package io.tether.qvac.sdk

import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.getAndUpdate
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlin.concurrent.Volatile

/**
 * The owner of a runtime. Besides every operation a [QvacSession] may call,
 * it opens sessions, calls the operations that change the runtime for every
 * session, and shuts the runtime down with [close].
 */
open class QvacClient private constructor(
    private val ownerModels: OwnerModelTransport,
    json: Json,
) : QvacCaller(ownerModels, json) {
    constructor(
        transport: QvacTransport,
        json: Json = Json {
            ignoreUnknownKeys = true
            explicitNulls = true
        },
    ) : this(OwnerModelTransport(transport), json)

    /** The transport a session handle wraps; see [openSession]. */
    internal val transportForSessions: QvacTransport get() = ownerModels

    // The sessions opened on this client that have not ended. They end with
    // their own close, the owner's close, and the worker when the transport can
    // report its loss.
    private val sessions = MutableStateFlow<List<SessionTransport>>(emptyList())

    // Why the runtime ended, kept so a session registered after the end is
    // ended too instead of reaching a dead transport.
    @Volatile
    private var ended: String? = null

    init {
        ownerModels.lost?.let { lost ->
            scope.launch {
                lost.await()
                endRuntime("crashed")
            }
        }
    }

    internal fun registerSession(session: SessionTransport) {
        sessions.update { it + session }
        // `endRuntime` sets `ended` before it takes the list, so a registration
        // that missed the list sees `ended` here.
        ended?.let { reason ->
            session.markEnded(reason)
            unregisterSession(session)
        }
    }

    internal fun unregisterSession(session: SessionTransport) {
        sessions.update { it - session }
    }

    internal val trackedSessionCount: Int get() = sessions.value.size

    // The first reason a session or an owner model sees is kept.
    private fun endRuntime(reason: String) {
        if (ended == null) ended = reason
        sessions.getAndUpdate { emptyList() }.forEach { it.markEnded(reason) }
        ownerModels.invalidate(reason)
    }

    /** Owner shutdown: ends every session opened on this client, then stops the transport. */
    override suspend fun close() {
        endRuntime("shutdown")
        try {
            ownerModels.close()
        } finally {
            scope.cancel()
        }
    }
}
