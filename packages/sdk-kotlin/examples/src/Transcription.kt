// Kotlin port of packages/sdk/examples/asr/whispercpp-filesystem.ts.
//
// Transcribe an audio file with per-segment metadata. With `metadata = true`,
// `client.speech.transcribe()` collects every segment ({text, startMs, endMs,
// append, id}) into `QvacTranscriptionResult.segments`.
//
// As in JS, the audio source is a typed value: `QvacDataInput` is a sealed
// interface (`FilePath` or `Base64`), so there is no hand-built
// `{type: "filePath"}` chunk as in Python, and the frames are aggregated for you.
//
// Pass a 16 kHz mono WAV path, e.g. the SDK's own sample
// packages/sdk/examples/audio/sample-16khz.wav.
//
// RUN: ./gradlew run -Pexample=Transcription --args="<wav-file-path>"

import io.tether.qvac.sdk.JvmBareRpcTransport
import io.tether.qvac.sdk.QvacClient
import io.tether.qvac.sdk.QvacDataInput
import io.tether.qvac.sdk.QvacProgressEvent
import io.tether.qvac.sdk.generated.ModelConstant
import io.tether.qvac.sdk.generated.Models
import io.tether.qvac.sdk.generated.schema.LoadModelResponse
import io.tether.qvac.sdk.generated.schema.ModelProgressResponse
import io.tether.qvac.sdk.models
import io.tether.qvac.sdk.speech
import kotlin.system.exitProcess
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

fun main(args: Array<String>): Unit = runBlocking {
    if (args.isEmpty()) {
        System.err.println("Usage: ./gradlew run -Pexample=Transcription --args=\"<wav-file-path>\"")
        exitProcess(1)
    }
    val audioPath = args[0]

    val client = QvacClient(JvmBareRpcTransport.connectResolved(installWorkerIfMissing = true))
    try {
        println("▸ Loading Whisper model...")
        val modelId = client.loadWithProgress(
            Models.WHISPER_TINY,
            modelConfig = buildJsonObject {
                put("audio_format", "f32le")
                put("language", "en")
            },
        )
        println("▸ Whisper model loaded with ID: $modelId")

        println("▸ Transcribing audio...")
        val result = client.speech.transcribe(
            modelId = modelId,
            audio = QvacDataInput.FilePath(audioPath),
            metadata = true,
        )

        println("▸ Transcription result:")
        for (seg in result.segments) {
            val start = seg.startMs / 1000
            val end = seg.endMs / 1000
            println("  [%.2fs → %.2fs]".format(start, end) + " (id=${seg.id}, append=${seg.append}) ${seg.text}")
        }
        println("\nFull transcript: " + result.segments.joinToString("") { it.text }.trim())

        println("▸ Unloading Whisper model...")
        client.models.unload(modelId)
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
