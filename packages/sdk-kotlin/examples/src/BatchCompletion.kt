// Kotlin port of packages/sdk/examples/batch-completion.ts.
//
// Batch completion — continuous batching over a single loaded LLM.
//
// `client.completion.batch()` submits multiple prompts to one loaded model in a
// single call, so the llama.cpp addon decodes the active sequences together.
// Load the model with `parallel >= 2` to make the concurrent slots available.
//
// As in Python, the Kotlin surface is the typed frame stream (a `Flow` of
// `BatchCompletionStreamResponse`), so this example does the grouping itself:
//
//   - every frame carries `events`, a list of `{id, event}` records interleaved
//     across prompts, where `event` is a sealed class (`ContentDelta`,
//     `ToolCall`, `CompletionStats`, ...);
//   - the frame carrying `ids` gives the addon-assigned ids, in prompt order;
//   - the final frame carries `stats`, one aggregate for the whole batch (e.g.
//     `avgConcurrentSeq`), not one per prompt.
//
// The prompts are built from the generated request types, so a misspelled field
// or a wrong type is a compile error rather than a worker validation error.
// Each prompt may also carry `tools`, `attachments` or `responseFormat`, as in
// the JS example; they are left out here to keep the run fast.
//
// RUN: ./gradlew run -Pexample=BatchCompletion

import io.tether.qvac.sdk.JvmBareRpcTransport
import io.tether.qvac.sdk.QvacClient
import io.tether.qvac.sdk.QvacProgressEvent
import io.tether.qvac.sdk.completion
import io.tether.qvac.sdk.generated.ModelConstant
import io.tether.qvac.sdk.generated.Models
import io.tether.qvac.sdk.generated.schema.BatchCompletionStreamRequest
import io.tether.qvac.sdk.generated.schema.BatchCompletionStreamRequestPromptsItem
import io.tether.qvac.sdk.generated.schema.BatchCompletionStreamRequestPromptsItemGenerationParams
import io.tether.qvac.sdk.generated.schema.BatchCompletionStreamRequestPromptsItemHistoryItem
import io.tether.qvac.sdk.generated.schema.BatchCompletionStreamResponseEventsItemEvent
import io.tether.qvac.sdk.generated.schema.BatchCompletionStreamResponseStats
import io.tether.qvac.sdk.generated.schema.LoadModelResponse
import io.tether.qvac.sdk.generated.schema.ModelProgressResponse
import io.tether.qvac.sdk.models
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

private val PROMPTS = listOf(
    "cherry" to "Reply with only the word CHERRY.",
    "banana" to "Reply with only the word BANANA.",
    "grape" to "Reply with only the word GRAPE.",
).map { (id, ask) ->
    BatchCompletionStreamRequestPromptsItem(
        id = id,
        history = listOf(BatchCompletionStreamRequestPromptsItemHistoryItem(role = "user", content = ask)),
        generationParams = BatchCompletionStreamRequestPromptsItemGenerationParams(
            temp = 0.0,
            seed = 42.0,
            predict = 16.0,
        ),
    )
}

fun main(): Unit = runBlocking {
    val client = QvacClient(JvmBareRpcTransport.connectResolved(installWorkerIfMissing = true))
    var modelId: String? = null
    try {
        // `parallel: 4` opens the concurrent decode slots batching needs.
        modelId = client.loadWithProgress(
            Models.LLAMA_3_2_1B_INST_Q4_0,
            modelConfig = buildJsonObject {
                put("ctx_size", 4096)
                put("parallel", 4)
            },
        )
        println("▸ Model loaded: $modelId")

        val request = BatchCompletionStreamRequest(modelId = modelId, prompts = PROMPTS)

        // Prompt order to start with; replaced by the addon-assigned ids once
        // the frame that carries them arrives.
        var ids = PROMPTS.mapNotNull { it.id }
        val texts = mutableMapOf<String, String>()
        var stats: BatchCompletionStreamResponseStats? = null

        println("\n▸ Merged event stream (interleaved across prompts):")
        client.completion.batch(request).collect { frame ->
            frame.ids?.takeIf { it.isNotEmpty() }?.let { ids = it }
            for (record in frame.events) {
                val event = record.event as? BatchCompletionStreamResponseEventsItemEvent.ContentDelta ?: continue
                print("[${record.id}] ${event.value.text}")
                System.out.flush()
                texts[record.id] = texts.getOrDefault(record.id, "") + event.value.text
            }
            if (frame.done == true) stats = frame.stats
        }

        println("\n\n▸ Ordered results:")
        for (promptId in ids) {
            println("  ▸ $promptId: ${texts.getOrDefault(promptId, "").collapseWhitespace()}")
        }

        // The per-prompt aggregation JS exposes as `byId(id).final` is this
        // lookup: everything collected for that one id.
        println("\n▸ texts[\"${ids[0]}\"] -> ${texts.getOrDefault(ids[0], "").trim()}")

        // Batch-level stats: one aggregate for the whole run.
        stats?.tokensPerSecond?.let { println("\n▸ Batch stats: %.1f tok/s across the batch".format(it)) }
    } finally {
        modelId?.let { client.models.unload(it) }
        client.close()
    }
}

private fun String.collapseWhitespace(): String = trim().split(Regex("\\s+")).joinToString(" ")

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
