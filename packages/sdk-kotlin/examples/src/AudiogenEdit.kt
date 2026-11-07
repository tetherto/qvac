// Kotlin port of packages/sdk/examples/audiogen/edit-music.ts.
//
// Edit an existing recording with ACE-Step: a Flow-Edit that re-conditions the
// whole clip from a source prompt to a target prompt, then a Repaint that
// regenerates one time range against a new prompt. Operations run in order.
//
// The source must run at least REPAINT_END seconds: the Repaint below asks for a
// fixed window, and a range past the end of the source is rejected with
// `repaint.start must be within the source duration`.
//
// `client.audioEditStream()` is the generated contract method: one `Flow` of
// typed `AudioEditStreamResponse` frames carrying progress ticks, base64 PCM
// chunks and the terminal stats frame, so the example decodes and joins the
// chunks itself. `operations` is a list of the sealed
// `AudioEditStreamRequestOperationsItem` (`FlowEdit` or `Repaint`), and
// `sourceAudio` a sealed class: wrap a path in `FilePath`, or pass `Base64`
// when the audio is already in memory as raw interleaved stereo 48 kHz Float32
// LE PCM in [-1, 1].
//
// RUN: ./gradlew run -Pexample=AudiogenEdit --args="<source-audio> [from-caption] [to-caption] [output.wav]"

import io.tether.qvac.sdk.JvmBareRpcTransport
import io.tether.qvac.sdk.QvacClient
import io.tether.qvac.sdk.QvacProgressEvent
import io.tether.qvac.sdk.audioEditStream
import io.tether.qvac.sdk.generated.Models
import io.tether.qvac.sdk.generated.schema.AudioEditStreamRequest
import io.tether.qvac.sdk.generated.schema.AudioEditStreamRequestOperationsItem
import io.tether.qvac.sdk.generated.schema.AudioEditStreamRequestOperationsItemFlowEdit
import io.tether.qvac.sdk.generated.schema.AudioEditStreamRequestOperationsItemFlowEditFrom
import io.tether.qvac.sdk.generated.schema.AudioEditStreamRequestOperationsItemFlowEditTo
import io.tether.qvac.sdk.generated.schema.AudioEditStreamRequestOperationsItemRepaint
import io.tether.qvac.sdk.generated.schema.AudioEditStreamRequestOperationsItemRepaintMode
import io.tether.qvac.sdk.generated.schema.AudioEditStreamRequestSourceAudio
import io.tether.qvac.sdk.generated.schema.AudioGenStreamRequestSourceAudioFilePath
import io.tether.qvac.sdk.generated.schema.AudioGenStreamResponseProgress
import io.tether.qvac.sdk.generated.schema.AudioGenStreamResponseStats
import io.tether.qvac.sdk.generated.schema.LoadModelResponse
import io.tether.qvac.sdk.generated.schema.ModelProgressResponse
import io.tether.qvac.sdk.generated.schema.TextToSpeechResponseStopReason
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
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.serializer

// Repaint window, in seconds from the start of the source.
private const val REPAINT_START = 10.0
private const val REPAINT_END = 20.0

fun main(args: Array<String>): Unit = runBlocking {
    val sourcePath = args.getOrNull(0)
    val fromCaption = args.getOrNull(1) ?: "Original pop song"
    val toCaption = args.getOrNull(2) ?: "Guitar pop-rock"
    val outputPath = args.getOrNull(3) ?: "audiogen-edit.wav"

    if (sourcePath.isNullOrEmpty()) {
        System.err.println(
            "Usage: ./gradlew run -Pexample=AudiogenEdit " +
                "--args=\"<source-audio> [from-caption] [to-caption] [output.wav]\"",
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
                // Flow-Edit needs a turbo DiT variant; Repaint works on every variant.
                put("ditModelSrc", Models.AUDIOGEN_ACESTEP_V15_TURBO_Q4_K_M.src)
                put("vaeModelSrc", Models.AUDIOGEN_VAE_BF16.src)
                put("useGPU", true)
            },
        )
        println("▸ Model loaded: $modelId")
        println("▸ Editing $sourcePath: \"$fromCaption\" -> \"$toCaption\"")

        try {
            val requestId = qvacRequestId()
            val request = AudioEditStreamRequest(
                modelId = modelId,
                requestId = requestId,
                sourceAudio = AudioEditStreamRequestSourceAudio.FilePath(
                    AudioGenStreamRequestSourceAudioFilePath(value = sourcePath),
                ),
                operations = listOf(
                    AudioEditStreamRequestOperationsItem.FlowEdit(
                        AudioEditStreamRequestOperationsItemFlowEdit(
                            from = AudioEditStreamRequestOperationsItemFlowEditFrom(caption = fromCaption),
                            to = AudioEditStreamRequestOperationsItemFlowEditTo(caption = toCaption),
                        ),
                    ),
                    // Regenerate the repaint window as a synth solo; the rest is kept.
                    AudioEditStreamRequestOperationsItem.Repaint(
                        AudioEditStreamRequestOperationsItemRepaint(
                            caption = "analog synth solo",
                            lyrics = "[Instrumental]",
                            start = REPAINT_START,
                            end = REPAINT_END,
                            mode = AudioEditStreamRequestOperationsItemRepaintMode.BALANCED,
                            strength = 0.5,
                        ),
                    ),
                ),
                // Seeds the first operation; each following operation uses seed + its index.
                seed = 22883,
            )
            println("▸ requestId: $requestId")

            val pcm = ByteArrayOutputStream()
            var sampleRate: Long? = null
            var channels: Long? = null
            var bitsPerSample: Long? = null
            var stats: AudioGenStreamResponseStats? = null
            var cancelled = false

            client.audioEditStream(request).collect { response ->
                response.progress?.let(::printStage)
                response.data?.let {
                    pcm.write(Base64.getDecoder().decode(it))
                    sampleRate = response.sampleRate
                    channels = response.channels
                    bitsPerSample = response.bitsPerSample
                }
                if (response.done) {
                    stats = response.stats
                    cancelled = response.stopReason == TextToSpeechResponseStopReason.CANCELLED
                }
            }
            if (cancelled) error("Edit cancelled")

            val rate = sampleRate
            val channelCount = channels
            val bits = bitsPerSample
            if (rate == null || channelCount == null || bits == null || bits % 8 != 0L || pcm.size() == 0) {
                error("AudioEdit stream ended without audio data")
            }

            writeWav(pcm.toByteArray(), rate.toInt(), channelCount.toInt(), bits.toInt(), outputPath)
            stats?.let { println("▸ Stats: ${Json.encodeToString(serializer<AudioGenStreamResponseStats>(), it)}") }
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
