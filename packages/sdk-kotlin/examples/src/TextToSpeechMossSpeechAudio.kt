// Kotlin port of packages/sdk/examples/tts/moss-speech-audio.ts.
//
// Desktop MOSS-Speech: 9B language model + codec, 24 kHz spoken reply and
// text. Pass a spoken question as a WAV file. Use a GPU with enough memory.
// Registry sources download automatically. Optional local paths:
// QVAC_MOSS_SPEECH_MODEL and QVAC_MOSS_SPEECH_CODEC. Both engines run a batch
// job; `stream = false` collects the complete reply.
//
// The question is parsed with a little-endian `ByteBuffer`, which reads the
// same mono/stereo PCM16 and float32 WAVs as the TypeScript example on any host
// byte order (the Python port reads them on little-endian hosts only). The question
// audio, its `sampleRate` and the `messages` turns are typed properties of the
// generated `TextToSpeechRequest`. `client.textToSpeech()` returns a
// `Flow<TextToSpeechResponse>`: the example joins each frame's `text` and
// `buffer` and reads `sampleRate` and `done` off them. The model is unloaded in
// a `finally` block, as the TypeScript example does.
//
// RUN: ./gradlew run -Pexample=TextToSpeechMossSpeechAudio --args="<question.wav>"

import io.tether.qvac.sdk.JvmBareRpcTransport
import io.tether.qvac.sdk.QvacClient
import io.tether.qvac.sdk.QvacProgressEvent
import io.tether.qvac.sdk.generated.Models
import io.tether.qvac.sdk.generated.schema.LoadModelResponse
import io.tether.qvac.sdk.generated.schema.ModelProgressResponse
import io.tether.qvac.sdk.generated.schema.TextToSpeechRequest
import io.tether.qvac.sdk.generated.schema.TextToSpeechRequestMessagesItem
import io.tether.qvac.sdk.generated.schema.TextToSpeechRequestMessagesItemRole
import io.tether.qvac.sdk.models
import io.tether.qvac.sdk.textToSpeech
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.floor
import kotlin.math.roundToInt
import kotlin.system.exitProcess
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

fun main(args: Array<String>): Unit = runBlocking {
    if (args.isEmpty()) {
        System.err.println("Usage: ./gradlew run -Pexample=TextToSpeechMossSpeechAudio --args=\"<question.wav>\"")
        exitProcess(1)
    }
    val (audio, questionRate) = readQuestion(args[0])

    val client = QvacClient(JvmBareRpcTransport.connectResolved(installWorkerIfMissing = true))
    try {
        val modelId = client.loadWithProgress(
            source = System.getenv("QVAC_MOSS_SPEECH_MODEL") ?: Models.TTS_MOSS_SPEECH_Q8_0.src,
            modelType = "tts-ggml",
            modelConfig = buildJsonObject {
                put("ttsEngine", "moss-speech")
                put(
                    "mossSpeechCodecModelSrc",
                    System.getenv("QVAC_MOSS_SPEECH_CODEC") ?: Models.TTS_CODEC_MOSS_SPEECH_F16.src,
                )
                put("useGPU", true)
                put("seed", 42)
            },
        )
        try {
            System.err.println("▸ Generating a spoken reply...")
            val request = TextToSpeechRequest(
                modelId = modelId,
                audio = audio,
                sampleRate = questionRate.toLong(),
                stream = false,
                greedy = true,
                maxNewTokens = 128,
                maxReplySeconds = 5.0,
                messages = listOf(
                    TextToSpeechRequestMessagesItem(
                        role = TextToSpeechRequestMessagesItemRole.USER,
                        text = "Please answer the next spoken turn briefly.",
                    ),
                ),
            )

            val samples = mutableListOf<Double>()
            val reply = StringBuilder()
            var sampleRate: Long? = null
            var done = false
            client.textToSpeech(request).collect { response ->
                samples += response.buffer
                response.text?.let(reply::append)
                response.sampleRate?.let { sampleRate = it }
                done = done || response.done
            }

            check(done) { "Speech generation did not complete." }
            if (reply.isNotBlank()) println(reply) else System.err.println("▸ The model returned an audio-only reply.")
            check(sampleRate == 24000L) { "Unexpected reply sample rate: $sampleRate" }
            saveWav(samples, 24000, "moss-speech-audio-output.wav")
        } finally {
            client.models.unload(modelId)
        }
    } finally {
        client.close()
    }
}

/** Read a mono/stereo PCM16 or float32 WAV as mono float samples. */
private fun readQuestion(path: String): Pair<List<Double>, Int> {
    val bytes = File(path).readBytes()
    val wav = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
    fun tag(at: Int) = String(bytes, at, 4, Charsets.US_ASCII)
    require(bytes.size >= 12 && tag(0) == "RIFF" && tag(8) == "WAVE") { "Question must be a RIFF WAV file." }

    var format = 0
    var channels = 0
    var sampleRate = 0
    var bits = 0
    var data: ByteArray? = null
    var offset = 12
    while (offset + 8 <= bytes.size) {
        val chunkId = tag(offset)
        val size = wav.getInt(offset + 4).toLong() and 0xFFFFFFFFL
        val start = offset + 8
        require(start + size <= bytes.size) { "Truncated WAV chunk." }
        val length = size.toInt()
        when (chunkId) {
            "fmt " -> {
                require(length >= 16) { "Invalid WAV format chunk." }
                format = wav.getShort(start).toInt() and 0xFFFF
                channels = wav.getShort(start + 2).toInt() and 0xFFFF
                sampleRate = wav.getInt(start + 4)
                bits = wav.getShort(start + 14).toInt() and 0xFFFF
            }
            "data" -> data = bytes.copyOfRange(start, start + length)
        }
        offset = start + length + length % 2
    }

    val pcm = requireNotNull(data) { "Use a mono/stereo PCM16 or float32 WAV question." }
    require(channels in 1..2 && ((format == 1 && bits == 16) || (format == 3 && bits == 32))) {
        "Use a mono/stereo PCM16 or float32 WAV question."
    }
    require(sampleRate in 8000..192000) { "WAV sample rate must be 8000–192000 Hz." }
    val frameBytes = bits / 8 * channels
    require(pcm.size % frameBytes == 0) { "Incomplete WAV audio frame." }

    val samples = ByteBuffer.wrap(pcm).order(ByteOrder.LITTLE_ENDIAN)
    val values = if (format == 1) {
        DoubleArray(pcm.size / 2) { samples.getShort(it * 2) / 32768.0 }
    } else {
        DoubleArray(pcm.size / 4) { samples.getFloat(it * 4).toDouble() }
    }
    val audio = List(values.size / channels) { frame ->
        (0 until channels).sumOf { values[frame * channels + it] } / channels
    }
    require(audio.isNotEmpty() && audio.size <= sampleRate * 60) { "Use a non-empty question of at most 60 seconds." }
    return audio to sampleRate
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

private var lastPercentage = -1

/** Print model download progress once per whole percent. */
private fun printProgress(p: ModelProgressResponse) {
    val percentage = floor(p.percentage).toInt()
    if (percentage == lastPercentage) return
    lastPercentage = percentage
    val line = "▸ Downloading %.0f%% (%.1f/%.1f MB)".format(p.percentage, p.downloaded / 1e6, p.total / 1e6)
    if (System.console() != null) System.err.print("\r$line") else System.err.println(line)
    if (p.percentage >= 100) System.err.println()
}

/** Save int16 PCM samples as a 16-bit mono WAV. */
private fun saveWav(samples: List<Double>, sampleRate: Int, path: String) {
    check(samples.isNotEmpty() && samples.all { it.isFinite() }) { "The model returned no usable audio." }
    val wav = ByteBuffer.allocate(44 + samples.size * 2).order(ByteOrder.LITTLE_ENDIAN)
        .put("RIFF".toByteArray(Charsets.US_ASCII)).putInt(36 + samples.size * 2)
        .put("WAVEfmt ".toByteArray(Charsets.US_ASCII))
        .putInt(16).putShort(1).putShort(1).putInt(sampleRate).putInt(sampleRate * 2).putShort(2).putShort(16)
        .put("data".toByteArray(Charsets.US_ASCII)).putInt(samples.size * 2)
    for (sample in samples) wav.putShort(sample.roundToInt().coerceIn(-32768, 32767).toShort())
    File(path).writeBytes(wav.array())
    System.err.println("▸ Saved %s: %d Hz, %.2f seconds".format(path, sampleRate, samples.size.toDouble() / sampleRate))
}
