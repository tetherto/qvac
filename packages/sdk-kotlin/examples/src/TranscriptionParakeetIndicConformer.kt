// Kotlin port of packages/sdk/examples/asr/parakeet-indic-conformer-filesystem.ts.
//
// Indic Conformer CTC transcription from a WAV file. Loads a single GGUF
// checkpoint (`Models.PARAKEET_INDIC_CONFORMER_600M_Q8_0` by default) and
// transcribes with the batch `client.speech.transcribe()` API. `language` is
// required (e.g. `hi`, `ta`) because Indic Conformer CTC masks the vocab with
// `parakeet.ctc.lang_*` ranges. English Parakeet CTC ignores this field.
//
// As in TypeScript, `transcribe()` returns the joined text
// (`QvacTranscriptionResult.text`), so there are no frames to join by hand.
//
// Audio should be 16 kHz mono PCM in a WAV container.
//
// RUN: ./gradlew run -Pexample=TranscriptionParakeetIndicConformer --args="<wav-file> <language> [indic-conformer-gguf]"

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
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

fun main(args: Array<String>): Unit = runBlocking {
    if (args.size < 2) {
        System.err.println(
            "Usage: ./gradlew run -Pexample=TranscriptionParakeetIndicConformer " +
                "--args=\"<wav-file> <language> [indic-conformer-gguf]\"",
        )
        System.err.println("\nExample: ... -Pexample=TranscriptionParakeetIndicConformer --args=\"speech.wav hi\"")
        System.err.println("If the model path is omitted, defaults to the registry model.")
        exitProcess(1)
    }
    val audioPath = args[0]
    val language = args[1]
    val parakeetModelSrc = args.getOrNull(2) ?: Models.PARAKEET_INDIC_CONFORMER_600M_Q8_0.src

    val client = QvacClient(JvmBareRpcTransport.connectResolved(installWorkerIfMissing = true))
    try {
        println("▸ Loading Indic Conformer CTC model...")
        val modelId = client.loadWithProgress(
            parakeetModelSrc,
            "parakeet-transcription",
            modelConfig = buildJsonObject { put("language", language) },
        )
        println("▸ Indic Conformer CTC model loaded with ID: $modelId")
        println("▸ Language: $language")

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
