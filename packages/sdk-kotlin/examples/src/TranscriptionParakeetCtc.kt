// Kotlin port of packages/sdk/examples/asr/parakeet-ctc-filesystem.ts.
//
// Parakeet CTC transcription from a WAV file. Loads a single GGUF checkpoint
// (`Models.PARAKEET_CTC_0_6B_Q8_0` by default) and transcribes the file with the
// batch `client.speech.transcribe()` API. Omit the model argument to use the
// registry constant.
//
// As in TypeScript, `transcribe()` returns the joined text
// (`QvacTranscriptionResult.text`), so there are no frames to join by hand.
//
// Audio should be 16 kHz mono PCM in a WAV container.
//
// RUN: ./gradlew run -Pexample=TranscriptionParakeetCtc --args="<wav-file> [parakeet-ctc-gguf]"

import io.tether.qvac.sdk.JvmBareRpcTransport
import io.tether.qvac.sdk.QvacClient
import io.tether.qvac.sdk.QvacDataInput
import io.tether.qvac.sdk.QvacProgressEvent
import io.tether.qvac.sdk.generated.Models
import io.tether.qvac.sdk.generated.schema.LoadModelResponse
import io.tether.qvac.sdk.generated.schema.ModelProgressResponse
import io.tether.qvac.sdk.models
import io.tether.qvac.sdk.speech
import kotlin.system.exitProcess
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject

fun main(args: Array<String>): Unit = runBlocking {
    if (args.isEmpty()) {
        System.err.println(
            "Usage: ./gradlew run -Pexample=TranscriptionParakeetCtc --args=\"<wav-file> [parakeet-ctc-gguf]\"",
        )
        System.err.println("\nIf the model path is omitted, defaults to the registry model.")
        exitProcess(1)
    }
    val audioPath = args[0]
    val parakeetModelSrc = args.getOrNull(1) ?: Models.PARAKEET_CTC_0_6B_Q8_0.src

    val client = QvacClient(JvmBareRpcTransport.connectResolved(installWorkerIfMissing = true))
    try {
        println("▸ Loading Parakeet CTC model...")
        val modelId = client.loadWithProgress(parakeetModelSrc, "parakeet-transcription")
        println("▸ Parakeet CTC model loaded with ID: $modelId")

        println("▸ Transcribing audio...")
        val result = client.speech.transcribe(modelId, QvacDataInput.FilePath(audioPath))

        println(result.text)

        println("▸ Unloading model...")
        client.models.unload(modelId)
        println("▸ Done")
    } finally {
        client.close()
    }
}

/** Load [source] as [modelType], printing download progress, and return its model id. */
private suspend fun QvacClient.loadWithProgress(
    source: String,
    modelType: String,
    modelConfig: JsonObject? = null,
): String {
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
    val line = "▸ Downloading %.0f%% (%.1f/%.1f MB)".format(p.percentage, p.downloaded / 1e6, p.total / 1e6)
    if (System.console() != null) System.err.print("\r$line") else System.err.println(line)
    if (p.percentage >= 100) System.err.println()
}
