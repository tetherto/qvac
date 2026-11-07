// Kotlin port of packages/sdk/examples/tts/moss-speech.ts.
//
// Desktop MOSS-Speech: answer a typed question with `textReply = true`. This
// mode skips audio decoding and returns text with an empty PCM buffer. Use a
// GPU with enough memory. Registry sources download automatically. Optional
// local paths: QVAC_MOSS_SPEECH_MODEL and QVAC_MOSS_SPEECH_CODEC. Both engines
// run a batch job; `stream = false` collects the complete reply.
//
// The MOSS-Speech fields (`textReply`, `greedy`, `maxNewTokens`,
// `maxReplySeconds`, `systemPrompt`) are typed properties of the generated
// `TextToSpeechRequest`. `client.textToSpeech()` returns a
// `Flow<TextToSpeechResponse>`: the example joins each frame's `text` and
// `buffer` and reads `done` off them. The model is unloaded in a `finally`
// block, as the TypeScript example does.
//
// RUN: ./gradlew run -Pexample=TextToSpeechMossSpeech

import io.tether.qvac.sdk.JvmBareRpcTransport
import io.tether.qvac.sdk.QvacClient
import io.tether.qvac.sdk.QvacProgressEvent
import io.tether.qvac.sdk.generated.Models
import io.tether.qvac.sdk.generated.schema.LoadModelResponse
import io.tether.qvac.sdk.generated.schema.ModelProgressResponse
import io.tether.qvac.sdk.generated.schema.TextToSpeechRequest
import io.tether.qvac.sdk.models
import io.tether.qvac.sdk.textToSpeech
import kotlin.math.floor
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

fun main(): Unit = runBlocking {
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
            System.err.println("▸ Generating a text-only reply...")
            val request = TextToSpeechRequest(
                modelId = modelId,
                text = "What is two plus two? Answer in one short sentence.",
                stream = false,
                textReply = true,
                greedy = true,
                maxNewTokens = 128,
                maxReplySeconds = 5.0,
                systemPrompt = "You are a helpful assistant. Give short, direct answers.",
            )

            val samples = mutableListOf<Double>()
            val reply = StringBuilder()
            var done = false
            client.textToSpeech(request).collect { response ->
                samples += response.buffer
                response.text?.let(reply::append)
                done = done || response.done
            }

            check(done && reply.isNotBlank()) { "The model returned no reply text." }
            println(reply)
            check(samples.isEmpty()) { "A text-only reply must not contain PCM audio." }
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
