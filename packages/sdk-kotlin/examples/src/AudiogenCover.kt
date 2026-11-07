// Kotlin port of packages/sdk/examples/audiogen/generate-cover.ts.
//
// Re-render an existing song with a new caption (ACE-Step "cover-nofsq"),
// optionally conditioning the timbre on a second reference clip.
//
// A cover is an ordinary generation with `taskType = COVERNOFSQ`, so it runs
// through `client.media.audio()`: `events` is a `Flow` of typed progress and
// PCM frames, `final` a `Deferred` with the base64 PCM chunks, raw `stats` and
// stop reason. `sourceAudio` and `referenceAudio` are sealed classes: wrap a
// path in `FilePath`, or pass `Base64` when the audio is already in memory as
// raw interleaved stereo 48 kHz Float32 LE PCM. Both inputs here are file
// paths: the SDK decodes them (any FFmpeg-decodable format) to the 48 kHz
// stereo float PCM the engine expects.
//
// RUN: ./gradlew run -Pexample=AudiogenCover --args="<source-audio> [caption] [reference-audio] [output.wav]"

import io.tether.qvac.sdk.JvmBareRpcTransport
import io.tether.qvac.sdk.QvacClient
import io.tether.qvac.sdk.QvacProgressEvent
import io.tether.qvac.sdk.generated.Models
import io.tether.qvac.sdk.generated.schema.AudioGenStreamRequest
import io.tether.qvac.sdk.generated.schema.AudioGenStreamRequestReferenceAudio
import io.tether.qvac.sdk.generated.schema.AudioGenStreamRequestReferenceAudioFilePath
import io.tether.qvac.sdk.generated.schema.AudioGenStreamRequestSourceAudio
import io.tether.qvac.sdk.generated.schema.AudioGenStreamRequestSourceAudioFilePath
import io.tether.qvac.sdk.generated.schema.AudioGenStreamRequestTaskType
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
import kotlin.system.exitProcess
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

fun main(args: Array<String>): Unit = runBlocking {
    val sourcePath = args.getOrNull(0)
    val caption = args.getOrNull(1) ?: "Orchestral arrangement with dramatic strings"
    val referencePath = args.getOrNull(2)
    val outputPath = args.getOrNull(3) ?: "audiogen-cover.wav"

    if (sourcePath.isNullOrEmpty()) {
        System.err.println(
            "Usage: ./gradlew run -Pexample=AudiogenCover " +
                "--args=\"<source-audio> [caption] [reference-audio] [output.wav]\"",
        )
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
        println("▸ Covering $sourcePath as: $caption")

        try {
            val requestId = qvacRequestId()
            val run = client.media.audio(
                AudioGenStreamRequest(
                    modelId = modelId,
                    requestId = requestId,
                    caption = caption,
                    lyrics = "[Instrumental]",
                    taskType = AudioGenStreamRequestTaskType.COVERNOFSQ,
                    sourceAudio = AudioGenStreamRequestSourceAudio.FilePath(
                        AudioGenStreamRequestSourceAudioFilePath(value = sourcePath),
                    ),
                    referenceAudio = referencePath?.let {
                        AudioGenStreamRequestReferenceAudio.FilePath(
                            AudioGenStreamRequestReferenceAudioFilePath(value = it),
                        )
                    },
                    // cover-nofsq keeps the full source context; coverNoiseStrength
                    // blends the initial noise toward the source latent (0 = pure
                    // noise, 1 ~ source).
                    audioCoverStrength = 1.0,
                    coverNoiseStrength = 0.75,
                    seed = 22886,
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
            if (result.stopReason == "cancelled") error("Cover cancelled")

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
