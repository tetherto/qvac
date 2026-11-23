// Kotlin port of packages/sdk/examples/sessions.ts.
//
// Two caller sessions on one runtime. Each session gets its own requests and
// model leases:
//
//   - Both sessions load the same configuration and get the same `modelId`;
//     the second load adds a lease instead of loading the model again.
//   - A session's cancel by request id reaches only its own requests, so the
//     second session's cancel finds nothing and the first session's completion
//     keeps running; the first session's own `run.cancel()` stops it. The
//     second session sends its cancel with `raw.call`, since only a run's own
//     handle has a typed `cancel()`.
//   - `models.unload()` releases the caller's lease. The model unloads when its
//     last lease is released, here when the second session closes.
//
// Only the owner's `client.close()` stops the runtime; it ends every session.
//
// RUN: ./gradlew -p examples run -Pexample=Sessions

import io.tether.qvac.sdk.QvacClient
import io.tether.qvac.sdk.QvacCompletionEvent
import io.tether.qvac.sdk.QvacMessage
import io.tether.qvac.sdk.completion
import io.tether.qvac.sdk.generated.Models
import io.tether.qvac.sdk.jvm.JvmBareKitTransport
import io.tether.qvac.sdk.models
import io.tether.qvac.sdk.openSession
import io.tether.qvac.sdk.raw
import io.tether.qvac.sdk.run
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

fun main(): Unit = runBlocking {
    val client = QvacClient(JvmBareKitTransport.connect())
    try {
        val harness = client.openSession(name = "harness")
        val skillRunner = client.openSession(name = "skill-runner")

        val model = Models.QWEN3_600M_INST_Q4
        val config = buildJsonObject { put("ctx_size", 4096) }
        val loaded = harness.models.load(source = model.src, modelType = model.engine, modelName = model.name, modelConfig = config)
        val modelId = loaded.modelId ?: error(loaded.error ?: "loadModel failed")
        val again = skillRunner.models.load(source = model.src, modelType = model.engine, modelName = model.name, modelConfig = config)
        val leases = client.models.loadedInfo(modelId).info.leaseCount
        println("▸ same model for both sessions: ${again.modelId == modelId}, leases: $leases")

        val run = harness.completion.run(
            modelId = modelId,
            history = listOf(QvacMessage.user("Write a long essay about the history of Rome.")),
        )

        // The skill runner cannot reach the harness's request. The cancel goes
        // through `raw`, since only a run's own handle has a typed `cancel()`.
        val foreign = skillRunner.raw.call(
            buildJsonObject {
                put("type", "cancel")
                put("operation", "request")
                put("requestId", run.requestId)
            },
        )
        println("▸ skill-runner's cancel found ${foreign["cancelled"]} request(s)")

        var deltasAfterForeignCancel = 0
        var stopReason: String? = null
        run.events.collect { event ->
            when (event) {
                is QvacCompletionEvent.ContentDelta -> {
                    deltasAfterForeignCancel++
                    // The harness stops its own completion after a few more tokens.
                    if (deltasAfterForeignCancel == 5) launch { run.cancel() }
                }
                is QvacCompletionEvent.Done -> stopReason = event.stopReason
                else -> Unit
            }
        }
        println("▸ $deltasAfterForeignCancel tokens arrived after skill-runner's cancel; harness's cancel ended the run: stopReason=$stopReason")

        val unloaded = harness.models.unload(modelId)
        println("▸ harness unload: released=${unloaded.released}, unloaded=${unloaded.unloaded}")

        // Closing a session releases its leases; this was the model's last one.
        skillRunner.close()
        println("▸ skill-runner closed and released the last lease")

        harness.close()
    } finally {
        client.close()
    }
}
