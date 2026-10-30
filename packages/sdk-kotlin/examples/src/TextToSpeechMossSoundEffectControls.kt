// Kotlin port of packages/sdk/examples/tts/moss-sound-effect-controls.ts.
//
// Desktop MOSS-SoundEffect-v2, 48 kHz mono output. A GPU is recommended.
// Optional: QVAC_MOSS_SFX_MODEL=/absolute/path/moss-sfx-v2-q8_0.gguf
// Use the catalog source URL: its full descriptor selects the audiogen plugin.
// Each clip denoises a 30-second latent, regardless of its requested output
// duration. This example adds the generation controls: a `negativePrompt`, the
// number of `steps`, the `guidance` scale and the scheduler `shift`.
//
// The controls are typed properties of the generated `TextToSpeechRequest`
// (`steps: Long?`, `guidance: Double?`, `shift: Double?`), so the compiler
// checks names and types. `client.textToSpeech()` returns a
// `Flow<TextToSpeechResponse>`: the example collects each frame's `buffer` and
// reads `sampleRate` and `done` off them. The model is unloaded in a `finally`
// block, as the TypeScript example does.
//
// RUN: ./gradlew run -Pexample=TextToSpeechMossSoundEffectControls

import io.tether.qvac.sdk.JvmBareRpcTransport
import io.tether.qvac.sdk.QvacClient
import io.tether.qvac.sdk.QvacProgressEvent
import io.tether.qvac.sdk.generated.Models
import io.tether.qvac.sdk.generated.schema.LoadModelResponse
import io.tether.qvac.sdk.generated.schema.ModelProgressResponse
import io.tether.qvac.sdk.generated.schema.TextToSpeechRequest
import io.tether.qvac.sdk.models
import io.tether.qvac.sdk.textToSpeech
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.floor
import kotlin.math.roundToInt
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

fun main(): Unit = runBlocking {
    val client = QvacClient(JvmBareRpcTransport.connectResolved(installWorkerIfMissing = true))
    try {
        val modelId = client.loadWithProgress(
            source = System.getenv("QVAC_MOSS_SFX_MODEL") ?: Models.AUDIOGEN_MOSS_SFX_V2_Q8_0.src,
            modelType = "tts-ggml",
            modelConfig = buildJsonObject {
                put("ttsEngine", "moss-sfx")
                put("useGPU", true)
                put("seed", 42)
            },
        )
        try {
            System.err.println("▸ Generating a sound effect...")
            val request = TextToSpeechRequest(
                modelId = modelId,
                text = "A dog barking twice in a quiet room.",
                stream = false,
                seconds = 3.0,
                negativePrompt = "Speech, music, background voices.",
                steps = 20,
                guidance = 4.0,
                shift = 5.0,
            )

            val samples = mutableListOf<Double>()
            var sampleRate: Long? = null
            var done = false
            client.textToSpeech(request).collect { response ->
                samples += response.buffer
                response.sampleRate?.let { sampleRate = it }
                done = done || response.done
            }

            check(done) { "Sound-effect generation did not complete." }
            check(sampleRate == 48000L) { "Unexpected sound-effect sample rate: $sampleRate" }
            saveWav(samples, 48000, "moss-sound-effect-controls-output.wav")
        } finally {
            client.models.unload(modelId)
        }
    } finally {
        client.close()
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
