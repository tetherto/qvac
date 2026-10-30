// Kotlin port of packages/sdk/examples/tools/llamacpp-deferred-tools.ts.
//
// Deferred tool loading. A large tool set stays out of the prompt until the
// model asks for it. Only `get_weather` and the built-in `tool_search` (whose
// description carries a name-and-description catalog of the rest) are in the
// initial prompt; a deferred schema is declared in the prompt once the model
// has searched for it.
//
// Runs through the worker-orchestrated loop rather than the client-side loop of
// CompletionTools.kt: executing `tool_search` from the client needs the
// `executeToolSearch` helper, which only the JS SDK exports. On this path the
// worker runs the search itself and calls back only for the real tools.
//
// `QvacTool` (used by `client.completion.orchestrate()`) has no `deferLoading`
// or `group` field, so this example drives the generated typed operation
// directly: `client.completionOrchestrate(request, input)` takes a
// `CompletionOrchestrateRequest` whose `CompletionStreamRequestToolsItem`
// carries both fields, and returns a `Flow` of typed frames. The duplex `input`
// is a `Flow<ByteArray>` fed from a `Channel`: each `toolCallback` frame is
// answered with one newline-delimited `{callId, result}` line, and the worker
// resumes generation. `group` is the heading the tool is listed under in the
// catalog, and is ignored for tools that are not deferred.
//
// RUN: ./gradlew run -Pexample=CompletionDeferredTools

import io.tether.qvac.sdk.JvmBareRpcTransport
import io.tether.qvac.sdk.QvacClient
import io.tether.qvac.sdk.QvacProgressEvent
import io.tether.qvac.sdk.completionOrchestrate
import io.tether.qvac.sdk.generated.ModelConstant
import io.tether.qvac.sdk.generated.Models
import io.tether.qvac.sdk.generated.schema.CompletionOrchestrateRequest
import io.tether.qvac.sdk.generated.schema.CompletionStreamRequestHistoryItem
import io.tether.qvac.sdk.generated.schema.CompletionStreamRequestToolsItem
import io.tether.qvac.sdk.generated.schema.CompletionStreamResponseEventsItem
import io.tether.qvac.sdk.generated.schema.LoadModelResponse
import io.tether.qvac.sdk.generated.schema.ModelProgressResponse
import io.tether.qvac.sdk.models
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject

private val HANDLERS: Map<String, (JsonObject) -> JsonElement> = mapOf(
    "get_weather" to { arguments ->
        buildJsonObject {
            put("city", arguments.string("city"))
            put("country", arguments.string("country") ?: "unknown")
            put("temperature", "22°C")
            put("condition", "Partly cloudy")
        }
    },
    "get_horoscope" to { arguments ->
        buildJsonObject {
            put("sign", arguments.string("sign"))
            put("horoscope", "Today is a great day for new beginnings.")
        }
    },
    "get_moon_phase" to { arguments ->
        buildJsonObject {
            put("date", arguments.string("date") ?: "today")
            put("phase", "Waxing gibbous")
        }
    },
)

private val TOOLS = listOf(
    CompletionStreamRequestToolsItem(
        name = "get_weather",
        description = "Get current weather for a city",
        parameters = objectSchema(
            "city" to "City name",
            "country" to "Country code",
            required = listOf("city"),
        ),
    ),
    CompletionStreamRequestToolsItem(
        name = "get_horoscope",
        description = "Get today's horoscope for an astrological sign",
        parameters = objectSchema(
            "sign" to "An astrological sign like Taurus or Aquarius",
            required = listOf("sign"),
        ),
        deferLoading = true,
        group = "astrology",
    ),
    CompletionStreamRequestToolsItem(
        name = "get_moon_phase",
        description = "Get the current phase of the moon",
        parameters = objectSchema("date" to "ISO date"),
        deferLoading = true,
        group = "astrology",
    ),
)

fun main(): Unit = runBlocking {
    val client = QvacClient(JvmBareRpcTransport.connectResolved(installWorkerIfMissing = true))
    try {
        val modelId = client.loadWithProgress(
            Models.QWEN3_1_7B_INST_Q4,
            modelConfig = buildJsonObject {
                put("ctx_size", 4096)
                put("tools", true)
            },
        )
        println("▸ Model loaded: $modelId")
        println("\n▸ Only get_weather and tool_search are in the prompt\n")

        val request = CompletionOrchestrateRequest(
            modelId = modelId,
            history = listOf(
                CompletionStreamRequestHistoryItem(
                    role = "system",
                    content = "You are a helpful assistant. Search for a tool before calling it.",
                ),
                CompletionStreamRequestHistoryItem(role = "user", content = "What's my horoscope for Aquarius?"),
            ),
            tools = TOOLS,
            stream = true,
            maxToolTurns = 4,
        )

        // The final answer is the text of the last turn.
        val upstream = Channel<ByteArray>(Channel.UNLIMITED)
        var turn: Long? = null
        val answer = StringBuilder()
        try {
            client.completionOrchestrate(request, upstream.receiveAsFlow()).collect { frame ->
                if (frame.turn != null && frame.turn != turn) {
                    turn = frame.turn
                    answer.clear()
                }
                for (event in frame.events.orEmpty()) {
                    when (event) {
                        is CompletionStreamResponseEventsItem.ContentDelta -> {
                            print(event.value.text)
                            answer.append(event.value.text)
                        }
                        is CompletionStreamResponseEventsItem.ToolCall -> {
                            val call = event.value.call
                            println("\n\n▸ Tool call: ${call.name}(${JsonObject(call.arguments)})\n")
                        }
                        is CompletionStreamResponseEventsItem.CompletionDoneError -> error(event.value.error.message)
                        else -> Unit
                    }
                }
                frame.toolCallback?.let { callback ->
                    val handler = HANDLERS.getValue(callback.name)
                    val reply = buildJsonObject {
                        put("callId", callback.callId)
                        put("result", handler(JsonObject(callback.arguments)))
                    }
                    upstream.send("$reply\n".encodeToByteArray())
                }
            }
        } finally {
            upstream.close()
        }
        println("\n\n▸ Final answer: $answer")

        println("\n▸ Completed!")
        client.models.unload(modelId)
    } finally {
        client.close()
    }
}

private fun JsonObject.string(key: String): String? = get(key)?.jsonPrimitive?.content

/** A JSON Schema object of string properties, each with a description. */
private fun objectSchema(vararg properties: Pair<String, String>, required: List<String> = emptyList()) =
    buildJsonObject {
        put("type", "object")
        putJsonObject("properties") {
            for ((name, description) in properties) {
                putJsonObject(name) {
                    put("type", "string")
                    put("description", description)
                }
            }
        }
        if (required.isNotEmpty()) putJsonArray("required") { required.forEach { add(it) } }
    }

/** Load [model], printing download progress, and return its model id. */
private suspend fun QvacClient.loadWithProgress(model: ModelConstant, modelConfig: JsonObject? = null): String {
    var result: LoadModelResponse? = null
    models.loadWithProgress(model.src, model.engine, model.name, modelConfig = modelConfig).collect { event ->
        when (event) {
            is QvacProgressEvent.Progress -> printProgress(event.value)
            is QvacProgressEvent.Result -> result = event.value
        }
    }
    val loaded = checkNotNull(result) { "loadModel ended without a result" }
    return loaded.modelId ?: error(loaded.error ?: "loadModel failed")
}

private fun printProgress(p: ModelProgressResponse) {
    val line = "▸ Downloading %.0f%% (%.1f/%.1f MB)".format(p.percentage, p.downloaded / 1e6, p.total / 1e6)
    if (System.console() != null) System.err.print("\r$line") else System.err.println(line)
    if (p.percentage >= 100) System.err.println()
}
