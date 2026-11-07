// Kotlin port of packages/sdk/examples/multi-job-completion.ts.
//
// Multi-job continuous batching — concurrent completions on one loaded LLM.
//
// Unlike `client.completion.batch()` (which bundles many prompts into ONE
// call), this shows independent `completion.run()` calls fired concurrently
// against the SAME loaded model. When the model is loaded with
// `parallel >= 2`, the SDK admits up to `parallel` completions at once and the
// llama.cpp addon decodes their sequences together — so a burst of prompts
// finishes in roughly the time of the slowest one, not the sum of all of them.
//
// Each `completion.run()` returns an independent `QvacCompletionRun`:
//
//   - `events`    — a `Flow` of streamed events for that call.
//   - `final`     — a `Deferred<QvacCompletionFinal>` with THIS call's own
//                   `text` and `stats` (its own tokens/sec, TTFT).
//                   `stats.averageConcurrentSequences` stays model-level (how
//                   busy the shared backend was).
//   - `cancel()`  — cancels just this call by its `requestId`; peers keep
//                   decoding.
//
// `run()` is not a suspend function: it starts the request and returns at once,
// so firing every call before awaiting any is a plain `map`, and `awaitAll()`
// joins the `Deferred` results. A cancelled run's `final` fails with the typed
// `QvacCompletionCancelledException`, which carries the partial result.
//
// Completions and batches share the model's `parallel` admission cap: with
// `parallel` in flight, admitting one more waits FIFO until a slot frees.
//
// RUN: ./gradlew run -Pexample=MultiJobCompletion

import io.tether.qvac.sdk.JvmBareRpcTransport
import io.tether.qvac.sdk.QvacClient
import io.tether.qvac.sdk.QvacCompletionCancelledException
import io.tether.qvac.sdk.QvacCompletionOptions
import io.tether.qvac.sdk.QvacGenerationOptions
import io.tether.qvac.sdk.QvacMessage
import io.tether.qvac.sdk.QvacProgressEvent
import io.tether.qvac.sdk.completion
import io.tether.qvac.sdk.generated.ModelConstant
import io.tether.qvac.sdk.generated.Models
import io.tether.qvac.sdk.generated.schema.LoadModelResponse
import io.tether.qvac.sdk.generated.schema.ModelProgressResponse
import io.tether.qvac.sdk.models
import io.tether.qvac.sdk.run
import kotlin.time.TimeSource
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

private val PROMPTS = listOf(
    "cherry" to "Reply with only the word CHERRY.",
    "banana" to "Reply with only the word BANANA.",
    "grape" to "Reply with only the word GRAPE.",
    "lemon" to "Reply with only the word LEMON.",
)

fun main(): Unit = runBlocking {
    val client = QvacClient(JvmBareRpcTransport.connectResolved(installWorkerIfMissing = true))
    try {
        // `parallel: 4` opens the concurrent decode slots continuous batching needs.
        val modelId = client.loadWithProgress(
            Models.LLAMA_3_2_1B_INST_Q4_0,
            modelConfig = buildJsonObject {
                put("ctx_size", 4096)
                put("parallel", 4)
            },
        )
        println("▸ Model loaded: $modelId")

        // ---- Concurrent completions. Fire every call before awaiting any, so
        // all four are admitted and decode together (not one-after-another). ----
        println("\n▸ Firing 4 completions concurrently:")
        val started = TimeSource.Monotonic.markNow()
        val runs = PROMPTS.map { (_, ask) ->
            client.completion.run(
                modelId = modelId,
                history = listOf(QvacMessage.user(ask)),
                options = QvacCompletionOptions(
                    generation = QvacGenerationOptions(temperature = 0.0, seed = 42, predict = 16),
                ),
            )
        }

        val finals = runs.map { it.final }.awaitAll()
        val elapsedMs = started.elapsedNow().inWholeMilliseconds

        PROMPTS.zip(finals).forEach { (prompt, final) ->
            val tps = final.stats?.tokensPerSecond?.let { "%.1f".format(it) } ?: "n/a"
            println("  ▸ ${prompt.first}: \"${final.text.collapseWhitespace()}\"  (own $tps tok/s)")
        }

        // Report the engine's own measure of overlap rather than inferring it
        // from wall-clock: averageConcurrentSequences > 1 means the addon
        // decoded sequences together.
        val peakConcurrent = finals.maxOf { it.stats?.averageConcurrentSequences ?: 0.0 }
        println(
            "\n▸ All 4 finished in $elapsedMs ms; engine avg concurrent " +
                "sequences: %.1f (> 1 = decoded together).".format(peakConcurrent),
        )

        // ---- Per-request cancel isolation. Fire two long runs; cancel only the
        // first by its requestId. The second must keep decoding past the cancel. ----
        println("\n▸ Per-request cancel: cancelling one of two in-flight completions:")
        val doomed = client.completion.run(
            modelId = modelId,
            history = listOf(QvacMessage.user("Write a long story about an otter.")),
            options = QvacCompletionOptions(
                generation = QvacGenerationOptions(temperature = 0.0, seed = 1, predict = 256),
            ),
        )
        val survivor = client.completion.run(
            modelId = modelId,
            history = listOf(QvacMessage.user("Write a long story about a melon.")),
            options = QvacCompletionOptions(
                generation = QvacGenerationOptions(temperature = 0.0, seed = 42, predict = 256),
            ),
        )

        // Wait until BOTH runs are actually streaming before cancelling, so the
        // cancel hits a genuinely in-flight peer, not a pre-admission drop.
        // `events` is backed by one channel per run: every collector drains the
        // same queue, so `first()` takes one event and leaves the rest for the
        // later collection below.
        listOf(async { doomed.events.first() }, async { survivor.events.first() }).awaitAll()

        doomed.cancel()

        val doomedCancelled = try {
            doomed.final.await()
            false
        } catch (_: QvacCompletionCancelledException) {
            true
        }

        // Drain what the survivor emits from here on: a per-request cancel
        // leaves it decoding to completion, a model-wide cancel would have
        // stopped it.
        var tokensAfterCancel = 0
        survivor.events.collect { tokensAfterCancel++ }

        val survivorText = survivor.final.await().text.collapseWhitespace()
        println("  ▸ cancelled run -> ${if (doomedCancelled) "cancelled" else "NOT cancelled"}")
        println("  ▸ peer kept decoding -> +$tokensAfterCancel tokens after the cancel ack")

        client.models.unload(modelId)

        // A clean exit must prove concurrent scheduling, typed cancellation, and
        // survivor isolation: the first burst reported multiple resident
        // sequences, the doomed run cancelled, and its peer produced tokens
        // AFTER the cancel landed.
        check(peakConcurrent > 1 && doomedCancelled && tokensAfterCancel > 0) {
            "✖ multi-job behavior not demonstrated (peakConcurrent=%.2f, ".format(peakConcurrent) +
                "doomedCancelled=$doomedCancelled, tokensAfterCancel=$tokensAfterCancel, " +
                "survivorText=\"$survivorText\")"
        }
    } finally {
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
