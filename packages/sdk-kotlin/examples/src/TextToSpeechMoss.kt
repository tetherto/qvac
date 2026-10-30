// Kotlin port of packages/sdk/examples/tts/moss.ts.
//
// MOSS (GGML): OpenMOSS MOSS-TTS v1.5 Delay, an 8B backbone (about 17 GB) plus
// a codec, so desktop only. The primary model source is the backbone; the codec
// decoder loads via `modelConfig`, and the codec encoder is only needed to
// clone a voice from a 24 kHz reference recording (no transcript needed).
//
// MOSS streams natively: with `streamChunkTokens` set, `stream = true` emits a
// chunk every that-many codec frames (12.5 per second) while the backbone is
// still generating, and the text is synthesized as one utterance, so the
// `[pause 1.0s]` marker below and `durationTokens` apply to all of it.
//
// TypeScript reads the stream from `bufferStream` and the rate and stats from
// separate promises. In Kotlin, `client.textToSpeech()` returns a
// `Flow<TextToSpeechResponse>`: the collector sees each chunk as it arrives
// (timing the first one with a monotonic `TimeSource` mark) and reads
// `sampleRate` and the typed `TextToSpeechResponseStats` off the frames. The
// helpers below, ported from the JS example's `utils`, save the samples to a
// WAV and play it through ffplay.
//
// RUN: ./gradlew run -Pexample=TextToSpeechMoss [--args="<reference-audio.wav>"]

import io.tether.qvac.sdk.JvmBareRpcTransport
import io.tether.qvac.sdk.QvacClient
import io.tether.qvac.sdk.QvacProgressEvent
import io.tether.qvac.sdk.generated.ModelConstant
import io.tether.qvac.sdk.generated.Models
import io.tether.qvac.sdk.generated.schema.LoadModelResponse
import io.tether.qvac.sdk.generated.schema.ModelProgressResponse
import io.tether.qvac.sdk.generated.schema.TextToSpeechRequest
import io.tether.qvac.sdk.generated.schema.TextToSpeechResponseStats
import io.tether.qvac.sdk.models
import io.tether.qvac.sdk.textToSpeech
import java.io.File
import java.io.IOException
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.roundToInt
import kotlin.time.TimeSource
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

// Only a fallback: the engine reports the rate it actually produced.
private const val MOSS_SAMPLE_RATE = 24000

fun main(args: Array<String>): Unit = runBlocking {
    val referenceAudioSrc = args.firstOrNull()

    val modelConfig = buildJsonObject {
        put("ttsEngine", "moss")
        put("language", "en")
        put("mossCodecDecoderModelSrc", Models.TTS_CODEC_DECODER_MOSS_TTS_F16.src)
        put("streamChunkTokens", 25)
        put("useGPU", true)
        put("seed", 7)
        if (referenceAudioSrc != null) {
            put("mossCodecEncoderModelSrc", Models.TTS_CODEC_ENCODER_MOSS_TTS_F16.src)
            put("referenceAudioSrc", referenceAudioSrc)
        }
    }

    val client = QvacClient(JvmBareRpcTransport.connectResolved(installWorkerIfMissing = true))
    try {
        val modelId = client.loadWithProgress(Models.TTS_DELAY_LLM_MOSS_TTS_F16, modelConfig)
        println("▸ Model loaded: $modelId")

        println("▸ Streaming MOSS Text-to-Speech...")
        val started = TimeSource.Monotonic.markNow()
        val request = TextToSpeechRequest(
            modelId = modelId,
            text = "Hold on [pause 1.0s] here it comes: speech that starts playing while the rest is " +
                "still being generated.",
            stream = true,
        )

        val samples = mutableListOf<Double>()
        var sampleRate = MOSS_SAMPLE_RATE
        var stats: TextToSpeechResponseStats? = null
        client.textToSpeech(request).collect { response ->
            if (response.buffer.isNotEmpty() && samples.isEmpty()) {
                println("▸ First audio after ${started.elapsedNow().inWholeMilliseconds} ms")
            }
            samples += response.buffer
            response.sampleRate?.let { sampleRate = it.toInt() }
            response.stats?.let { stats = it }
        }

        val frames = stats?.generatedFrames?.let { "%.0f".format(it) } ?: "?"
        val rtf = stats?.realTimeFactor?.let { "%.2f".format(it) } ?: "?"
        println("▸ TTS complete: ${samples.size} samples, $frames codec frames, RTF $rtf")

        createWav(samples, sampleRate, "moss-output.wav")
        println("▸ Audio saved to moss-output.wav")

        println("▸ Playing audio...")
        val audioData = int16ArrayToBuffer(samples)
        playAudio(createWavHeader(audioData.size, sampleRate) + audioData)

        client.models.unload(modelId)
        println("▸ Model unloaded")
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

/** Create a WAV header for 16-bit mono PCM audio. */
private fun createWavHeader(dataLength: Int, sampleRate: Int): ByteArray =
    ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN)
        .put("RIFF".toByteArray(Charsets.US_ASCII)).putInt(36 + dataLength)
        .put("WAVEfmt ".toByteArray(Charsets.US_ASCII))
        .putInt(16).putShort(1).putShort(1).putInt(sampleRate).putInt(sampleRate * 2).putShort(2).putShort(16)
        .put("data".toByteArray(Charsets.US_ASCII)).putInt(dataLength)
        .array()

/** Convert int16 PCM samples to little-endian bytes. */
private fun int16ArrayToBuffer(samples: List<Double>): ByteArray {
    val buffer = ByteBuffer.allocate(samples.size * 2).order(ByteOrder.LITTLE_ENDIAN)
    for (sample in samples) buffer.putShort(sample.roundToInt().coerceIn(-32768, 32767).toShort())
    return buffer.array()
}

/** Create and save a WAV file. */
private fun createWav(samples: List<Double>, sampleRate: Int, filename: String) {
    val audioData = int16ArrayToBuffer(samples)
    File(filename).writeBytes(createWavHeader(audioData.size, sampleRate) + audioData)
    println("▸ WAV file saved as: $filename")
}

/** Play a WAV buffer by streaming it into ffplay over stdin. */
private fun playAudio(wav: ByteArray) {
    val ffplay = try {
        ProcessBuilder("ffplay", "-hide_banner", "-loglevel", "error", "-autoexit", "-nodisp", "-i", "pipe:0")
            .redirectOutput(ProcessBuilder.Redirect.INHERIT)
            .redirectError(ProcessBuilder.Redirect.INHERIT)
            .start()
    } catch (e: IOException) {
        throw IllegalStateException("ffplay not found on PATH. Install ffmpeg (ffplay ships with it) and retry.", e)
    }
    ffplay.outputStream.use { it.write(wav) }
    val code = ffplay.waitFor()
    check(code == 0) { "ffplay exited with code $code" }
}
