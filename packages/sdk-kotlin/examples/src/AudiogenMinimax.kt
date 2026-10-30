// Kotlin port of packages/sdk/examples/audiogen/generate-music-minimax.ts.
//
// Generate music with the MiniMax-Music3 AudioGen engine. The SDK does not
// download MiniMax-Music3 from the registry, so both GGUF files are yours to
// bring: point AUDIOGEN_MINIMAX_LM_MODEL and AUDIOGEN_MINIMAX_SYNTH_MODEL at
// them.
//
// MiniMax exposes a smaller input surface than ACE-Step. It rejects the musical
// controls (bpm, keyscale, timesignature, vocalLanguage), the LM and DCW knobs,
// every reference/cover field, and both the edit and understand calls; it
// ignores simpleMode and normalizeLoudness.
//
// `client.media.audio()` returns a `QvacMediaRun`: `events` is a `Flow` of
// typed progress and PCM frames, `final` a `Deferred` with the base64 PCM
// chunks, raw `stats` and stop reason. The PCM format arrives on the data
// frames, so the example reads it from `events` and joins the chunks from
// `final`.
//
// Environment:
//   AUDIOGEN_MINIMAX_LM_MODEL     required, path to mm3-lm-*.gguf
//   AUDIOGEN_MINIMAX_SYNTH_MODEL  required, path to mm3-synth-*.gguf
//   AUDIOGEN_USE_GPU              "1" to run on a GPU when one is usable
//   AUDIOGEN_THREADS              load-time CPU thread count
//   AUDIOGEN_LYRICS               defaults to "[Instrumental]"
//   AUDIOGEN_SEED                 defaults to 7
//   AUDIOGEN_CFG_SCALE            defaults to 1.7
//   AUDIOGEN_MAX_FRAMES           semantic-frame cap, 25 per second
//   AUDIOGEN_STEPS                flow sampling steps
//
// RUN: AUDIOGEN_MINIMAX_LM_MODEL=... AUDIOGEN_MINIMAX_SYNTH_MODEL=... \
//        ./gradlew run -Pexample=AudiogenMinimax --args="[caption] [output.wav]"

import io.tether.qvac.sdk.JvmBareRpcTransport
import io.tether.qvac.sdk.QvacClient
import io.tether.qvac.sdk.QvacProgressEvent
import io.tether.qvac.sdk.generated.schema.AudioGenStreamRequest
import io.tether.qvac.sdk.generated.schema.AudioGenStreamResponseProgress
import io.tether.qvac.sdk.generated.schema.LoadModelResponse
import io.tether.qvac.sdk.generated.schema.ModelProgressResponse
import io.tether.qvac.sdk.media
import io.tether.qvac.sdk.models
import io.tether.qvac.sdk.qvacRequestId
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.Base64
import javax.sound.sampled.AudioFileFormat
import javax.sound.sampled.AudioFormat
import javax.sound.sampled.AudioInputStream
import javax.sound.sampled.AudioSystem
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

fun main(args: Array<String>): Unit = runBlocking {
    val caption = args.getOrNull(0) ?: "Warm cinematic piano with gentle strings"
    val outputPath = args.getOrNull(1) ?: "minimax-music3-output.wav"

    val client = QvacClient(JvmBareRpcTransport.connectResolved(installWorkerIfMissing = true))
    try {
        val threads = numberFromEnv("AUDIOGEN_THREADS")
        val maxFrames = numberFromEnv("AUDIOGEN_MAX_FRAMES")
        val inferenceSteps = numberFromEnv("AUDIOGEN_STEPS")
        val seed = numberFromEnv("AUDIOGEN_SEED")
        val cfgScale = numberFromEnv("AUDIOGEN_CFG_SCALE")

        println("▸ Loading MiniMax-Music3 models...")
        val modelId = client.loadWithProgress(
            source = "",
            modelType = "audiogen-ggml",
            modelConfig = buildJsonObject {
                put("engine", "minimax")
                put("lmModelSrc", requiredModelPath("AUDIOGEN_MINIMAX_LM_MODEL"))
                put("synthModelSrc", requiredModelPath("AUDIOGEN_MINIMAX_SYNTH_MODEL"))
                put("useGPU", System.getenv("AUDIOGEN_USE_GPU") == "1")
                threads?.let { put("threads", it.toInt()) }
            },
        )
        println("▸ Model loaded: $modelId")
        println("▸ Generating: $caption")

        try {
            val requestId = qvacRequestId()
            val run = client.media.audio(
                AudioGenStreamRequest(
                    modelId = modelId,
                    requestId = requestId,
                    caption = caption,
                    lyrics = System.getenv("AUDIOGEN_LYRICS") ?: "[Instrumental]",
                    seed = seed?.toLong() ?: 7,
                    cfgScale = cfgScale ?: 1.7,
                    // maxFrames and duration are mutually exclusive; this example
                    // takes the explicit frame cap when one is set.
                    maxFrames = maxFrames?.toLong(),
                    inferenceSteps = inferenceSteps?.toLong(),
                ),
            )
            println("▸ requestId: $requestId")

            var sampleRate: Long? = null
            var channels: Long? = null
            var bitsPerSample: Long? = null
            run.events.collect { event ->
                event.progress?.let(::printStage)
                if (event.data != null) {
                    sampleRate = event.sampleRate
                    channels = event.channels
                    bitsPerSample = event.bitsPerSample
                }
            }
            val result = run.final.await()
            if (result.stopReason == "cancelled") error("Generation cancelled")

            val rate = sampleRate
            val channelCount = channels
            val bits = bitsPerSample
            if (rate == null || channelCount == null || bits == null || bits % 8 != 0L || result.data.isEmpty()) {
                error("AudioGen stream ended without audio data")
            }

            writeWav(joinPcm(result.data), rate.toInt(), channelCount.toInt(), bits.toInt(), outputPath)
            result.stats?.let { println("▸ Stats: $it") }
            println("▸ Saved $outputPath")
        } finally {
            client.models.unload(modelId)
            println("▸ Model unloaded")
        }
    } finally {
        client.close()
    }
}

private fun requiredModelPath(name: String): String {
    val value = System.getenv(name)
    if (value.isNullOrEmpty()) error("$name is required")
    return value
}

private fun numberFromEnv(name: String): Double? {
    val value = System.getenv(name) ?: return null
    if (value.isBlank()) error("$name must not be empty")
    return value.trim().toDoubleOrNull() ?: error("$name must be a finite number")
}

private fun printStage(progress: AudioGenStreamResponseProgress) {
    val value = if (progress.total > 0) "${progress.step}/${progress.total}" else "${progress.step} (indeterminate)"
    println("▸ ${progress.stage}: $value")
}

private fun joinPcm(chunks: List<String>): ByteArray {
    val pcm = ByteArrayOutputStream()
    chunks.forEach { pcm.write(Base64.getDecoder().decode(it)) }
    return pcm.toByteArray()
}

/** Write signed little-endian PCM as a WAV file. */
private fun writeWav(pcm: ByteArray, sampleRate: Int, channels: Int, bitsPerSample: Int, path: String) {
    val format = AudioFormat(sampleRate.toFloat(), bitsPerSample, channels, true, false)
    val frames = pcm.size.toLong() / format.frameSize
    AudioInputStream(ByteArrayInputStream(pcm), format, frames).use { stream ->
        AudioSystem.write(stream, AudioFileFormat.Type.WAVE, File(path))
    }
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
