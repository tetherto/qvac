// Kotlin port of packages/sdk/examples/tts/moss-dialogue.ts.
//
// MOSS-TTSD (GGML): multi-speaker dialogue in one pass, each voice cloned from
// a 24 kHz reference recording. The model continues the references, so the
// text opens with what each recording says under its speaker tag, followed by
// the lines to generate; only the new lines come out as audio. A dialogue is
// never split into sentences, so `stream = true` delivers the native chunks of
// the whole conversation (set `streamChunkTokens` to get them while it is still
// being generated).
//
// The MOSS-TTSD backbone is not in the QVAC Registry yet, so it is a local file
// loaded by path with an explicit `tts-ggml` model type; the codec halves it
// shares with MOSS-TTS download from the registry.
//
// `client.textToSpeech()` returns a `Flow<TextToSpeechResponse>`: the example
// collects each frame's `buffer` and reads `sampleRate` off them. The helpers
// below, ported from the JS example's `utils`, save the samples to a WAV and
// play it through ffplay.
//
// RUN: ./gradlew run -Pexample=TextToSpeechMossDialogue
//      --args='<moss-ttsd.gguf> <s1.wav> "<s1 transcript>" <s2.wav> "<s2 transcript>"'

import io.tether.qvac.sdk.JvmBareRpcTransport
import io.tether.qvac.sdk.QvacClient
import io.tether.qvac.sdk.generated.Models
import io.tether.qvac.sdk.generated.schema.TextToSpeechRequest
import io.tether.qvac.sdk.models
import io.tether.qvac.sdk.textToSpeech
import java.io.File
import java.io.IOException
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.roundToInt
import kotlin.system.exitProcess
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray

// Only a fallback: the engine reports the rate it actually produced.
private const val MOSS_SAMPLE_RATE = 24000

fun main(args: Array<String>): Unit = runBlocking {
    if (args.size < 5 || args.take(5).any { it.isEmpty() }) {
        System.err.println(
            "Usage: ./gradlew run -Pexample=TextToSpeechMossDialogue " +
                "--args='<moss-ttsd.gguf> <s1.wav> \"<s1 transcript>\" <s2.wav> \"<s2 transcript>\"'",
        )
        exitProcess(1)
    }
    val (backbone, s1Audio, s1Text, s2Audio, s2Text) = args

    val client = QvacClient(JvmBareRpcTransport.connectResolved(installWorkerIfMissing = true))
    try {
        val loaded = client.models.load(
            source = backbone,
            modelType = "tts-ggml",
            modelConfig = buildJsonObject {
                put("ttsEngine", "moss")
                put("language", "en")
                put("mossCodecDecoderModelSrc", Models.TTS_CODEC_DECODER_MOSS_TTS_F16.src)
                put("mossCodecEncoderModelSrc", Models.TTS_CODEC_ENCODER_MOSS_TTS_F16.src)
                // One recording per speaker, in the order the text tags them.
                putJsonArray("dialogueReferenceSrcs") {
                    add(s1Audio)
                    add(s2Audio)
                }
                put("streamChunkTokens", 25)
                put("useGPU", true)
            },
        )
        val modelId = loaded.modelId ?: error(loaded.error ?: "loadModel failed")
        println("▸ Model loaded: $modelId")

        println("▸ Synthesizing the dialogue...")
        val request = TextToSpeechRequest(
            modelId = modelId,
            text = "[S1] $s1Text [S2] $s2Text " +
                "[S1] Did the build finish? [S2] Yes, every test passed. " +
                "[S1] Great, ship it.",
            stream = true,
        )

        val samples = mutableListOf<Double>()
        var sampleRate = MOSS_SAMPLE_RATE
        client.textToSpeech(request).collect { response ->
            samples += response.buffer
            response.sampleRate?.let { sampleRate = it.toInt() }
        }
        println("▸ Dialogue complete: ${samples.size} samples")

        createWav(samples, sampleRate, "moss-dialogue-output.wav")
        println("▸ Audio saved to moss-dialogue-output.wav")

        println("▸ Playing audio...")
        val audioData = int16ArrayToBuffer(samples)
        playAudio(createWavHeader(audioData.size, sampleRate) + audioData)

        client.models.unload(modelId)
        println("▸ Model unloaded")
    } finally {
        client.close()
    }
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
