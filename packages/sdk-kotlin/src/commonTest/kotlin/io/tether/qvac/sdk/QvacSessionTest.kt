package io.tether.qvac.sdk

import io.tether.qvac.sdk.generated.schema.CancelRequest
import io.tether.qvac.sdk.generated.schema.CancelRequestRequest
import io.tether.qvac.sdk.generated.schema.UnloadModelRequest
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import kotlinx.coroutines.yield
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class QvacSessionTest {
    @Test
    fun everyCallCarriesTheSessionIdAfterTheOpenRoundTrip() = runTest {
        val transport = SessionRecordingTransport(
            stream = flowOf(buildJsonObject { put("type", "classify"); put("done", true) }),
        )
        val client = QvacClient(transport)
        val session = client.openSession(name = "harness")

        session.heartbeat()
        session.stream(buildJsonObject { put("type", "classify") }).toList()
        session.cancel(CancelRequest.Request(CancelRequestRequest(requestId = "r-1")))
        session.unloadModel(UnloadModelRequest(modelId = "m-1"))

        assertEquals(
            listOf("openSession", "heartbeat", "classify", "cancel", "unloadModel"),
            transport.requests.map { it.type() },
        )
        val open = transport.requests[0]
        assertEquals("harness", open["name"]?.jsonPrimitive?.content)
        for (request in transport.requests) {
            assertEquals(session.sessionId, request["sessionId"]?.jsonPrimitive?.content, request.type())
        }
    }

    @Test
    fun aPayloadCannotNameAnotherSession() = runTest {
        val transport = SessionRecordingTransport()
        val session = QvacClient(transport).openSession()

        session.cancel(CancelRequest.Request(CancelRequestRequest(requestId = "r-1", sessionId = "owner")))
        session.call(buildJsonObject { put("type", "heartbeat"); put("sessionId", "other") })

        for (request in transport.requests.drop(1)) {
            assertEquals(session.sessionId, request["sessionId"]?.jsonPrimitive?.content, request.type())
        }
    }

    @Test
    fun ownerOnlyOperationsSentUntypedThroughASessionAreRefusedBeforeTheWire() = runTest {
        val transport = SessionRecordingTransport()
        val session = QvacClient(transport).openSession()
        session.opened.await()

        val ownerOnly = listOf(
            "suspend", "resume", "deleteCache", "startRpcServer", "stopRpcServer", "openSession", "closeSession",
        )
        for (type in ownerOnly) {
            val error = assertFailsWith<QvacOwnerOnlyException> { session.call(buildJsonObject { put("type", type) }) }
            assertEquals(type, error.operation)
            assertEquals(session.sessionId, error.sessionId)
        }
        assertFailsWith<QvacOwnerOnlyException> { session.stream(buildJsonObject { put("type", "suspend") }).toList() }
        assertEquals(listOf("openSession"), transport.requests.map { it.type() }, "nothing reached the wire")

        session.call(buildJsonObject { put("type", "state") })
        assertEquals("state", transport.requests.last().type(), "a read-only runtime call still goes through")
    }

    @Test
    fun closeSendsCloseSessionAndLeavesTheTransportOpen() = runTest {
        val transport = SessionRecordingTransport()
        val session = QvacClient(transport).openSession()

        session.close()

        val close = transport.requests.last()
        assertEquals("closeSession", close.type())
        assertEquals(session.sessionId, close["sessionId"]?.jsonPrimitive?.content)
        assertEquals(0, transport.closeCalls, "a session close is not the owner shutdown")
        assertFailsWith<QvacSessionClosedException> { session.heartbeat() }
    }

    @Test
    fun aCloseCancelledWhileTheOpenIsPendingStillClosesTheWorkerSession() = runTest {
        val openGate = CompletableDeferred<Unit>()
        val transport = SessionRecordingTransport(openGate = openGate)
        val session = QvacClient(transport).openSession()
        val closing = launch { session.close() }
        yield()

        closing.cancel()
        openGate.complete(Unit)
        closing.join()

        assertEquals(listOf("openSession", "closeSession"), transport.requests.map { it.type() })
        assertEquals("closed", assertFailsWith<QvacSessionClosedException> { session.heartbeat() }.reason)
    }

    @Test
    fun theOwnerCloseEndsEverySessionBeforeTheTransport() = runTest {
        val sessions = mutableListOf<QvacSession>()
        val reasonsAtTransportClose = mutableListOf<String?>()
        val transport = SessionRecordingTransport(
            onClose = {
                for (session in sessions) {
                    reasonsAtTransportClose += runCatching { session.heartbeat() }
                        .exceptionOrNull()
                        .let { (it as? QvacSessionClosedException)?.reason }
                }
            },
        )
        val client = QvacClient(transport)
        sessions += client.openSession()
        sessions += client.openSession()
        sessions.forEach { it.opened.await() }

        client.close()

        assertEquals(1, transport.closeCalls)
        assertEquals(listOf<String?>("shutdown", "shutdown"), reasonsAtTransportClose)
        assertEquals(0, client.trackedSessionCount, "the client let the ended sessions go")
        assertEquals("shutdown", assertFailsWith<QvacSessionClosedException> { sessions[0].close() }.reason)
        assertEquals(
            listOf("openSession", "openSession"),
            transport.requests.map { it.type() },
            "no closeSession after the owner shut down",
        )
    }

    @Test
    fun aRefusedOpenIsNotKeptAndTheHandleKeepsItsError() = runTest {
        val openGate = CompletableDeferred<Unit>()
        val client = QvacClient(SessionRecordingTransport(openGate = openGate))
        val session = client.openSession()
        assertEquals(1, client.trackedSessionCount)

        openGate.completeExceptionally(IllegalStateException("name too long"))
        assertFailsWith<IllegalStateException> { session.opened.await() }

        assertEquals(0, client.trackedSessionCount, "the client let the session go")
        assertFailsWith<IllegalStateException> { session.heartbeat() }
    }

    @Test
    fun aLostWorkerEndsEverySession() = runTest {
        val lost = CompletableDeferred<Unit>()
        val transport = SessionRecordingTransport(lost = lost)
        val client = QvacClient(transport)
        val first = client.openSession()
        val second = client.openSession()
        first.opened.await()
        second.opened.await()

        lost.complete(Unit)

        assertEquals("crashed", awaitSessionEnd(first).reason)
        assertEquals("crashed", awaitSessionEnd(second).reason)
        assertEquals(0, client.trackedSessionCount, "the client let the ended sessions go")
        assertEquals(0, transport.closeCalls, "worker loss is not an owner close")
    }

    @Test
    fun aModelLoadedThroughTheSessionNamesItsOwnErrorAfterTheSessionEnds() = runTest {
        val transport = SessionRecordingTransport()
        val client = QvacClient(transport)
        val session = client.openSession()
        assertEquals(false, session.isModelHeld("m-1"))

        session.call(buildJsonObject { put("type", "loadModel"); put("modelSrc", "/models/x.gguf"); put("modelType", "llamacpp-completion") })
        assertEquals(true, session.isModelHeld("m-1"), "a load through the session is recorded")
        session.unloadModel(UnloadModelRequest(modelId = "m-1"))
        assertEquals(false, session.isModelHeld("m-1"), "an unload releases it")
        session.call(buildJsonObject { put("type", "loadModel"); put("modelSrc", "/models/x.gguf"); put("modelType", "llamacpp-completion") })

        client.close()

        val held = assertFailsWith<QvacModelHandleInvalidatedException> {
            session.call(buildJsonObject { put("type", "embed"); put("modelId", "m-1"); put("text", "x") })
        }
        assertEquals("m-1", held.modelId)
        assertEquals("shutdown", held.reason)
        assertEquals(true, session.isModelHeld("m-1"), "the handle still reports what it held")
        val other = assertFailsWith<QvacSessionClosedException> {
            session.call(buildJsonObject { put("type", "embed"); put("modelId", "m-2"); put("text", "x") })
        }
        assertEquals("shutdown", other.reason)
    }

    @Test
    fun aClosedSessionIsNotEndedAgainByTheOwnerClose() = runTest {
        val transport = SessionRecordingTransport()
        val client = QvacClient(transport)
        val session = client.openSession()
        session.close()

        client.close()

        assertEquals("closed", assertFailsWith<QvacSessionClosedException> { session.heartbeat() }.reason)
    }

    @Test
    fun anOwnerModelIsRefusedLocallyAfterTheWorkerIsLostUntilItIsLoadedAgain() = runTest {
        val lost = CompletableDeferred<Unit>()
        val transport = SessionRecordingTransport(lost = lost)
        val client = QvacClient(transport)
        client.call(loadModel())
        val embed = buildJsonObject { put("type", "embed"); put("modelId", "m-1"); put("text", "x") }

        lost.complete(Unit)

        val error = awaitOwnerModelInvalidated(client, embed)
        assertEquals("m-1", error.modelId)
        assertEquals(OWNER_HANDLE_ID, error.sessionId)
        assertEquals("crashed", error.reason)
        val sent = transport.requests.size
        assertFailsWith<QvacModelHandleInvalidatedException> { client.call(embed) }
        assertEquals(sent, transport.requests.size, "the refused call never reaches the wire")

        client.call(buildJsonObject { put("type", "embed"); put("modelId", "m-2"); put("text", "x") })
        assertEquals("embed", transport.requests.last().type(), "an id the owner never loaded still goes through")
        client.call(buildJsonObject { put("type", "deleteCache"); put("modelId", "m-1"); put("kvCacheKey", "k") })
        assertEquals("deleteCache", transport.requests.last().type(), "deleteCache does not need the model loaded")
        client.call(buildJsonObject { put("type", "cancel"); put("operation", "inference"); put("modelId", "m-1") })
        assertEquals("cancel", transport.requests.last().type(), "nor does a cancel by model")
        client.call(loadModel())
        client.call(embed)
        assertEquals("embed", transport.requests.last().type(), "a new load of the same id makes it usable again")
    }

    @Test
    fun theOwnerCloseInvalidatesOnlyTheModelsTheOwnerStillHeld() = runTest {
        val transport = SessionRecordingTransport()
        val client = QvacClient(transport)
        client.call(loadModel())
        client.unloadModel(UnloadModelRequest(modelId = "m-1"))
        client.call(loadModel(modelId = "m-2"))

        client.close()

        val error = assertFailsWith<QvacModelHandleInvalidatedException> {
            client.call(buildJsonObject { put("type", "embed"); put("modelId", "m-2"); put("text", "x") })
        }
        assertEquals("shutdown", error.reason)
        client.call(buildJsonObject { put("type", "embed"); put("modelId", "m-1"); put("text", "x") })
        assertEquals("m-1", transport.requests.last()["modelId"]?.jsonPrimitive?.content, "an unloaded id is a plain unknown id")
    }

    private fun loadModel(modelId: String = "m-1") = buildJsonObject {
        put("type", "loadModel")
        put("modelSrc", "/models/x.gguf")
        put("modelType", "llamacpp-completion")
        put("expect", modelId)
    }

    private suspend fun awaitOwnerModelInvalidated(
        client: QvacClient,
        payload: JsonObject,
    ): QvacModelHandleInvalidatedException {
        repeat(200) {
            try {
                client.call(payload)
            } catch (error: QvacModelHandleInvalidatedException) {
                return error
            }
            withContext(Dispatchers.Default) { delay(10) }
        }
        throw AssertionError("the owner model was not invalidated after the worker was lost")
    }

    // The worker watch runs on the client's own scope, outside the test
    // dispatcher, so the end is observed by retrying on a real clock.
    private suspend fun awaitSessionEnd(session: QvacSession): QvacSessionClosedException {
        repeat(200) {
            try {
                session.heartbeat()
            } catch (error: QvacSessionClosedException) {
                return error
            }
            withContext(Dispatchers.Default) { delay(10) }
        }
        throw AssertionError("the session did not end after the worker was lost")
    }

    private fun JsonObject.type() = this["type"]?.jsonPrimitive?.content
}

private class SessionRecordingTransport(
    private val stream: Flow<JsonObject> = emptyFlow(),
    override val lost: CompletableDeferred<Unit>? = null,
    private val openGate: CompletableDeferred<Unit>? = null,
    private val onClose: suspend () -> Unit = {},
) : QvacTransport {
    // Sessions open on the client's scope, off the test dispatcher, so calls
    // arrive from several threads at once.
    private val recorded = MutableStateFlow<List<JsonObject>>(emptyList())
    private val closes = MutableStateFlow(0)
    val requests: List<JsonObject> get() = recorded.value
    val closeCalls: Int get() = closes.value

    override suspend fun call(payload: JsonObject): JsonObject {
        recorded.update { it + payload }
        return when (payload["type"]?.jsonPrimitive?.content) {
            "openSession" -> {
                openGate?.await()
                buildJsonObject {
                    put("type", "openSession")
                    put("success", true)
                    put("sessionId", payload["sessionId"]?.jsonPrimitive?.content ?: "")
                }
            }
            "closeSession" -> buildJsonObject {
                put("type", "closeSession")
                put("success", true)
                put("sessionId", payload["sessionId"]?.jsonPrimitive?.content ?: "")
                put("cancelled", 0)
            }
            "heartbeat" -> buildJsonObject {
                put("type", "heartbeat")
                put("number", 1)
            }
            "cancel" -> buildJsonObject {
                put("type", "cancel")
                put("success", true)
                put("cancelled", 0)
            }
            "unloadModel" -> buildJsonObject {
                put("type", "unloadModel")
                put("success", true)
                put("hasActiveModels", true)
            }
            "loadModel" -> buildJsonObject {
                put("type", "loadModel")
                put("success", true)
                put("modelId", payload["expect"]?.jsonPrimitive?.content ?: "m-1")
            }
            else -> buildJsonObject { put("type", payload["type"]?.jsonPrimitive?.content ?: "") }
        }
    }

    override fun stream(payload: JsonObject): Flow<JsonObject> {
        recorded.update { it + payload }
        return stream
    }

    override fun duplex(payload: JsonObject, input: Flow<ByteArray>): Flow<JsonObject> {
        recorded.update { it + payload }
        return stream
    }

    override suspend fun close() {
        closes.update { it + 1 }
        onClose()
    }
}
