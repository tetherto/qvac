// Kotlin port of packages/sdk/examples/audiogen/generate-music.ts.
//
// Generate music with ACE-Step AudioGen and save it as a WAV file.
//
// `client.media.audio()` returns a `QvacMediaRun` like TypeScript's `audioGen`
// run: `events` is a `Flow` of typed `AudioGenStreamResponse` frames (progress
// ticks and PCM chunks), and `final` is a `Deferred` with every base64 PCM
// chunk, the raw `stats` object, and the stop reason. The PCM format arrives on
// the data frames, so the example reads it from `events` and joins the chunks
// from `final`. `AudioGenStreamRequest` is a typed data class that always
// encodes its `type`, so no wire-level workaround is needed.
//
// The engine ships its own weights, so the load passes an empty source and the
// four component models as `*ModelSrc` fields of `modelConfig`.
//
// RUN: ./gradlew run -Pexample=Audiogen--args="'lo-fi hip hop, mellow piano' audiogen-output.wav"

import io.tether.qvac.sdk.JvmBareRpcTransport
import io.tether.qvac.sdk.QvacClient
import io.tether.qvac.sdk.QvacProgressEvent
import io.tether.qvac.sdk.generated.Models
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
    val caption = args.getOrNull(0) ?: "Lo-fi hip hop with mellow piano, soft drums, and warm bass"
    val outputPath = args.getOrNull(1) ?: "audiogen-output.wav"

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
                put("inferenceSteps", 8)
            },
        )
        println("▸ Model loaded: $modelId")

        try {
            val requestId = qvacRequestId()
            val run = client.media.audio(
                AudioGenStreamRequest(
                    modelId = modelId,
                    requestId = requestId,
                    caption = caption,
                    lyrics = "[Instrumental]",
                    seed = 42,
                    duration = 10.0,
                ),
            )
            println("▸ requestId: $requestId")
            println("▸ Generating: $caption")

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

            val pcm = joinPcm(result.data)
            writeWav(pcm, rate.toInt(), channelCount.toInt(), bits.toInt(), outputPath)
            val samplesPerChannel = pcm.size / (bits / 8) / channelCount
            println("▸ Generated $samplesPerChannel samples per channel at $rate Hz ($channelCount channels)")
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
