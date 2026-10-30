// Kotlin port of packages/sdk/examples/tts/chatterbox.ts.
//
// Chatterbox TTS (GGML): voice cloning with an optional reference audio file.
// Uses registry model constants, which download automatically from the QVAC
// Registry. The S3Gen companion model loads through `modelConfig` as its `src`
// string, the same wire shape as the TS and Python examples.
//
// `client.textToSpeech()` is the generated typed method: it takes a
// `TextToSpeechRequest` data class and returns a `Flow<TextToSpeechResponse>`.
// In non-stream mode it emits the full audio as one frame. Samples come back as
// int16 PCM values; the frame also carries the `sampleRate` the engine actually
// produced. The helpers below, ported from the JS example's `utils`, save them
// to a WAV and play it through ffplay.
//
// RUN: ./gradlew run -Pexample=TextToSpeechChatterbox [--args="<reference-audio>"]

import io.tether.qvac.sdk.JvmBareRpcTransport
import io.tether.qvac.sdk.QvacClient
import io.tether.qvac.sdk.QvacProgressEvent
import io.tether.qvac.sdk.generated.ModelConstant
import io.tether.qvac.sdk.generated.Models
import io.tether.qvac.sdk.generated.schema.LoadModelResponse
import io.tether.qvac.sdk.generated.schema.ModelProgressResponse
import io.tether.qvac.sdk.generated.schema.TextToSpeechRequest
import io.tether.qvac.sdk.models
import io.tether.qvac.sdk.textToSpeech
import java.io.File
import java.io.IOException
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.roundToInt
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

// Only a fallback: the engine reports the rate it actually produced, and
// `outputSampleRate` (plus the LavaSR enhancer) can move it off this default.
private const val CHATTERBOX_SAMPLE_RATE = 24000

fun main(args: Array<String>): Unit = runBlocking {
    val referenceAudioSrc = args.firstOrNull()

    val modelConfig = buildJsonObject {
        put("ttsEngine", "chatterbox")
        put("language", "en")
        put("s3genModelSrc", Models.TTS_S3GEN_EN_CHATTERBOX.src)
        put("streamChunkTokens", 25)
        put("streamFirstChunkTokens", 10)
        put("cfmSteps", 1)
        put("threads", 8)
        if (referenceAudioSrc != null) put("referenceAudioSrc", referenceAudioSrc)
    }

    val client = QvacClient(JvmBareRpcTransport.connectResolved(installWorkerIfMissing = true))
    try {
        val modelId = client.loadWithProgress(Models.TTS_T3_TURBO_EN_CHATTERBOX_Q8_0, modelConfig)
        println("▸ Model loaded: $modelId")

        println("▸ Testing Text-to-Speech...")
        val request = TextToSpeechRequest(
            modelId = modelId,
            text = "QVAC SDK is the canonical entry point to QVAC. Written in TypeScript, it provides all " +
                "QVAC capabilities through a unified interface while also abstracting away the complexity " +
                "of running your application in a JS environment other than Bare. Supported JS " +
                "environments include Bare, Node.js, Expo and Bun.",
            inputType = "text",
            stream = false,
        )

        val samples = mutableListOf<Double>()
        var sampleRate = CHATTERBOX_SAMPLE_RATE
        client.textToSpeech(request).collect { response ->
            samples += response.buffer
            response.sampleRate?.let { sampleRate = it.toInt() }
        }
        println("▸ TTS complete. Total samples: ${samples.size}")

        println("▸ Saving audio to file...")
        createWav(samples, sampleRate, "tts-output.wav")
        println("▸ Audio saved to tts-output.wav")

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
