// Kotlin port of packages/sdk/examples/logging-global.ts.
//
// Capture every server-side log (SDK server, all models, RAG) with a single
// `subscribeServerLogs` subscription.
//
// The JS example points `QVAC_CONFIG_PATH` at
// `config/logging/logging.config.json`, which sets `loggerConsoleOutput: false`
// to disable the worker's default console output, so the only logs printed are
// the ones the handler below receives. The JVM client takes the worker config
// as the `config` argument of `connectResolved`, so the same setting is passed
// inline.
//
// `subscribeServerLogs(scope, handler)` launches the subscription in the given
// scope and returns its `Job`; cancelling the `Job` is the unsubscribe.
//
// RUN: ./gradlew run -Pexample=LoggingGlobal

import io.tether.qvac.sdk.JvmBareRpcTransport
import io.tether.qvac.sdk.QvacClient
import io.tether.qvac.sdk.QvacMessage
import io.tether.qvac.sdk.completion
import io.tether.qvac.sdk.generated.Models
import io.tether.qvac.sdk.generated.schema.LoggingStreamResponse
import io.tether.qvac.sdk.models
import io.tether.qvac.sdk.run
import io.tether.qvac.sdk.subscribeServerLogs
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

private fun printLog(log: LoggingStreamResponse) {
    println("[SDK] [${log.level.name}] [${log.namespace}] ${log.message}")
}

fun main(): Unit = runBlocking {
    val config = buildJsonObject { put("loggerConsoleOutput", false) }
    val client = QvacClient(JvmBareRpcTransport.connectResolved(installWorkerIfMissing = true, config = config))
    try {
        println("▸ Starting global logging demo...\n")

        // One subscription captures every server-side log (SDK, models, RAG, …)
        // without having to know any stream IDs ahead of time.
        val subscription = client.subscribeServerLogs(this) { printLog(it) }

        val model = Models.LLAMA_3_2_1B_INST_Q4_0
        val loaded = client.models.load(
            source = model.src,
            modelType = model.engine,
            modelName = model.name,
            modelConfig = buildJsonObject { put("ctx_size", 2048) },
        )
        val modelId = loaded.modelId ?: error(loaded.error ?: "loadModel failed")

        val run = client.completion.run(
            modelId = modelId,
            history = listOf(QvacMessage.user("Count from 1 to 5.")),
        )

        println("▸ Response:\n")
        run.tokens.collect { print(it) }

        client.models.unload(modelId)
        subscription.cancel()
    } finally {
        client.close()
    }
}
