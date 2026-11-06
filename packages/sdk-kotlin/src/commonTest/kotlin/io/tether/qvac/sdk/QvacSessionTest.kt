package io.tether.qvac.sdk

import io.tether.qvac.sdk.generated.schema.CancelRequest
import io.tether.qvac.sdk.generated.schema.CancelRequestRequest
import io.tether.qvac.sdk.generated.schema.CloseSessionRequest
import io.tether.qvac.sdk.generated.schema.OpenSessionRequest
import io.tether.qvac.sdk.generated.schema.SuspendRequest
import io.tether.qvac.sdk.generated.schema.UnloadModelRequest
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull

class QvacSessionTest {
    @Test
    fun everyCallCarriesTheSessionIdAfterTheOpenRoundTrip() = runTest {
        val transport = SessionRecordingTransport()
        val client = QvacClient(transport)
        val session = client.openSession(name = "harness")

        session.heartbeat()

        assertEquals(listOf("openSession", "heartbeat"), transport.requests.map { it.type() })
        val open = transport.requests[0]
        assertEquals(session.sessionId, open["sessionId"]?.jsonPrimitive?.content)
        assertEquals("harness", open["name"]?.jsonPrimitive?.content)
        assertNull(open["sessionId"]?.let { null }, "the open request itself names the session once")
        assertEquals(session.sessionId, transport.requests[1]["sessionId"]?.jsonPrimitive?.content)
    }

    @Test
    fun streamsAndTypedCallsAreStampedToo() = runTest {
        val transport = SessionRecordingTransport(
            stream = flowOf(buildJsonObject { put("type", "classify"); put("done", true) }),
        )
        val session = QvacClient(transport).openSession()

        session.stream(buildJsonObject { put("type", "classify") }).toList()
        session.cancel(CancelRequest.Request(CancelRequestRequest(requestId = "r-1")))
        session.unloadModel(UnloadModelRequest(modelId = "m-1"))

        for (request in transport.requests.drop(1)) {
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
    fun runtimeWideOperationsAreRefusedOnASessionBeforeTheWire() = runTest {
        val transport = SessionRecordingTransport()
        val session = QvacClient(transport).openSession()
        session.opened.await()

        for (type in listOf("suspend", "resume", "deleteCache", "startRpcServer", "stopRpcServer")) {
            val error = assertFailsWith<QvacOwnerOnlyException> { session.call(buildJsonObject { put("type", type) }) }
            assertEquals(type, error.operation)
            assertEquals(session.sessionId, error.sessionId)
        }
        assertFailsWith<QvacOwnerOnlyException> { session.`suspend`(SuspendRequest()) }
        assertFailsWith<QvacOwnerOnlyException> { session.closeSession(CloseSessionRequest(sessionId = "other")) }
        assertFailsWith<QvacOwnerOnlyException> { session.openSession(OpenSessionRequest(sessionId = "other")) }
        assertEquals(listOf("openSession"), transport.requests.map { it.type() }, "nothing reached the wire")

        session.call(buildJsonObject { put("type", "state") })
        assertEquals("state", transport.requests.last().type(), "a read-only runtime call still goes through")
    }

    @Test
    fun aSessionCannotOpenANestedSession() = runTest {
        val transport = SessionRecordingTransport()
        val session = QvacClient(transport).openSession()
        session.opened.await()

        assertFailsWith<QvacNestedSessionException> { session.openSession() }
        assertEquals(listOf("openSession"), transport.requests.map { it.type() })
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
    fun theOwnerCloseStopsTheTransport() = runTest {
        val transport = SessionRecordingTransport()
        val client = QvacClient(transport)
        client.openSession()

        client.close()

        assertEquals(1, transport.closeCalls)
    }

    @Test
    fun theOwnerCloseEndsEverySessionBeforeTheTransport() = runTest {
        val transport = SessionRecordingTransport()
        val client = QvacClient(transport)
        val session = client.openSession()
        session.opened.await()

        client.close()

        val error = assertFailsWith<QvacSessionClosedException> { session.heartbeat() }
        assertEquals("shutdown", error.reason)
        assertEquals("shutdown", assertFailsWith<QvacSessionClosedException> { session.close() }.reason)
        assertEquals(listOf("openSession"), transport.requests.map { it.type() }, "no closeSession after the owner shut down")
    }

    @Test
    fun aLostWorkerEndsEverySession() = runTest {
        val lost = CompletableDeferred<Unit>()
        val transport = SessionRecordingTransport(lost = lost)
        val client = QvacClient(transport)
        val session = client.openSession()
        session.opened.await()
        session.heartbeat()

        lost.complete(Unit)

        val error = awaitSessionEnd(session)
        assertEquals("crashed", error.reason)
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
) : QvacTransport {
    val requests = mutableListOf<JsonObject>()
    var closeCalls = 0

    override suspend fun call(payload: JsonObject): JsonObject {
        requests += payload
        return when (payload["type"]?.jsonPrimitive?.content) {
            "openSession" -> buildJsonObject {
                put("type", "openSession")
                put("success", true)
                put("sessionId", payload["sessionId"]?.jsonPrimitive?.content ?: "")
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
                put("modelId", "m-1")
            }
            else -> buildJsonObject { put("type", payload["type"]?.jsonPrimitive?.content ?: "") }
        }
    }

    override fun stream(payload: JsonObject): Flow<JsonObject> {
        requests += payload
        return stream
    }

    override fun duplex(payload: JsonObject, input: Flow<ByteArray>): Flow<JsonObject> {
        requests += payload
        return stream
    }

    override suspend fun close() {
        closeCalls++
    }
}
