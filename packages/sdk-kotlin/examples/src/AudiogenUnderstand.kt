// Kotlin port of packages/sdk/examples/audiogen/understand-music.ts.
//
// Describe an existing recording with ACE-Step's reverse pipeline: the engine
// encodes the audio, recovers its FSQ semantic codes, and the LM reports a
// caption and the clip's musical metadata.
//
// `client.audioUnderstand()` is the generated contract method: a `Flow` of
// typed `AudioUnderstandResponse` frames, where TypeScript's `audioUnderstand`
// resolves a `description` promise. The description arrives in a frame's
// `understand` field; progress ticks and the terminal stats frame share the
// same flow. `sourceAudio` is a sealed class: wrap a path in `FilePath`, or
// pass `Base64` when the audio is already in memory as raw interleaved stereo
// 48 kHz Float32 LE PCM in [-1, 1]. The source here is a file path: the SDK
// decodes it (any FFmpeg-decodable format) to the 48 kHz stereo float PCM the
// engine expects.
//
// RUN: ./gradlew run -Pexample=AudiogenUnderstand --args="<source-audio> [language]"

import io.tether.qvac.sdk.JvmBareRpcTransport
import io.tether.qvac.sdk.QvacClient
import io.tether.qvac.sdk.QvacProgressEvent
import io.tether.qvac.sdk.audioUnderstand
import io.tether.qvac.sdk.generated.Models
import io.tether.qvac.sdk.generated.schema.AudioGenStreamRequestSourceAudioFilePath
import io.tether.qvac.sdk.generated.schema.AudioGenStreamResponseProgress
import io.tether.qvac.sdk.generated.schema.AudioGenStreamResponseStats
import io.tether.qvac.sdk.generated.schema.AudioUnderstandRequest
import io.tether.qvac.sdk.generated.schema.AudioUnderstandRequestSourceAudio
import io.tether.qvac.sdk.generated.schema.AudioUnderstandResponseUnderstand
import io.tether.qvac.sdk.generated.schema.LoadModelResponse
import io.tether.qvac.sdk.generated.schema.ModelProgressResponse
import io.tether.qvac.sdk.generated.schema.TextToSpeechResponseStopReason
import io.tether.qvac.sdk.models
import io.tether.qvac.sdk.qvacRequestId
import kotlin.system.exitProcess
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.serializer

fun main(args: Array<String>): Unit = runBlocking {
    val sourcePath = args.getOrNull(0)
    val vocalLanguage = args.getOrNull(1)

    if (sourcePath.isNullOrEmpty()) {
        System.err.println("Usage: ./gradlew run -Pexample=AudiogenUnderstand --args=\"<source-audio> [language]\"")
        exitProcess(1)
    }

    val client = QvacClient(JvmBareRpcTransport.connectResolved(installWorkerIfMissing = true))
    try {
        println("▸ Loading ACE-Step AudioGen models...")
        val modelId = client.loadWithProgress(
            source = "",
            modelType = "audiogen-ggml",
            modelConfig = buildJsonObject {
                put("textEncModelSrc", Models.AUDIOGEN_QWEN3_EMBEDDING_0_6B_Q8_0.src)
                put("lmModelSrc", Models.AUDIOGEN_ACESTEP_5HZ_LM_0_6B_Q8_0.src)
                put("ditModelSrc", Models.AUDIOGEN_ACESTEP_V15_TURBO_Q4_K_M.src)
                put("vaeModelSrc", Models.AUDIOGEN_VAE_BF16.src)
                put("useGPU", true)
            },
        )
        println("▸ Model loaded: $modelId")
        println("▸ Analysing $sourcePath")

        try {
            val requestId = qvacRequestId()
            val request = AudioUnderstandRequest(
                modelId = modelId,
                requestId = requestId,
                sourceAudio = AudioUnderstandRequestSourceAudio.FilePath(
                    AudioGenStreamRequestSourceAudioFilePath(value = sourcePath),
                ),
                // Forced into the result instead of the LM's guess; null lets it decide.
                vocalLanguage = vocalLanguage,
                seed = 11,
            )
            println("▸ requestId: $requestId")

            var description: AudioUnderstandResponseUnderstand? = null
            var stats: AudioGenStreamResponseStats? = null
            var cancelled = false

            client.audioUnderstand(request).collect { response ->
                response.progress?.let(::printStage)
                response.understand?.let { description = it }
                if (response.done) {
                    stats = response.stats
                    cancelled = response.stopReason == TextToSpeechResponseStopReason.CANCELLED
                }
            }
            if (cancelled) error("Analysis cancelled")

            val result = description ?: error("AudioUnderstand stream ended without a description")
            println("▸ Caption: ${result.caption}")
            println("▸ ${result.bpm} BPM, ${result.keyscale}, ${result.timesignature}")
            println("▸ Vocal language: ${result.vocalLanguage}")
            // The LM's duration is an estimate; the recovered codes fix the true length.
            println("▸ Estimated duration: %.1f s".format(result.duration))
            println("▸ Recovered ${result.audioCodes.size} semantic codes")
            stats?.let {
                val reported = it.copy(understand = null)
                println("▸ Stats: ${Json.encodeToString(serializer<AudioGenStreamResponseStats>(), reported)}")
            }

            // `audioCodes` is the same `List<Long>` a generation takes, so it feeds
            // straight back in to re-synthesize the piece without re-running the LM:
            //   AudioGenStreamRequest(modelId = modelId, caption = result.caption, audioCodes = result.audioCodes)
        } finally {
            client.models.unload(modelId)
            println("▸ Model unloaded")
        }
    } finally {
        client.close()
    }
}

private fun printStage(progress: AudioGenStreamResponseProgress) {
    val value = if (progress.total > 0) "${progress.step}/${progress.total}" else "${progress.step} (indeterminate)"
    println("▸ ${progress.stage}: $value")
}

/** Load [source] as [modelType], printing download progress, and return its model id. */
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
    val line = "▸ Downloading %.0f%% (%.1f/%.1f MB)".format(p.percentage, p.downloaded / 1e6, p.total / 1e6)
    if (System.console() != null) System.err.print("\r$line") else System.err.println(line)
    if (p.percentage >= 100) System.err.println()
}
