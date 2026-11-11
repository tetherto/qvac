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
// `--eu` loads the full 25-language TranscribePsy-250M-EU instead
// (`Models.PARAKEET_TRANSCRIBEPSY_250M_EU_Q8_0`): one GGUF with its CAFE
// language adapters and gate embedded, ggml on every platform, no Core ML
// distribution. `--language` picks its route: `en` for the English trunk,
// `other` for the non-English adapters, or `auto` (the default) to let the gate
// decide from the first seconds of the recording. The route is sent as
// `language` in the load's `modelConfig`.
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
// RUN: ./gradlew -p examples run -Pexample=TranscriptionParakeetTranscribepsy --args="<audio-file> [--eu [--language en|other|auto]] [--coreml] [--window-sec <seconds>]"

import io.tether.qvac.sdk.QvacClient
import io.tether.qvac.sdk.QvacProgressEvent
import io.tether.qvac.sdk.generated.Models
import io.tether.qvac.sdk.generated.schema.LoadModelResponse
import io.tether.qvac.sdk.generated.schema.ModelProgressResponse
import io.tether.qvac.sdk.generated.schema.TranscribeRequest
import io.tether.qvac.sdk.generated.schema.TranscribeRequestAudioChunk
import io.tether.qvac.sdk.generated.schema.TranscribeRequestAudioChunkFilePath
import io.tether.qvac.sdk.generated.schema.TranscribeResponseStats
import io.tether.qvac.sdk.jvm.JvmBareKitTransport
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
private val EU_LANGUAGES = setOf("en", "other", "auto")
private const val USAGE = "Usage: ./gradlew -p examples run -Pexample=TranscriptionParakeetTranscribepsy " +
    "--args=\"<audio-file> [--eu [--language en|other|auto]] [--coreml] [--window-sec <seconds>]\""

private data class Options(
    val audioPath: String,
    val useEu: Boolean,
    val useCoreml: Boolean,
    val language: String?,
    val windowSeconds: Double?,
)

fun main(args: Array<String>): Unit = runBlocking {
    val parsed = parseArgs(args.toList())
    if (parsed == null) {
        System.err.println(USAGE)
        exitProcess(1)
    }
    val (audioPath, useEu, useCoreml, language, windowSeconds) = parsed

    // An explicit window becomes the engine's frame counts; the overlap is
    // shared half and half with each neighbouring window.
    val modelConfig = buildJsonObject {
        if (windowSeconds != null) {
            put("longFormWindowFrames", (windowSeconds * ENCODER_FRAMES_PER_SECOND).roundToLong())
            put(
                "longFormContextFrames",
                (windowSeconds * ENCODER_FRAMES_PER_SECOND * RECOMMENDED_OVERLAP / 2).roundToLong(),
            )
        }
        // The EU route only means something to the full model; EU-sub has no gate.
        if (useEu && language != null) put("language", language)
    }

    val (modelSrc, variant) = when {
        useEu -> Models.PARAKEET_TRANSCRIBEPSY_250M_EU_Q8_0.src to "EU, 25 languages, route ${language ?: "auto"}"
        useCoreml -> Models.PARAKEET_TRANSCRIBEPSY_250M_COREML_Q8_0.src to "EU-sub, Core ML distribution"
        else -> Models.PARAKEET_TRANSCRIBEPSY_250M_Q8_0.src to "EU-sub, ggml"
    }

    val client = QvacClient(JvmBareKitTransport.connect())
    try {
        println("▸ Loading TranscribePsy ($variant)...")
        val modelId = client.loadWithProgress(modelSrc, "parakeet-transcription", modelConfig = modelConfig)

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
    val valueFlags = setOf("--window-sec", "--language")
    val audioPath = args.filterIndexed { index, arg ->
        !arg.startsWith("--") && args.getOrNull(index - 1) !in valueFlags
    }.firstOrNull()
    val useCoreml = "--coreml" in args
    val useEu = "--eu" in args
    var windowSeconds: Double? = null
    val windowIndex = args.indexOf("--window-sec")
    if (windowIndex >= 0) {
        windowSeconds = args.getOrNull(windowIndex + 1)?.toDoubleOrNull() ?: return null
        if (!(windowSeconds > 0)) return null
    }
    var language: String? = null
    val languageIndex = args.indexOf("--language")
    if (languageIndex >= 0) {
        language = args.getOrNull(languageIndex + 1)
        // `--language` needs a value, and only the full EU model has a route to pick.
        if (!useEu || language !in EU_LANGUAGES) return null
    }
    if (audioPath == null || (useEu && useCoreml)) return null
    return Options(audioPath, useEu, useCoreml, language, windowSeconds)
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
