// Kotlin port of packages/sdk/examples/bci/bci-filesystem-streaming.ts.
//
// Streaming BCI transcription from a neural-signal file.
//
// Reads a raw neural-signal `.bin` file and feeds it to the BCI (whisper.cpp)
// addon chunk-by-chunk through the duplex `client.bciTranscribeStream()`,
// printing transcript text as the sliding window decodes successive windows.
//
// Kotlin note: the duplex input is a cold `Flow<ByteArray>`, not a session
// object to `write()` and `end()`. The transport collects the input Flow while
// you collect the replies, so there is no separate consumer task, and the
// input Flow completing is the end-of-stream signal. The generated
// `bciTranscribeStream` method yields every typed frame as it arrives;
// `client.bci.transcribeStream(modelId, chunks)` takes the same Flow but
// returns only the aggregated result once the stream ends.
//
// RUN: ./gradlew run -Pexample=BciFilesystemStreaming --args="<neural-bin-file-path>"

import io.tether.qvac.sdk.JvmBareRpcTransport
import io.tether.qvac.sdk.QvacClient
import io.tether.qvac.sdk.bciTranscribeStream
import io.tether.qvac.sdk.generated.Models
import io.tether.qvac.sdk.generated.schema.BciTranscribeStreamRequest
import io.tether.qvac.sdk.generated.schema.BciTranscribeStreamRequestStreamOpts
import io.tether.qvac.sdk.generated.schema.BciTranscribeStreamRequestStreamOptsEmit
import io.tether.qvac.sdk.models
import java.io.File
import kotlin.system.exitProcess
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject

// Feed the neural buffer in fixed-size chunks to simulate a live stream.
private const val CHUNK_SIZE = 64 * 1024

fun main(args: Array<String>): Unit = runBlocking {
    if (args.isEmpty()) {
        System.err.println("Usage: ./gradlew run -Pexample=BciFilesystemStreaming --args=\"<neural-bin-file-path>\"")
        exitProcess(1)
    }

    val neuralFilePath = args[0]

    val client = QvacClient(JvmBareRpcTransport.connectResolved(installWorkerIfMissing = true))
    try {
        println("▸ BCI transcribeStream file test")
        println("▸ File: $neuralFilePath")
        println("▸ Chunk size: $CHUNK_SIZE bytes")

        println("▸ Loading model...")
        val loaded = client.models.load(
            source = Models.BCI_WINDOWED.src,
            modelType = Models.BCI_WINDOWED.engine,
            modelName = Models.BCI_WINDOWED.name,
            modelConfig = buildJsonObject {
                putJsonObject("whisperConfig") {
                    put("language", "en")
                    put("n_threads", 4)
                    put("temperature", 0.0)
                }
                // Session day index selects the day-specific projection
                // matrices. Set this to match the recording session your
                // neural file came from.
                putJsonObject("bciConfig") { put("day_idx", 1) }
            },
        )
        val modelId = loaded.modelId ?: error(loaded.error ?: "loadModel failed")
        println("▸ Model loaded: $modelId")

        val data = File(neuralFilePath).readBytes()

        // The input side of the duplex call: completing this Flow ends the stream.
        val neuralChunks = flow {
            var totalBytes = 0
            for (offset in data.indices step CHUNK_SIZE) {
                val chunk = data.copyOfRange(offset, minOf(offset + CHUNK_SIZE, data.size))
                emit(chunk)
                totalBytes += chunk.size
                delay(10)
            }
            println("\n\n▸ Neural signal streamed: $totalBytes bytes")
            println("▸ Waiting for transcription to finish...")
        }

        println("▸ Opening live session...")
        val request = BciTranscribeStreamRequest(
            modelId = modelId,
            streamOpts = BciTranscribeStreamRequestStreamOpts(emit = BciTranscribeStreamRequestStreamOptsEmit.DELTA),
        )
        println("▸ Session open. Streaming neural signal...")

        val transcript = StringBuilder()
        client.bciTranscribeStream(request, neuralChunks).collect { response ->
            response.error?.let { error(it) }
            val text = response.text
            if (!text.isNullOrBlank()) {
                transcript.append(text)
                print(text)
                System.out.flush()
            }
        }

        println("\n▸ Results")
        println(transcript.trim().ifEmpty { "(no text received)" })

        println("▸ Unloading model...")
        client.models.unload(modelId)
        println("▸ Done.")
    } finally {
        client.close()
    }
}
