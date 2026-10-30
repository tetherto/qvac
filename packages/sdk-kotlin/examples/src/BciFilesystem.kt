// Kotlin port of packages/sdk/examples/bci/bci-filesystem.ts.
//
// Batch BCI transcription from a neural-signal file.
//
// Reads a raw neural-signal `.bin` file, runs it through the BCI (whisper.cpp)
// addon in one shot via `client.bci.transcribe()`, and prints the decoded
// transcript.
//
// As in JS, the call takes the file as a typed input (`QvacDataInput.FilePath`,
// one arm of a sealed interface) and returns the collected segments in
// `QvacTranscriptionResult.segments`; an error frame is thrown as a
// `QvacFeatureException`.
//
// RUN: ./gradlew run -Pexample=BciFilesystem --args="<neural-bin-file-path>"

import io.tether.qvac.sdk.JvmBareRpcTransport
import io.tether.qvac.sdk.QvacClient
import io.tether.qvac.sdk.QvacDataInput
import io.tether.qvac.sdk.QvacProgressEvent
import io.tether.qvac.sdk.bci
import io.tether.qvac.sdk.generated.ModelConstant
import io.tether.qvac.sdk.generated.Models
import io.tether.qvac.sdk.generated.schema.LoadModelResponse
import io.tether.qvac.sdk.generated.schema.ModelProgressResponse
import io.tether.qvac.sdk.models
import kotlin.system.exitProcess
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject

fun main(args: Array<String>): Unit = runBlocking {
    if (args.isEmpty()) {
        System.err.println("Usage: ./gradlew run -Pexample=BciFilesystem --args=\"<neural-bin-file-path>\"")
        exitProcess(1)
    }

    val neuralFilePath = args[0]

    val client = QvacClient(JvmBareRpcTransport.connectResolved(installWorkerIfMissing = true))
    try {
        println("▸ Starting BCI transcription example...")

        println("▸ Loading BCI model...")
        val modelId = client.loadWithProgress(
            Models.BCI_WINDOWED,
            modelConfig = buildJsonObject {
                putJsonObject("whisperConfig") {
                    put("language", "en")
                    put("n_threads", 4)
                    put("temperature", 0.0)
                }
                // Session day index selects the day-specific projection
                // matrices. Set this to match the recording session your
                // neural file came from.
                putJsonObject("bciConfig") { put("day_idx", 1) }
            },
        )
        println("▸ BCI model loaded with ID: $modelId")

        println("▸ Transcribing neural signal...")
        val result = client.bci.transcribe(
            modelId = modelId,
            neuralData = QvacDataInput.FilePath(neuralFilePath),
            metadata = true,
        )

        println("▸ Transcription result:")
        for (segment in result.segments) {
            val start = "%.2f".format(segment.startMs / 1000)
            val end = "%.2f".format(segment.endMs / 1000)
            println("  [${start}s → ${end}s] (id=${segment.id.toLong()}, append=${segment.append}) ${segment.text}")
        }
        println(result.segments.joinToString("") { it.text }.trim())

        println("▸ Unloading BCI model...")
        client.models.unload(modelId)
        println("▸ BCI model unloaded successfully")
    } finally {
        client.close()
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
