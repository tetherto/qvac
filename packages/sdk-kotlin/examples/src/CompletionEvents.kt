// Kotlin port of packages/sdk/examples/completion-events.ts.
//
// The unified typed event stream. `client.completion.run()` returns a
// `QvacCompletionRun` with:
//
//   - `events` — a `Flow` of ordered, typed `QvacCompletionEvent`s
//     (`ContentDelta`, `ThinkingDelta`, `ToolCallEvent`, `ToolError`, `Stats`,
//     `Done`, `RawDelta`).
//   - `final` — a `Deferred<QvacCompletionFinal>` with the aggregated `text`,
//     `thinking`, `toolCalls`, `stats`, and `rawFullText`.
//
// `QvacCompletionEvent` is a sealed interface, so the `when` below is checked
// for exhaustiveness at compile time. Set `captureThinking = true` for
// best-effort `<think>` parsing into `ThinkingDelta` events.
//
// RUN: ./gradlew run -Pexample=CompletionEvents

import io.tether.qvac.sdk.JvmBareRpcTransport
import io.tether.qvac.sdk.QvacClient
import io.tether.qvac.sdk.QvacCompletionEvent
import io.tether.qvac.sdk.QvacCompletionOptions
import io.tether.qvac.sdk.QvacMessage
import io.tether.qvac.sdk.QvacProgressEvent
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
import kotlinx.serialization.json.put

private const val DIM = "\u001b[2m"
private const val RESET = "\u001b[0m"

fun main(): Unit = runBlocking {
    val client = QvacClient(JvmBareRpcTransport.connectResolved(installWorkerIfMissing = true))
    try {
        val modelId = client.loadWithProgress(
            Models.QWEN3_600M_INST_Q4,
            modelConfig = buildJsonObject { put("ctx_size", 4096) },
        )
        println("▸ Model loaded: $modelId")

        val run = client.completion.run(
            modelId = modelId,
            history = listOf(QvacMessage.user("Explain quantum computing in 2 sentences")),
            options = QvacCompletionOptions(captureThinking = true),
        )

        run.events.collect(::handleEvent)

        val final = run.final.await()

        println("\n▸ Final result")
        println("▸ Content: ${final.text}")
        if (!final.thinking.isNullOrEmpty()) println("▸ Thinking: ${final.thinking}")
        final.stats?.tokensPerSecond?.let { println("▸ %.1f tok/s".format(it)) }
        if (final.toolCalls.isNotEmpty()) {
            println("▸ Tool calls: ${final.toolCalls.joinToString { it.name }}")
        }
        final.stopReason?.let { println("▸ Stop reason: $it") }
        println("▸ Raw output length: ${final.rawFullText.length} chars")

        client.models.unload(modelId, clearStorage = false)
    } finally {
        client.close()
    }
}

private fun handleEvent(event: QvacCompletionEvent) {
    when (event) {
        is QvacCompletionEvent.ContentDelta -> print(event.text)
        is QvacCompletionEvent.ThinkingDelta -> print("$DIM${event.text}$RESET")
        is QvacCompletionEvent.ToolCallEvent -> println("\n▸ Tool: ${event.call.name}(${event.call.arguments})")
        is QvacCompletionEvent.ToolError -> println("\n✖ Tool error [${event.code}]: ${event.message}")
        is QvacCompletionEvent.Stats -> event.value.tokensPerSecond?.let { println("\n▸ %.1f tok/s".format(it)) }
        is QvacCompletionEvent.Done -> if (event.stopReason == "error" && event.error != null) {
            println("\n✖ ${event.error}")
        }
        is QvacCompletionEvent.RawDelta, is QvacCompletionEvent.Unknown -> Unit
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
