// Kotlin port of packages/sdk/examples/llamacpp-sharded.ts.
//
// Load a model distributed as multiple shards, tracking per-shard download
// progress, then stream a completion against it.
//
// Sharded models can be loaded from:
// 1. HTTP archives: "https://example.com/model.tar.gz"
// 2. HTTP pattern: "https://example.com/model-00001-of-00005.gguf"
// 3. Hyperdrive: use any sharded model source/constant, eg: Models.LLAMA_3_2_1B_INST_Q4_0_SHARD
// 4. Local filesystem: pass the path to the first shard file (Note: All shards must
//    be in the same directory)
// 5. Local archive: pass the path to the archive file (.tar, .tar.gz, .tgz)
//
// Progress frames are the generated typed `ModelProgressResponse`; its nullable
// `shardInfo` tells shard-pattern downloads apart from archive downloads.
//
// RUN: ./gradlew run -Pexample=ShardedModels

import io.tether.qvac.sdk.JvmBareRpcTransport
import io.tether.qvac.sdk.QvacClient
import io.tether.qvac.sdk.QvacCompletionEvent
import io.tether.qvac.sdk.QvacMessage
import io.tether.qvac.sdk.QvacProgressEvent
import io.tether.qvac.sdk.completion
import io.tether.qvac.sdk.generated.schema.LoadModelResponse
import io.tether.qvac.sdk.generated.schema.ModelProgressResponse
import io.tether.qvac.sdk.models
import io.tether.qvac.sdk.run
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

private const val MODEL_SRC = "https://huggingface.co/Qwen/Qwen2.5-Coder-7B-Instruct-GGUF/" +
    "resolve/main/qwen2.5-coder-7b-instruct-q4_0-00001-of-00002.gguf"

fun main(): Unit = runBlocking {
    val client = QvacClient(JvmBareRpcTransport.connectResolved(installWorkerIfMissing = true))
    try {
        val modelId = client.loadWithProgress(
            MODEL_SRC,
            modelType = "llamacpp-completion",
            modelConfig = buildJsonObject {
                put("device", "gpu")
                put("ctx_size", 2048)
                put("verbosity", 0) // 0=ERROR, 1=WARN, 2=INFO, 3=DEBUG
            },
        )

        val run = client.completion.run(
            modelId = modelId,
            history = listOf(
                QvacMessage.user(
                    "What are the benefits of sharding large language models? Use emojis in your response.",
                ),
            ),
        )

        println("\n▸ Model response:")
        run.events.collect { event ->
            if (event is QvacCompletionEvent.ContentDelta) {
                print(event.text)
                System.out.flush()
            }
        }

        val final = run.final.await()
        println("\n\n▸ Performance Stats: ${final.stats?.raw}")

        client.models.unload(modelId, clearStorage = false)
    } finally {
        client.close()
    }
}

/** Load [source], printing shard download progress, and return its model id. */
private suspend fun QvacClient.loadWithProgress(source: String, modelType: String, modelConfig: JsonObject): String {
    var result: LoadModelResponse? = null
    models.loadWithProgress(source, modelType, modelConfig = modelConfig).collect { event ->
        when (event) {
            is QvacProgressEvent.Progress -> printProgress(event.value)
            is QvacProgressEvent.Result -> result = event.value
        }
    }
    val loaded = checkNotNull(result) { "loadModel ended without a result" }
    return loaded.modelId ?: error(loaded.error ?: "loadModel failed")
}

private fun printProgress(p: ModelProgressResponse) {
    // For sharded models, p.shardInfo contains detailed progress for both
    // individual shards AND overall download progress across all shards
    val shardInfo = p.shardInfo
    if (shardInfo != null) {
        // For pattern-based or Hyperdrive shards. The shard counters are doubles
        // on the wire, so format them as integers.
        println(
            "▸ Downloading %s (%.0f/%.0f)".format(shardInfo.shardName, shardInfo.currentShard, shardInfo.totalShards),
        )
        println("   File: %.1f%% (%.2fMB / %.2fMB)".format(p.percentage, mb(p.downloaded), mb(p.total)))
        println(
            "   Overall: %.1f%% (%.2fMB / %.2fMB)".format(
                shardInfo.overallPercentage,
                mb(shardInfo.overallDownloaded),
                mb(shardInfo.overallTotal),
            ),
        )
    } else {
        // For archive-based shards
        println("▸ Progress: %.1f%% (%.2fMB / %.2fMB)".format(p.percentage, mb(p.downloaded), mb(p.total)))
    }
}

private fun mb(bytes: Double) = bytes / 1024 / 1024
