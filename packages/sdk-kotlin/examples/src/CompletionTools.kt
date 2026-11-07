// Kotlin port of packages/sdk/examples/tools/llamacpp-native-tools.ts.
//
// The client-side tool loop: run a completion with tool definitions, read back
// the model's tool calls, execute them yourself, append the results to the
// history, and run a follow-up completion. (For the WORKER to run this loop for
// you, see CompletionOrchestrate.kt.)
//
// Tools are typed `QvacTool` values: flat parameters use `QvacToolParameter`
// with the `QvacToolParameterType` enum, and the SDK builds the JSON Schema
// `parameters` object sent on the wire. Tool calls arrive as the
// `QvacCompletionEvent.ToolCallEvent` arm of the sealed event type.
//
// RUN: ./gradlew run -Pexample=CompletionTools

import io.tether.qvac.sdk.JvmBareRpcTransport
import io.tether.qvac.sdk.QvacClient
import io.tether.qvac.sdk.QvacCompletionEvent
import io.tether.qvac.sdk.QvacMessage
import io.tether.qvac.sdk.QvacProgressEvent
import io.tether.qvac.sdk.QvacTool
import io.tether.qvac.sdk.QvacToolParameter
import io.tether.qvac.sdk.QvacToolParameterType
import io.tether.qvac.sdk.completion
import io.tether.qvac.sdk.generated.ModelConstant
import io.tether.qvac.sdk.generated.Models
import io.tether.qvac.sdk.generated.schema.LoadModelResponse
import io.tether.qvac.sdk.generated.schema.ModelProgressResponse
import io.tether.qvac.sdk.models
import io.tether.qvac.sdk.run
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

private val TOOLS = listOf(
    QvacTool(
        name = "get_weather",
        description = "Get the current weather for a location",
        parameters = mapOf("location" to QvacToolParameter(QvacToolParameterType.STRING)),
        required = setOf("location"),
    ),
    QvacTool(
        name = "get_horoscope",
        description = "Get the horoscope for a star sign",
        parameters = mapOf("sign" to QvacToolParameter(QvacToolParameterType.STRING)),
        required = setOf("sign"),
    ),
)

private fun mockExecute(name: String, arguments: JsonObject): String = when (name) {
    "get_weather" -> "The weather in ${arguments.string("location")} is 22°C and sunny."
    "get_horoscope" -> "${arguments.string("sign")}: today favours careful validation."
    else -> "unknown tool"
}

private fun JsonObject.string(key: String): String? = get(key)?.jsonPrimitive?.content

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

        val history = mutableListOf(
            QvacMessage.system("You are a helpful assistant that can use tools for weather and horoscopes."),
            QvacMessage.user("What's the weather in Tokyo and my horoscope for Aquarius?"),
        )

        println("\n▸ AI Response (streaming with tool definitions):\n")
        val run = client.completion.run(modelId = modelId, history = history, tools = TOOLS)
        run.events.collect { event ->
            when (event) {
                is QvacCompletionEvent.ContentDelta -> print(event.text)
                is QvacCompletionEvent.ToolCallEvent ->
                    println("\n\n▸ Tool Call: ${event.call.name}(${event.call.arguments})")
                else -> Unit
            }
        }

        val final = run.final.await()
        println("\n\n▸ Parsed Tool Calls:")
        if (final.toolCalls.isEmpty()) println("▸ No tool calls detected")
        for (call in final.toolCalls) println("▸ ${call.name}(${call.arguments})")

        if (final.toolCalls.isNotEmpty()) {
            println("\n▸ Simulating Tool Execution...")
            history += QvacMessage.assistant(final.text)
            for (call in final.toolCalls) {
                val result = mockExecute(call.name, call.arguments)
                println("▸ ${call.name}: $result")
                history += QvacMessage.tool(result)
            }

            println("\n▸ Follow-up Response with Tool Results:\n")
            val followUp = client.completion.run(modelId = modelId, history = history, tools = TOOLS)
            followUp.tokens.collect { print(it) }
            println()
        }

        println("\n▸ Completed!")
        client.models.unload(modelId)
    } finally {
        client.close()
    }
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
