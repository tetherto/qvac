package io.tether.qvac.sdk

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class QvacCompletionApiTest {
    @Test
    fun completionRunAggregatesTextThinkingStatsAndStopReason() = runTest {
        val transport = ApiTransport(
            stream = flowOf(
                completionFrame(
                    done = true,
                    event("contentDelta", 0) { put("text", "hello ") },
                    event("thinkingDelta", 1) { put("text", "hmm") },
                    event("contentDelta", 2) { put("text", "world") },
                    event("completionStats", 3) {
                        put("stats", buildJsonObject { put("tokensPerSecond", 12.5) })
                    },
                    event("completionDone", 4) {
                        put("stopReason", "eos")
                        put("raw", buildJsonObject { put("fullText", "hello world") })
                    },
                ),
            ),
        )
        val client = QvacClient(transport)

        val run = client.completion.run(
            modelId = "model",
            history = listOf(QvacMessage.user("hi")),
        )
        val result = run.final.await()

        assertEquals("hello world", result.text)
        assertEquals("hmm", result.thinking)
        assertEquals(12.5, result.stats?.tokensPerSecond)
        assertEquals("eos", result.stopReason)
        assertEquals(-1L, transport.lastPayload?.get("generationParams")?.jsonObject
            ?.get("predict")?.jsonPrimitive?.longOrNull)
        assertEquals(listOf("hello ", "world"), run.tokens.toList())
        assertTrue(run.cancel())
        client.close()
    }

    @Test
    fun cancelledCompletionRejectsFinalWithPartialResult() = runTest {
        val client = QvacClient(
            ApiTransport(
                stream = flowOf(
                    completionFrame(
                        done = true,
                        event("contentDelta", 0) { put("text", "partial") },
                        event("completionDone", 1) { put("stopReason", "cancelled") },
                    ),
                ),
            ),
        )
        try {
            val error = assertFailsWith<QvacCompletionCancelledException> {
                client.completion.run("model", listOf(QvacMessage.user("hi"))).final.await()
            }
            assertEquals("partial", error.partial.text)
            assertEquals("cancelled", error.partial.stopReason)
        } finally {
            client.close()
        }
    }

    @Test
    fun toolCallsCarryInvokableKotlinHandlers() = runTest {
        val transport = ApiTransport(
            stream = flowOf(
                completionFrame(
                    done = true,
                    event("toolCall", 0) {
                        put("call", buildJsonObject {
                            put("id", "call-1")
                            put("name", "weather")
                            put("arguments", buildJsonObject { put("city", "Rome") })
                        })
                    },
                    event("completionDone", 1) { put("stopReason", "eos") },
                ),
            ),
        )
        val tool = QvacTool(
            name = "weather",
            description = "Get weather",
            parameters = mapOf("city" to QvacToolParameter(QvacToolParameterType.STRING)),
            required = setOf("city"),
            handler = { args -> JsonPrimitive("sunny in ${args["city"]?.jsonPrimitive?.content}") },
        )

        val client = QvacClient(transport)
        val call = try {
            client.completion.run(
                modelId = "model",
                history = listOf(QvacMessage.user("weather?")),
                tools = listOf(tool),
            ).final.await().toolCalls.single()
        } finally {
            client.close()
        }

        assertTrue(call.canInvoke)
        assertEquals("sunny in Rome", call.invoke().jsonPrimitive.content)
    }

    @Test
    fun orchestrationExecutesCallbackAndReturnsLastTurn() = runTest {
        var callbackReply = ""
        val transport = ApiTransport(
            duplexFactory = { input -> flow {
                emit(buildJsonObject {
                    put("type", "completionOrchestrate")
                    put("turn", 0)
                    put("toolCallback", buildJsonObject {
                        put("callId", "c1")
                        put("name", "weather")
                        put("arguments", buildJsonObject { put("city", "Rome") })
                    })
                })
                callbackReply = input.first().decodeToString()
                emit(buildJsonObject {
                    put("type", "completionOrchestrate")
                    put("turn", 1)
                    put("events", buildJsonArray {
                        add(event("contentDelta", 0) { put("text", "Sunny") })
                        add(event("completionDone", 1) { put("stopReason", "eos") })
                    })
                })
                emit(buildJsonObject { put("type", "completionOrchestrate"); put("done", true) })
            } },
        )
        val client = QvacClient(transport)
        val result = client.completion.orchestrate(
            modelId = "model",
            history = listOf(QvacMessage.user("weather?")),
            tools = listOf(
                QvacTool("weather", "Get weather", handler = { JsonPrimitive("sunny") }),
            ),
        ).final.await()

        assertEquals("Sunny", result.text)
        assertTrue(callbackReply.contains("\"callId\":\"c1\""))
        assertTrue(callbackReply.contains("\"result\":\"sunny\""))
        assertFalse(callbackReply.contains("error"))
        client.close()
    }

    private fun completionFrame(done: Boolean, vararg events: JsonObject) = buildJsonObject {
        put("type", "completionStream")
        put("done", done)
        put("events", buildJsonArray { events.forEach(::add) })
    }

    private fun event(type: String, sequence: Long, content: kotlinx.serialization.json.JsonObjectBuilder.() -> Unit) =
        buildJsonObject {
            put("type", type)
            put("seq", sequence)
            content()
        }

    private class ApiTransport(
        private val stream: Flow<JsonObject> = flowOf(),
        private val duplexFactory: (Flow<ByteArray>) -> Flow<JsonObject> = { stream },
    ) : QvacTransport {
        var lastPayload: JsonObject? = null
        override suspend fun call(payload: JsonObject) = buildJsonObject {
            put("type", "cancel")
            put("success", true)
            put("cancelled", 1)
        }
        override fun stream(payload: JsonObject): Flow<JsonObject> {
            lastPayload = payload
            return stream
        }
        override fun duplex(payload: JsonObject, input: Flow<ByteArray>): Flow<JsonObject> {
            lastPayload = payload
            return duplexFactory(input)
        }
        override suspend fun close() = Unit
    }
}
