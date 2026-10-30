// Kotlin port of packages/sdk/examples/cancel-by-request-id.ts.
//
// Cancel a specific in-flight completion by its request id.
// `completion.run()` exposes a stable `requestId` (UUIDv4, client-generated)
// on the returned run; `run.cancel()` sends a cancel for that exact id.
//
// Cancel surfaces on two channels, matching JS:
//   - `run.events` ends *normally* with a `Done` event carrying
//     `stopReason == "cancelled"` — no exception.
//   - awaiting `run.final` (or `run.text()`) throws the typed
//     `QvacCompletionCancelledException`, whose `partial` holds whatever the
//     model produced before the cancel landed (text, stats, tool calls).
//
// The delayed cancel is a child coroutine (`launch`) of the script's scope, so
// structured concurrency joins it before the scope ends.
//
// RUN: ./gradlew run -Pexample=Cancel

import io.tether.qvac.sdk.JvmBareRpcTransport
import io.tether.qvac.sdk.QvacClient
import io.tether.qvac.sdk.QvacCompletionCancelledException
import io.tether.qvac.sdk.QvacCompletionEvent
import io.tether.qvac.sdk.QvacMessage
import io.tether.qvac.sdk.completion
import io.tether.qvac.sdk.generated.Models
import io.tether.qvac.sdk.models
import io.tether.qvac.sdk.run
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

fun main(): Unit = runBlocking {
    val client = QvacClient(JvmBareRpcTransport.connectResolved(installWorkerIfMissing = true))
    try {
        val model = Models.QWEN3_600M_INST_Q4
        val loaded = client.models.load(
            source = model.src,
            modelType = model.engine,
            modelName = model.name,
            modelConfig = buildJsonObject { put("ctx_size", 4096) },
        )
        val modelId = loaded.modelId ?: error(loaded.error ?: "loadModel failed")

        val run = client.completion.run(
            modelId = modelId,
            history = listOf(QvacMessage.user("Write a long, detailed essay about the history of the Roman Empire.")),
        )
        println("▸ requestId: ${run.requestId}")

        val canceller = launch {
            delay(250)
            run.cancel()
            println("▸ cancel issued")
        }

        // Channel 1: the events stream ends normally on cancel.
        var tokenCount = 0
        var endReason: String? = null
        run.events.collect { event ->
            when (event) {
                is QvacCompletionEvent.ContentDelta -> {
                    tokenCount++
                    print(event.text)
                }
                is QvacCompletionEvent.Done -> endReason = event.stopReason
                else -> Unit
            }
        }
        println("\n\n▸ streamed $tokenCount content deltas, stopReason=$endReason")

        // Channel 2: awaiting the final result throws QvacCompletionCancelledException.
        try {
            val text = run.text()
            println("▸ completed normally (${text.length} chars)")
        } catch (err: QvacCompletionCancelledException) {
            println("▸ run.final rejected: cancelled (requestId=${err.requestId})")
            println("▸ partial text length: ${err.partial.text.length}")
            err.partial.stats?.tokensPerSecond?.let { println("▸ partial stats: %.1f tok/s".format(it)) }
            if (err.partial.toolCalls.isNotEmpty()) println("▸ partial tool calls: ${err.partial.toolCalls.size}")
        }

        canceller.join()
        client.models.unload(modelId)
    } finally {
        client.close()
    }
}
