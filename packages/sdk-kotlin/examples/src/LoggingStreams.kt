// Kotlin port of packages/sdk/examples/logging-streaming.ts.
//
// Stream SDK-server and per-model logs concurrently with inference.
// `client.serverLogs(id)` is a cold `Flow` of log records; `id` is a model id,
// `"__sdk__"` for the SDK server, or `"__all__"` (the default) for everything.
//
// Each subscription is a child coroutine (`launch`) of the script's scope:
// collecting the `Flow` opens the stream, and cancelling the `Job` closes it at
// the RPC layer. `catch` drops a stream failure so it never fails the demo,
// while cancellation still propagates.
//
// RUN: ./gradlew run -Pexample=LoggingStreams

import io.tether.qvac.sdk.JvmBareRpcTransport
import io.tether.qvac.sdk.QvacClient
import io.tether.qvac.sdk.QvacCompletionOptions
import io.tether.qvac.sdk.QvacGenerationOptions
import io.tether.qvac.sdk.QvacMessage
import io.tether.qvac.sdk.completion
import io.tether.qvac.sdk.generated.Models
import io.tether.qvac.sdk.models
import io.tether.qvac.sdk.run
import io.tether.qvac.sdk.serverLogs
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** The SDK server's own log stream id. */
private const val SDK_LOG_ID = "__sdk__"

fun main(): Unit = runBlocking {
    val client = QvacClient(JvmBareRpcTransport.connectResolved(installWorkerIfMissing = true))
    val subscriptions = mutableListOf<Job>()
    try {
        println("▸ Streaming SDK and model logs")

        println("▸ Subscribing to SDK server logs")
        subscriptions += drainLogs(client, SDK_LOG_ID, "SDK")

        println("▸ Loading model")
        val model = Models.LLAMA_3_2_1B_INST_Q4_0
        val loaded = client.models.load(
            source = model.src,
            modelType = model.engine,
            modelName = model.name,
            modelConfig = buildJsonObject {
                put("ctx_size", 2048)
                put("temp", 0.7)
            },
        )
        val modelId = loaded.modelId ?: error(loaded.error ?: "loadModel failed")

        println("▸ Subscribing to model logs")
        subscriptions += drainLogs(client, modelId, "LLM")

        println("▸ Response")
        val run = client.completion.run(
            modelId = modelId,
            history = listOf(QvacMessage.user("Count from 1 to 5 and explain each number.")),
            // Bound the generation: at temp 0.7 a 1B model can ignore "to 5" and
            // ramble past ctx_size (2048) into a context overflow. This demo only
            // needs enough tokens to show logs streaming.
            options = QvacCompletionOptions(generation = QvacGenerationOptions(predict = 512)),
        )
        run.tokens.collect { print(it) }
        println()

        println("▸ Two streams ran: [SDK] server, [LLM] inference")
        client.models.unload(modelId)
    } finally {
        subscriptions.forEach { it.cancel() }
        client.close()
    }
}

private fun CoroutineScope.drainLogs(client: QvacClient, logId: String, tag: String): Job = launch {
    client.serverLogs(logId)
        .catch { }
        .collect { log -> println("[$tag] [${log.level.name}] [${log.namespace}] ${log.message}") }
}
