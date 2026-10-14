package io.tether.qvac.sdk

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.add
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
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
        assertEquals(-1.0, transport.lastPayload?.get("generationParams")?.jsonObject
            ?.get("predict")?.jsonPrimitive?.doubleOrNull)
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
        val wireTool = transport.lastPayload?.get("tools")?.jsonArray?.single()?.jsonObject
        assertEquals("function", wireTool?.get("type")?.jsonPrimitive?.content)
        val parameters = wireTool?.get("parameters")?.jsonObject
        assertEquals("object", parameters?.get("type")?.jsonPrimitive?.content)
        assertEquals("string", parameters?.get("properties")?.jsonObject?.get("city")?.jsonObject
            ?.get("type")?.jsonPrimitive?.content)
        assertEquals("city", parameters?.get("required")?.jsonArray?.single()?.jsonPrimitive?.content)
    }

    @Test
    fun unknownEventTypesSurfaceAsUnknownEvents() = runTest {
        val client = QvacClient(
            ApiTransport(
                stream = flowOf(
                    completionFrame(
                        done = true,
                        event("contentDelta", 0) { put("text", "hi") },
                        event("futureEvent", 1) { put("detail", "x") },
                        event("completionDone", 2) { put("stopReason", "eos") },
                    ),
                ),
            ),
        )
        try {
            val run = client.completion.run("model", listOf(QvacMessage.user("hi")))
            assertEquals("hi", run.final.await().text)
            val unknown = run.events.toList().filterIsInstance<QvacCompletionEvent.Unknown>().single()
            assertEquals(1L, unknown.sequence)
            assertEquals("futureEvent", unknown.payload["type"]?.jsonPrimitive?.content)
        } finally {
            client.close()
        }
    }

    @Test
    fun malformedKnownEventFailsTheRun() = runTest {
        val client = QvacClient(
            ApiTransport(
                stream = flowOf(
                    completionFrame(
                        done = true,
                        event("contentDelta", 0) { put("text", "partial") },
                        event("completionDone", 1) { put("stopReason", "error") },
                    ),
                ),
            ),
        )
        try {
            val error = assertFailsWith<QvacCompletionException> {
                client.completion.run("model", listOf(QvacMessage.user("hi"))).final.await()
            }
            assertEquals("Worker sent a malformed 'completionDone' event", error.message)
        } finally {
            client.close()
        }
    }

    @Test
    fun completionErrorEventFailsTheRun() = runTest {
        val client = QvacClient(
            ApiTransport(
                stream = flowOf(
                    completionFrame(
                        done = true,
                        event("contentDelta", 0) { put("text", "partial") },
                        event("completionDone", 1) {
                            put("stopReason", "error")
                            put("error", buildJsonObject { put("message", "context overflow") })
                        },
                    ),
                ),
            ),
        )
        try {
            val error = assertFailsWith<QvacCompletionException> {
                client.completion.run("model", listOf(QvacMessage.user("hi"))).final.await()
            }
            assertEquals("context overflow", error.message)
        } finally {
            client.close()
        }
    }

    @Test
    fun orchestrateRequestCarriesTheStreamRequestFields() = runTest {
        val transport = ApiTransport(
            stream = flowOf(
                completionFrame(
                    done = true,
                    event("contentDelta", 0) { put("text", "ok") },
                    event("completionDone", 1) { put("stopReason", "eos") },
                ),
            ),
            duplexFactory = {
                flowOf(
                    buildJsonObject {
                        put("type", "completionOrchestrate")
                        put("turn", 0)
                        put("events", buildJsonArray {
                            add(event("contentDelta", 0) { put("text", "ok") })
                            add(event("completionDone", 1) { put("stopReason", "eos") })
                        })
                    },
                    buildJsonObject { put("type", "completionOrchestrate"); put("done", true) },
                )
            },
        )
        val history = listOf(
            QvacMessage.system("be brief"),
            QvacMessage.user("what is this?", listOf(QvacAttachment("/image.png"))),
        )
        val tools = listOf(
            QvacTool(
                name = "lookup",
                description = "Look up a value",
                parameters = QvacToolParameterType.entries.associate { type ->
                    type.name.lowercase() to QvacToolParameter(
                        type,
                        description = "a ${type.name.lowercase()}",
                        enumValues = if (type == QvacToolParameterType.STRING) {
                            listOf(JsonPrimitive("one"), JsonPrimitive(2.5), JsonPrimitive(true), JsonNull)
                        } else {
                            null
                        },
                    )
                },
                required = setOf("string"),
                handler = { JsonPrimitive("ok") },
            ),
        )
        val options = QvacCompletionOptions(
            generation = QvacGenerationOptions(temperature = 0.2, predict = 64, seed = 7, reasoningBudget = 0),
            kvCache = QvacKvCache.Enabled(true),
            toolDialect = "hermes",
            requestId = "request-1",
        )
        val client = QvacClient(transport)
        val (streamed, orchestrated) = try {
            client.completion.run("model", history, tools, options).final.await()
            val streamed = transport.lastPayload!!
            client.completion.orchestrate("model", history, tools, maxToolTurns = 3, options = options).final.await()
            streamed to transport.lastPayload!!
        } finally {
            client.close()
        }

        assertEquals("completionOrchestrate", orchestrated.getValue("type").jsonPrimitive.content)
        assertEquals(3, orchestrated.getValue("maxToolTurns").jsonPrimitive.content.toInt())
        assertEquals(streamed - setOf("type"), orchestrated - setOf("type", "maxToolTurns"))
        val properties = orchestrated.getValue("tools").jsonArray.single().jsonObject
            .getValue("parameters").jsonObject.getValue("properties").jsonObject
        assertEquals(
            QvacToolParameterType.entries.associate { it.name.lowercase() to it.name.lowercase() },
            properties.mapValues { (_, value) -> value.jsonObject.getValue("type").jsonPrimitive.content },
        )
        assertEquals(
            buildJsonArray {
                add(JsonPrimitive("one"))
                add(JsonPrimitive(2.5))
                add(JsonPrimitive(true))
                add(JsonNull)
            },
            properties.getValue("string").jsonObject.getValue("enum").jsonArray,
        )
    }

    @Test
    fun kvCacheAndToolDialectUseContractValues() = runTest {
        val transport = ApiTransport(
            stream = flowOf(
                completionFrame(
                    done = true,
                    event("contentDelta", 0) { put("text", "ok") },
                    event("completionDone", 1) { put("stopReason", "eos") },
                ),
            ),
        )
        val client = QvacClient(transport)
        try {
            client.completion.run(
                modelId = "model",
                history = listOf(QvacMessage.user("hi")),
                options = QvacCompletionOptions(kvCache = QvacKvCache.Key("chat-1"), toolDialect = "hermes"),
            ).final.await()
            assertEquals("chat-1", transport.lastPayload?.get("kvCache")?.jsonPrimitive?.content)
            assertEquals("hermes", transport.lastPayload?.get("toolDialect")?.jsonPrimitive?.content)

            assertFailsWith<IllegalArgumentException> {
                client.completion.run(
                    modelId = "model",
                    history = listOf(QvacMessage.user("hi")),
                    options = QvacCompletionOptions(toolDialect = "not-a-dialect"),
                )
            }
            assertFailsWith<IllegalArgumentException> { QvacKvCache.Key("") }
        } finally {
            client.close()
        }
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
                QvacTool("weather", "Get weather") { JsonPrimitive("sunny") },
            ),
        ).final.await()

        assertEquals("Sunny", result.text)
        // The final orchestrate frame carries no stopReason; the turn's completionDone event decides it.
        assertEquals("eos", result.stopReason)
        assertTrue(callbackReply.contains("\"callId\":\"c1\""))
        assertTrue(callbackReply.contains("\"result\":\"sunny\""))
        assertFalse(callbackReply.contains("error"))
        client.close()
    }

    @Test
    fun toolParametersSchemaIsSentAsWritten() = runTest {
        val schema = buildJsonObject {
            put("type", "object")
            putJsonObject("properties") {
                putJsonObject("stops") {
                    put("type", "array")
                    putJsonObject("items") {
                        put("type", "object")
                        putJsonObject("properties") { putJsonObject("name") { put("type", "string") } }
                    }
                }
                putJsonObject("budget") {
                    putJsonArray("anyOf") {
                        add(buildJsonObject { put("type", "number") })
                        add(buildJsonObject { put("type", "null") })
                    }
                }
            }
        }
        val tool = QvacTool(name = "plan_trip", description = "Plan a trip", parametersSchema = schema)
        val payload = sentPayload(listOf(QvacMessage.user("plan")), listOf(tool))
        assertEquals(schema, payload["tools"]?.jsonArray?.single()?.jsonObject?.get("parameters"))
    }

    @Test
    fun toolRejectsParametersSchemaAlongsideFlatParameters() {
        assertFailsWith<IllegalArgumentException> {
            QvacTool(
                name = "plan_trip",
                description = "Plan a trip",
                parameters = mapOf("city" to QvacToolParameter(QvacToolParameterType.STRING)),
                parametersSchema = buildJsonObject { put("type", "object") },
            )
        }
    }

    @Test
    fun toolTurnsReachTheWireStructured() = runTest {
        val call = QvacToolCall("call_1", "weather", buildJsonObject { put("city", "Rome") })
        val history = sentPayload(
            listOf(
                QvacMessage.user("weather?"),
                QvacMessage.assistant("", toolCalls = listOf(call)),
                QvacMessage.tool("sunny", toolCallId = "call_1", toolName = "weather"),
            ),
        )["history"]!!.jsonArray.map { it.jsonObject }

        assertFalse("toolCalls" in history[0])
        assertEquals(
            buildJsonArray {
                add(buildJsonObject {
                    put("id", "call_1")
                    put("name", "weather")
                    put("arguments", buildJsonObject { put("city", "Rome") })
                })
            },
            history[1]["toolCalls"],
        )
        assertEquals("call_1", history[2]["toolCallId"]?.jsonPrimitive?.content)
        assertEquals("weather", history[2]["toolName"]?.jsonPrimitive?.content)
    }

    @Test
    fun toolFieldsOnTheWrongRoleAreRejected() {
        val call = QvacToolCall("call_1", "weather", buildJsonObject {})
        assertFailsWith<IllegalArgumentException> {
            QvacMessage("user", "hi", toolCalls = listOf(call))
        }
        assertFailsWith<IllegalArgumentException> {
            QvacMessage("assistant", "hi", toolCallId = "call_1")
        }
    }

    private suspend fun sentPayload(history: List<QvacMessage>, tools: List<QvacTool> = emptyList()): JsonObject {
        val transport = ApiTransport(
            stream = flowOf(completionFrame(done = true, event("completionDone", 0) { put("stopReason", "eos") })),
        )
        val client = QvacClient(transport)
        try {
            client.completion.run("model", history, tools).final.await()
        } finally {
            client.close()
        }
        return transport.lastPayload!!
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
