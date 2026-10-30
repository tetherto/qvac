package io.tether.qvac.e2e.runner

import io.tether.qvac.sdk.QvacClient
import io.tether.qvac.sdk.QvacTransport
import io.tether.qvac.sdk.generated.Models
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

private class FakeTransport(
    private val replies: Map<String, (JsonObject) -> JsonObject> = emptyMap(),
    private val streams: Map<String, (JsonObject) -> List<JsonObject>> = emptyMap(),
    private val hangs: Set<String> = emptySet(),
    /** Request types the worker answers after this many milliseconds. */
    private val delays: Map<String, Long> = emptyMap(),
) : QvacTransport {
    val requests = mutableListOf<JsonObject>()

    override suspend fun call(payload: JsonObject): JsonObject {
        requests += payload
        val type = payload["type"]!!.jsonPrimitive.content
        if (type in hangs) awaitCancellation()
        delays[type]?.let { delay(it) }
        return replies[type]?.invoke(payload) ?: error("no reply for $type")
    }

    override fun stream(payload: JsonObject): Flow<JsonObject> {
        requests += payload
        val type = payload["type"]!!.jsonPrimitive.content
        return flowOf(*(streams[type]?.invoke(payload) ?: error("no stream for $type")).toTypedArray())
    }

    override fun duplex(payload: JsonObject, input: Flow<ByteArray>): Flow<JsonObject> = error("unused")

    override suspend fun close() = Unit
}

private fun json(text: String): JsonObject = Json.parseToJsonElement(text).jsonObject

private fun definition(text: String): Map<String, Any?> = asMap(fromJson(Json.parseToJsonElement(text)))

class InterpreterTest {
    private val noHost = object : HostResolvers {
        override fun asset(kind: String, file: String) = "/fixtures/$kind/$file"
        override fun packageAsset(pkg: String, file: String) = "/packages/$pkg/$file"
    }

    private fun interpreter(transport: FakeTransport, table: Map<String, Any?> = emptyMap()): Interpreter {
        val client = QvacClient(transport)
        val resources = Resources(client, table, "mobile-android", noHost, {}, unloadSettleMs = 0)
        val calls = Calls(Wire(client), resources, Files.createTempDirectory("scratch").toFile())
        return Interpreter(resources, calls, Files.createTempDirectory("fixtures").toFile(), {})
    }

    private suspend fun Interpreter.run(text: String): StepResult {
        val test = definition(text)
        return run(
            steps = asList(test["steps"]).map(::asMap),
            params = asMap(test["params"]),
            expectation = asMap(test["expectation"]),
            teardown = asList(test["finally"]).map(::asMap),
        )
    }

    @Test
    fun `a call is bound, projected and asserted`() = runTest {
        val transport = FakeTransport(replies = mapOf("state" to { json("""{"type":"state","state":"active"}""") }))
        val result = interpreter(transport).run(
            """
            {"params": {}, "expectation": {"validation": "contains-all", "contains": ["active"]},
             "steps": [
               {"call": {"method": "state", "as": "run"}},
               {"project": {"from": "${'$'}run", "path": "state", "as": "state"}},
               {"assert": {"on": "${'$'}state", "use": "expectation"}}
             ]}
            """,
        )
        assertTrue(result.passed, result.output)
        assertEquals("active", result.assertedValue)
    }

    @Test
    fun `a body that asserts nothing fails`() = runTest {
        val transport = FakeTransport(replies = mapOf("state" to { json("""{"type":"state","state":"active"}""") }))
        val result = interpreter(transport).run("""{"steps": [{"call": {"method": "state"}}]}""")
        assertFalse(result.passed)
        assertEquals("test body ran but asserted nothing", result.output)
    }

    @Test
    fun `the first failing check decides`() = runTest {
        val result = interpreter(FakeTransport()).run(
            """
            {"params": {"n": 3},
             "steps": [
               {"assert": {"on": "${'$'}params.n", "named": "atLeast", "with": {"value": 5}}},
               {"assert": {"on": "${'$'}params.n", "named": "atLeast", "with": {"value": 1}}}
             ]}
            """,
        )
        assertFalse(result.passed)
        assertEquals("expected at least 5, got 3", result.output)
    }

    @Test
    fun `an unknown method or assertion is incomplete, never a failure`() = runTest {
        val method = interpreter(FakeTransport()).run("""{"steps": [{"call": {"method": "teleport"}}]}""")
        assertTrue(method.incomplete)
        val named = interpreter(FakeTransport()).run("""{"steps": [{"assert": {"on": 1, "named": "isPrime"}}]}""")
        assertTrue(named.incomplete)
        val collect = interpreter(FakeTransport()).run("""{"steps": [{"call": {"method": "completion", "collect": "pcm"}}]}""")
        assertTrue(collect.incomplete)
    }

    @Test
    fun `a rejection is bound with its code and details`() = runTest {
        val transport = FakeTransport(
            replies = mapOf(
                "getModelInfo" to {
                    json("""{"type":"error","name":"MODEL_NOT_FOUND","code":52001,"message":"no such model","modelName":"x"}""")
                },
            ),
        )
        val result = interpreter(transport).run(
            """
            {"steps": [
               {"callError": {"method": "getModelInfo", "params": {"name": "x"}, "as": "error"}},
               {"assert": {"on": "${'$'}error", "named": "errorMatches", "with": {"code": 52001, "messageContains": "no such"}}},
               {"project": {"from": "${'$'}error", "path": "details.modelName", "as": "name"}},
               {"assert": {"on": "${'$'}name", "named": "valueIn", "with": {"values": ["x"]}}}
             ]}
            """,
        )
        assertTrue(result.passed, result.output)
    }

    @Test
    fun `a typed error's fields are details, as the JS client's error object carries them`() = runTest {
        val transport = FakeTransport(
            streams = mapOf(
                "completionStream" to {
                    listOf(
                        json(
                            """{"type":"error","name":"CONTEXT_OVERFLOW","code":52421,"message":"too long",
                               "typedFields":{"promptTokens":900,"ctxSize":512}}""",
                        ),
                    )
                },
            ),
        )
        val result = interpreter(transport).run(
            """
            {"steps": [
               {"callError": {"method": "completion", "collect": "text", "params": {"modelId": "m", "history": []}, "as": "err"}},
               {"project": {"from": "${'$'}err", "path": "details", "as": "details"}},
               {"assert": {"on": "${'$'}details", "named": "positiveIntegers", "with": {"fields": ["promptTokens", "ctxSize"]}}}
             ]}
            """,
        )
        assertTrue(result.passed, result.output)
    }

    @Test
    fun `a completion folds its events the way the JS client does`() = runTest {
        val transport = FakeTransport(
            streams = mapOf(
                "completionStream" to {
                    listOf(
                        json("""{"type":"completionStream","events":[{"type":"contentDelta","text":"4"},{"type":"contentDelta","text":"2"}],"done":false}"""),
                        json("""{"type":"completionStream","events":[{"type":"completionStats","stats":{"tokensPerSecond":9}},{"type":"completionDone","stopReason":"eos","raw":{"fullText":"42"}}],"done":true}"""),
                    )
                },
            ),
        )
        val result = interpreter(transport).run(
            """
            {"params": {"history": [{"role": "user"}]},
             "expectation": {"validation": "contains-all", "contains": ["42"]},
             "steps": [
               {"call": {"method": "completion", "collect": "text", "params": {"modelId": "m", "history": "${'$'}params.history", "stream": true, "tools": "${'$'}params.tools?"}, "as": "run"}},
               {"project": {"from": "${'$'}run", "path": "text", "as": "text"}},
               {"assert": {"on": "${'$'}text", "use": "expectation"}},
               {"project": {"from": "${'$'}run", "path": "stopReason", "as": "stop"}},
               {"assert": {"on": "${'$'}stop", "named": "valueIn", "with": {"values": ["eos"]}}}
             ]}
            """,
        )
        assertTrue(result.passed, result.output)
        val request = transport.requests.single()
        // An optional reference that resolved to nothing is dropped, and a missing content is "".
        assertFalse("tools" in request)
        assertEquals("", asMap(asList(fromJson(request["history"]))[0])["content"])
    }

    @Test
    fun `teardown runs after a failed body and a failing teardown fails a passing one`() = runTest {
        val transport = FakeTransport(replies = mapOf("resume" to { json("""{"type":"error","name":"X","message":"cannot resume"}""") }))
        val result = interpreter(transport).run(
            """
            {"steps": [{"assert": {"on": true, "named": "isTrue"}}],
             "finally": [{"call": {"method": "resume"}}]}
            """,
        )
        assertFalse(result.passed)
        assertTrue("cannot resume" in result.output, result.output)
    }

    @Test
    fun `a body cut short by its timeout still runs its teardown`() = runTest {
        val transport = FakeTransport(
            replies = mapOf("resume" to { json("""{"type":"resume"}""") }),
            hangs = setOf("suspend"),
        )
        val interpreter = interpreter(transport)
        assertFailsWith<TimeoutCancellationException> {
            withTimeout(1_000) {
                interpreter.run("""{"steps": [{"call": {"method": "suspend"}}], "finally": [{"call": {"method": "resume"}}]}""")
            }
        }
        assertEquals("resume", transport.requests.last()["type"]!!.jsonPrimitive.content)
    }

    @Test
    fun `a deadline that lands in teardown lets it finish`() = runTest {
        val transport = FakeTransport(
            replies = mapOf("suspend" to { json("""{"type":"suspend"}""") }, "resume" to { json("""{"type":"resume"}""") }),
            delays = mapOf("suspend" to 1_500L),
        )
        val interpreter = interpreter(transport)
        assertFailsWith<TimeoutCancellationException> {
            withTimeout(1_000) {
                interpreter.run(
                    """
                    {"steps": [{"assert": {"on": true, "named": "isTrue"}}],
                     "finally": [{"call": {"method": "suspend"}}, {"call": {"method": "resume"}}]}
                    """,
                )
            }
        }
        assertEquals(listOf("suspend", "resume"), transport.requests.map { it["type"]!!.jsonPrimitive.content })
    }

    @Test
    fun `a teardown that settles a call the timeout cancelled runs to the end`() = runTest {
        val transport = FakeTransport(replies = mapOf("resume" to { json("""{"type":"resume"}""") }), hangs = setOf("suspend"))
        val interpreter = interpreter(transport)
        assertFailsWith<TimeoutCancellationException> {
            withTimeout(1_000) {
                interpreter.run(
                    """
                    {"steps": [{"start": {"method": "suspend", "as": "pending"}}, {"call": {"method": "suspend"}}],
                     "finally": [{"settle": {"of": "${'$'}pending", "expect": "reject", "as": "e"}}, {"call": {"method": "resume"}}]}
                    """,
                )
            }
        }
        assertEquals("resume", transport.requests.last()["type"]!!.jsonPrimitive.content)
    }

    @Test
    fun `a client-side refusal is bound as the rejection, a gap is not`() = runTest {
        val refused = interpreter(FakeTransport()).run(
            """
            {"steps": [
               {"callError": {"method": "transcribeStreamWriteBytes", "params": {"sessionId": "nope", "data": "AA==", "chunkBytes": 2}, "as": "e"}},
               {"assert": {"on": "${'$'}e.message", "named": "containsAll", "with": {"terms": ["is not open"]}}}
             ]}
            """,
        )
        assertTrue(refused.passed, refused.output)

        val gap = interpreter(FakeTransport()).run("""{"steps": [{"callError": {"method": "teleport", "as": "e"}}]}""")
        assertTrue(gap.incomplete, gap.output)
    }

    @Test
    fun `repeat collects each iteration's last binding`() = runTest {
        val result = interpreter(FakeTransport()).run(
            """
            {"params": {"items": [{"v": 1}, {"v": 2}]},
             "steps": [
               {"repeat": {"over": "${'$'}params.items", "as": "item", "collectInto": "values",
                           "steps": [{"project": {"from": "${'$'}item", "path": "v", "as": "value"}}]}},
               {"assert": {"on": "${'$'}values", "named": "lengthIs", "with": {"length": 2}}}
             ]}
            """,
        )
        assertTrue(result.passed, result.output)
    }

    @Test
    fun `a model is loaded from the table and the undeclared ones are evicted`() = runTest {
        val transport = FakeTransport(
            replies = mapOf(
                "loadModel" to { json("""{"type":"loadModel","success":true,"modelId":"id-1"}""") },
                "unloadModel" to { json("""{"type":"unloadModel","success":true}""") },
            ),
        )
        val table = asMap(
            fromJson(
                Json.parseToJsonElement(
                    """
                    {"llm": {"constant": {"${'$'}const": "${Models.all.first().name}"}, "type": "llm",
                             "config": {"ctx_size": 1024}, "configOn": {"mobile": {"ctx_size": 512}, "desktop": {"ctx_size": 4096}}},
                     "desktop-only": {"on": ["desktop"], "modelSrc": "x", "type": "llm"}}
                    """,
                ),
            ),
        )
        val interpreter = interpreter(transport, table)
        val loaded = interpreter.run(
            """{"steps": [{"useModel": {"deps": ["llm"]}}, {"assert": {"on": "${'$'}model", "named": "valueIn", "with": {"values": ["id-1"]}}}]}""",
        )
        assertTrue(loaded.passed, loaded.output)
        val load = transport.requests.first()
        assertEquals("llamacpp-completion", load["modelType"]!!.jsonPrimitive.content)
        assertEquals("512", load["modelConfig"]!!.jsonObject["ctx_size"].toString())

        val missing = interpreter.run("""{"steps": [{"useModel": {"deps": ["desktop-only"]}}]}""")
        assertTrue(missing.incomplete, missing.output)
        assertEquals("unloadModel", transport.requests.last()["type"]!!.jsonPrimitive.content)
    }
}

class WalkTest {
    private val source = mapOf("a" to listOf(mapOf("b" to 1), mapOf("b" to 2)), "s" to "text")

    @Test
    fun `dotted paths, indexes and fan-out`() {
        assertEquals(2, Interpreter.walk(source, "a[1].b"))
        assertEquals(listOf(1, 2), Interpreter.walk(source, "a[*].b"))
        assertEquals(2, Interpreter.walk(source, "a.length"))
        // Out of range reads as nothing, the way a JS index does.
        assertEquals(null, Interpreter.walk(source, "a[5]"))
    }

    @Test
    fun `a missing field is an error`() {
        assertFailsWith<StepError> { Interpreter.walk(source, "a[0].c") }
        assertFailsWith<StepError> { Interpreter.walk(null, "x") }
    }
}
