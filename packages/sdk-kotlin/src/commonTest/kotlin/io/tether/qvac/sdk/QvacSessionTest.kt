package io.tether.qvac.sdk

import io.tether.qvac.sdk.generated.schema.CancelRequest
import io.tether.qvac.sdk.generated.schema.CancelRequestRequest
import io.tether.qvac.sdk.generated.schema.UnloadModelRequest
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.runTest
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

    private fun JsonObject.type() = this["type"]?.jsonPrimitive?.content
}

private class SessionRecordingTransport(
    private val stream: Flow<JsonObject> = emptyFlow(),
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
