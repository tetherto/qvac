// Kotlin port of packages/sdk-python/examples/completion_orchestrate.py (no TS
// counterpart: the JS SDK has no client wrapper for worker orchestration yet).
// It is the server-side counterpart of the client-side loop in CompletionTools.kt.
//
// `client.completion.orchestrate()` hands the multi-turn tool loop to the
// WORKER: when the model asks for a tool, the worker emits a callback frame,
// this client runs the tool's `handler`, writes the result back up the duplex
// request stream, and generation continues — no manual history stitching.
// Every tool needs a `handler` (it runs code on this machine, so only a local
// worker may orchestrate).
//
// Unlike Python, where it lives under a private module, `orchestrate()` is part
// of the public Kotlin completion API. Handlers are `suspend` functions that
// return a `JsonElement`; the worker stringifies it into the `tool` message.
//
// RUN: ./gradlew run -Pexample=CompletionOrchestrate

import io.tether.qvac.sdk.JvmBareRpcTransport
import io.tether.qvac.sdk.QvacClient
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
import io.tether.qvac.sdk.orchestrate
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

private val TOOLS = listOf(
    QvacTool(
        name = "get_weather",
        description = "Get the current weather for a location",
        parameters = mapOf("location" to QvacToolParameter(QvacToolParameterType.STRING)),
        required = setOf("location"),
        handler = { arguments ->
            JsonPrimitive("The weather in ${arguments.string("location")} is 22°C and sunny.")
        },
    ),
    QvacTool(
        name = "get_horoscope",
        description = "Get the horoscope for a star sign",
        parameters = mapOf("sign" to QvacToolParameter(QvacToolParameterType.STRING)),
        required = setOf("sign"),
        handler = { arguments ->
            JsonPrimitive("${arguments.string("sign")}: today favours careful validation.")
        },
    ),
)

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
        println("▸ Model loaded: $modelId\n")

        val run = client.completion.orchestrate(
            modelId = modelId,
            history = listOf(QvacMessage.user("What's the weather in Tokyo and my horoscope for Aquarius?")),
            tools = TOOLS,
            maxToolTurns = 4,
        )

        run.tokens.collect { print(it) }

        val final = run.final.await()
        println("\n\n▸ Final answer: ${final.text}")

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
