// Kotlin port of packages/sdk/examples/asr/parakeet-transcribepsy-filesystem.ts.
//
// TranscribePsy transcription from an audio file.
//
// TranscribePsy-250M-EU-sub is a 254M Parakeet-TDT distilled for Dutch,
// English, French, German, Italian, Polish, Portuguese and Spanish; the engine
// detects the language, so there is nothing to set. The default constant
// (`Models.PARAKEET_TRANSCRIBEPSY_250M_Q8_0`) runs on ggml everywhere. On macOS
// and iOS, `--coreml` loads the Core ML distribution instead
// (`Models.PARAKEET_TRANSCRIBEPSY_250M_COREML_Q8_0`): the SDK downloads its
// encoder and decoder bundles with the GGUF, and both stages run on the Neural
// Engine. Anywhere else that constant is refused at load time.
//
// Long recordings are encoded in overlapping windows, so memory stays flat
// however long the file is. Without `--window-sec` the engine uses the 60 s
// windows with 25 % overlap the model recommends; an explicit window is sent as
// encoder frames (12.5 per second) with a quarter of it as context, which is how
// a phone with little memory can trade speed for a smaller footprint.
//
// The example uses the generated `client.transcribe(TranscribeRequest)` stream
// so the closing frame's `stats` arrive typed as `TranscribeResponseStats`
// (`audioDuration`, `realTimeFactor`, `encoderUsedCoreml`); the text frames are
// joined as they come. `client.speech.transcribe()` returns the same text with
// the stats as an untyped `JsonObject`.
//
// RUN: ./gradlew run -Pexample=TranscriptionParakeetTranscribepsy --args="<audio-file> [--coreml] [--window-sec <seconds>]"

import io.tether.qvac.sdk.JvmBareRpcTransport
import io.tether.qvac.sdk.QvacClient
import io.tether.qvac.sdk.QvacProgressEvent
import io.tether.qvac.sdk.generated.Models
import io.tether.qvac.sdk.generated.schema.LoadModelResponse
import io.tether.qvac.sdk.generated.schema.ModelProgressResponse
import io.tether.qvac.sdk.generated.schema.TranscribeRequest
import io.tether.qvac.sdk.generated.schema.TranscribeRequestAudioChunk
import io.tether.qvac.sdk.generated.schema.TranscribeRequestAudioChunkFilePath
import io.tether.qvac.sdk.generated.schema.TranscribeResponseStats
import io.tether.qvac.sdk.models
import io.tether.qvac.sdk.transcribe
import kotlin.math.roundToLong
import kotlin.system.exitProcess
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

private const val ENCODER_FRAMES_PER_SECOND = 12.5
private const val RECOMMENDED_OVERLAP = 0.25
private const val USAGE = "Usage: ./gradlew run -Pexample=TranscriptionParakeetTranscribepsy " +
    "--args=\"<audio-file> [--coreml] [--window-sec <seconds>]\""

private data class Options(val audioPath: String, val useCoreml: Boolean, val windowSeconds: Double?)

fun main(args: Array<String>): Unit = runBlocking {
    val parsed = parseArgs(args.toList())
    if (parsed == null) {
        System.err.println(USAGE)
        exitProcess(1)
    }
    val (audioPath, useCoreml, windowSeconds) = parsed

    // An explicit window becomes the engine's frame counts; the overlap is
    // shared half and half with each neighbouring window.
    val longForm = buildJsonObject {
        if (windowSeconds != null) {
            put("longFormWindowFrames", (windowSeconds * ENCODER_FRAMES_PER_SECOND).roundToLong())
            put(
                "longFormContextFrames",
                (windowSeconds * ENCODER_FRAMES_PER_SECOND * RECOMMENDED_OVERLAP / 2).roundToLong(),
            )
        }
    }

    val modelSrc = if (useCoreml) {
        Models.PARAKEET_TRANSCRIBEPSY_250M_COREML_Q8_0.src
    } else {
        Models.PARAKEET_TRANSCRIBEPSY_250M_Q8_0.src
    }

    val client = QvacClient(JvmBareRpcTransport.connectResolved(installWorkerIfMissing = true))
    try {
        val backend = if (useCoreml) "Core ML distribution" else "ggml"
        println("▸ Loading TranscribePsy ($backend)...")
        val modelId = client.loadWithProgress(modelSrc, "parakeet-transcription", modelConfig = longForm)

        println(
            if (windowSeconds == null) {
                "▸ Transcribing with the windows the model recommends (60 s, 25 % overlap)..."
            } else {
                "▸ Transcribing in ${formatSeconds(windowSeconds)} s windows..."
            },
        )
        val request = TranscribeRequest(
            modelId = modelId,
            audioChunk = TranscribeRequestAudioChunk.FilePath(TranscribeRequestAudioChunkFilePath(value = audioPath)),
        )

        val text = StringBuilder()
        var stats: TranscribeResponseStats? = null
        client.transcribe(request).collect { response ->
            response.error?.let { error(it) }
            response.text?.let(text::append)
            response.stats?.let { stats = it }
        }

        println(text)
        stats?.let { s ->
            var summary = "▸ ${fmt(s.audioDuration, 1)} s of audio, real-time factor ${fmt(s.realTimeFactor, 3)}"
            if (useCoreml) {
                val used = if (s.encoderUsedCoreml == 1.0) "yes" else "no"
                summary += ", encoder on Core ML: $used"
            }
            println(summary)
        }

        client.models.unload(modelId)
    } finally {
        client.close()
    }
}

/** Format an optional stat, as TypeScript's `?.toFixed(n) ?? '?'`. */
private fun fmt(value: Double?, digits: Int): String = value?.let { "%.${digits}f".format(it) } ?: "?"

/** Print whole seconds without a trailing `.0`, as Python's `:g`. */
private fun formatSeconds(seconds: Double): String =
    if (seconds % 1.0 == 0.0) seconds.toLong().toString() else seconds.toString()

private fun parseArgs(args: List<String>): Options? {
    val audioPath = args.firstOrNull { !it.startsWith("--") }
    val useCoreml = "--coreml" in args
    var windowSeconds: Double? = null
    val index = args.indexOf("--window-sec")
    if (index >= 0) {
        windowSeconds = args.getOrNull(index + 1)?.toDoubleOrNull() ?: return null
        if (!(windowSeconds > 0)) return null
    }
    if (audioPath == null) return null
    return Options(audioPath, useCoreml, windowSeconds)
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
