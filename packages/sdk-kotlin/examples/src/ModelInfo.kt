// Kotlin port of packages/sdk/examples/cache-management.ts.
//
// Inspect a model's cache/load state, download it if missing, load, unload, and
// re-inspect. `client.models.info()` returns the generated typed
// `GetModelInfoResponse`; `client.models.downloadWithProgress()` is a `Flow` of
// sealed `QvacProgressEvent`s (progress frames, then the result).
//
// RUN: ./gradlew run -Pexample=ModelInfo

import io.tether.qvac.sdk.JvmBareRpcTransport
import io.tether.qvac.sdk.QvacClient
import io.tether.qvac.sdk.QvacProgressEvent
import io.tether.qvac.sdk.generated.Models
import io.tether.qvac.sdk.generated.schema.DownloadAssetResponse
import io.tether.qvac.sdk.generated.schema.GetModelInfoResponseModelInfo
import io.tether.qvac.sdk.generated.schema.ModelProgressResponse
import io.tether.qvac.sdk.models
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.jsonPrimitive

private const val MB = 1024.0 * 1024.0

private val MODEL = Models.WHISPER_TINY

fun main(): Unit = runBlocking {
    val client = QvacClient(JvmBareRpcTransport.connectResolved(installWorkerIfMissing = true))
    try {
        println("▸ Model Info + Cache Management Demo")

        println("\n▸ 1. INITIAL STATUS CHECK")
        val initial = client.fetchInfo()
        printStatus(initial, "Initial Status:")

        if (!initial.isCached) {
            println("\n▸ 2. DOWNLOADING MODEL (not cached)")
            var result: DownloadAssetResponse? = null
            client.models.downloadWithProgress(MODEL.src).collect { event ->
                when (event) {
                    is QvacProgressEvent.Progress -> printProgress(event.value)
                    is QvacProgressEvent.Result -> result = event.value
                }
            }
            val downloaded = checkNotNull(result) { "downloadAsset ended without a result" }
            check(downloaded.success) { downloaded.error ?: "downloadAsset failed" }
            println("▸ Download complete!")
            printStatus(client.fetchInfo(), "Status After Download:")
        } else {
            println("\n▸ 2. MODEL ALREADY CACHED — skipping download")
        }

        println("\n▸ 3. LOADING MODEL INTO MEMORY")
        val loaded = client.models.load(MODEL)
        val modelId = loaded.modelId ?: error(loaded.error ?: "loadModel failed")
        println("▸ Model loaded! ID: $modelId")
        printStatus(client.fetchInfo(), "Status After Load:")

        println("\n▸ 4. UNLOADING MODEL")
        client.models.unload(modelId)
        println("▸ Model unloaded!")
        printStatus(client.fetchInfo(), "Status After Unload:")

        println("\n▸ Demo Complete")
    } finally {
        client.close()
    }
}

private suspend fun QvacClient.fetchInfo(): GetModelInfoResponseModelInfo = models.info(MODEL.name).modelInfo

private fun printStatus(info: GetModelInfoResponseModelInfo, label: String) {
    println("\n▸ $label")
    println("▸ Model Name: ${info.name}")
    println("▸ Model ID: ${info.modelId}")
    println("▸ Expected Size: %.2f MB".format(info.expectedSize / MB))
    println("▸ Addon: ${wireName(info.addon)}")
    println("▸ Cache Files: ${info.cacheFiles.size}")
    println("▸ Is Cached: ${if (info.isCached) "yes" else "no"}")
    println("▸ Is Loaded: ${if (info.isLoaded) "yes" else "no"}")
    val actualSize = info.actualSize
    if (info.isCached && actualSize != null) println("▸ Actual Size: %.2f MB".format(actualSize / MB))
}

private fun printProgress(p: ModelProgressResponse) {
    val line = "▸ Downloading %.0f%% (%.1f/%.1f MB)".format(p.percentage, p.downloaded / 1e6, p.total / 1e6)
    if (System.console() != null) System.err.print("\r$line") else System.err.println(line)
    if (p.percentage >= 100) System.err.println()
}

/** The value as it appears on the wire, e.g. `whisper` rather than `WHISPER`. */
private inline fun <reified T> wireName(value: T): String = Json.encodeToJsonElement(value).jsonPrimitive.content
