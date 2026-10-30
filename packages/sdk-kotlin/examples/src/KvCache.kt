// Kotlin port of packages/sdk/examples/kv-cache-example.ts.
//
// `QvacKvCache.Enabled(true)` asks the SDK to key the cache off the
// conversation itself, so a follow-up turn reprocesses only the new message.
// The three completions below show the effect: the first builds the cache, the
// second reuses it, and the third replays the same history with
// `QvacKvCache.Enabled(false)` to compare.
//
// Read `promptTokens` to see it work — on a warm turn it counts only the tokens
// the model actually processed, not the whole prompt. `cacheTokens` is what the
// cache holds after the turn.
//
// `QvacKvCache` is a sealed type: `Enabled(true/false)` for the auto-keyed
// cache, or `Key("name")` for a named one, so an invalid mix cannot be built.
// `QvacCompletionStats.raw` keeps the stats object exactly as the worker sent
// it, so the printed keys read like the JS stats object.
//
// RUN: ./gradlew run -Pexample=KvCache

import io.tether.qvac.sdk.JvmBareRpcTransport
import io.tether.qvac.sdk.QvacClient
import io.tether.qvac.sdk.QvacCompletionFinal
import io.tether.qvac.sdk.QvacCompletionOptions
import io.tether.qvac.sdk.QvacCompletionRun
import io.tether.qvac.sdk.QvacKvCache
import io.tether.qvac.sdk.QvacMessage
import io.tether.qvac.sdk.completion
import io.tether.qvac.sdk.generated.Models
import io.tether.qvac.sdk.models
import io.tether.qvac.sdk.run
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

fun main(): Unit = runBlocking {
    val client = QvacClient(JvmBareRpcTransport.connectResolved(installWorkerIfMissing = true))
    try {
        val model = Models.LLAMA_3_2_1B_INST_Q4_0
        val loaded = client.models.load(
            source = model.src,
            modelType = model.engine,
            modelName = model.name,
            modelConfig = buildJsonObject {
                put("device", "gpu")
                put("ctx_size", 2048)
                put("verbosity", 0) // 0=ERROR, 1=WARN, 2=INFO, 3=DEBUG
            },
        )
        val modelId = loaded.modelId ?: error(loaded.error ?: "loadModel failed")

        println("▸ Testing KV Cache functionality...\n")

        println("▸ First conversation (building cache for the next turn):")
        val history1 = listOf(QvacMessage.user("What is the capital of France?"))
        val run1 = client.completion.run(
            modelId = modelId,
            history = history1,
            options = QvacCompletionOptions(stream = true, kvCache = QvacKvCache.Enabled(true)),
        )
        val final1 = streamTurn(run1, "First completion")

        // Continue conversation (should reuse the completed first-turn cache).
        println("▸ Continuing conversation (reusing previous turn cache):")
        val history2 = listOf(
            QvacMessage.user("What is the capital of France?"),
            // The cacheable form drops any thinking block, so the history sent
            // back matches what the cache was keyed on.
            QvacMessage.assistant(final1.cacheableAssistantContent.orEmpty().ifEmpty { final1.text }),
            QvacMessage.user("What about Germany?"),
        )

        // Auto-keyed caching should:
        // 1. Find the cache saved after turn 1 under [user, assistant]
        // 2. Load that cache and process only the new "What about Germany?" user turn
        // 3. Save the updated cache and rename it to include the new assistant response
        val run2 = client.completion.run(
            modelId = modelId,
            history = history2,
            options = QvacCompletionOptions(stream = true, kvCache = QvacKvCache.Enabled(true)),
        )
        streamTurn(run2, "Second completion")

        // Compare with non-cached version
        println("▸ Same conversation without cache:")
        val run3 = client.completion.run(
            modelId = modelId,
            history = history2,
            options = QvacCompletionOptions(stream = true, kvCache = QvacKvCache.Enabled(false)),
        )
        streamTurn(run3, "Non-cached completion")

        println("▸ KV Cache test completed!")

        client.models.unload(modelId)
    } finally {
        client.close()
    }
}

/** Print the tokens as they arrive, then the turn's stats. */
private suspend fun streamTurn(run: QvacCompletionRun, label: String): QvacCompletionFinal {
    run.tokens.collect { print(it) }
    val final = run.final.await()
    println("\n▸ $label stats: ${final.stats?.raw ?: "{}"}\n")
    return final
}
