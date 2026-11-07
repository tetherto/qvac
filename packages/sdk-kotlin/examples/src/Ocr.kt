// Kotlin port of packages/sdk/examples/ocr-fasttext.ts.
//
// Run OCR over an image and print the recognized text blocks, each with its
// bounding box and confidence when present.
//
// `client.vision.ocr()` takes a `QvacDataInput` -- a sealed interface, so the
// image is either `QvacDataInput.FilePath` or `QvacDataInput.Base64` -- and
// collects the `ocrStream` frames into one `QvacOcrResult` of `QvacOcrBlock`s.
//
// Pass an image path (BMP/PNG/JPG); the SDK repo ships a sample at
// packages/sdk/examples/image/basic_test.bmp.
//
// RUN: ./gradlew run -Pexample=Ocr --args="<image-path>"

import io.tether.qvac.sdk.JvmBareRpcTransport
import io.tether.qvac.sdk.QvacClient
import io.tether.qvac.sdk.QvacDataInput
import io.tether.qvac.sdk.QvacProgressEvent
import io.tether.qvac.sdk.generated.ModelConstant
import io.tether.qvac.sdk.generated.Models
import io.tether.qvac.sdk.generated.schema.LoadModelResponse
import io.tether.qvac.sdk.generated.schema.ModelProgressResponse
import io.tether.qvac.sdk.models
import io.tether.qvac.sdk.vision
import kotlin.system.exitProcess
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray

fun main(args: Array<String>): Unit = runBlocking {
    if (args.isEmpty()) {
        System.err.println("Usage: ./gradlew run -Pexample=Ocr --args=\"<image-path>\"")
        exitProcess(1)
    }
    val imagePath = args[0]

    val client = QvacClient(JvmBareRpcTransport.connectResolved(installWorkerIfMissing = true))
    try {
        println("▸ Loading OCR model...")
        val modelId = client.loadWithProgress(
            Models.OCR_LATIN,
            modelConfig = buildJsonObject {
                putJsonArray("langList") { add("en") }
                put("magRatio", 1.5)
                putJsonArray("defaultRotationAngles") {
                    add(90)
                    add(180)
                    add(270)
                }
                put("contrastRetry", false)
                put("lowConfidenceThreshold", 0.5)
                put("recognizerBatchSize", 1)
            },
        )
        println("▸ Model loaded: $modelId")

        println("\n▸ Running OCR on: $imagePath")
        val result = client.vision.ocr(modelId, QvacDataInput.FilePath(imagePath), paragraph = false)

        println("\n▸ OCR Results:")
        println("▸ ================================")
        for (block in result.blocks) {
            println(block.text)
            if (block.boundingBox.isNotEmpty()) println("▸ BBox: ${block.boundingBox}")
            block.confidence?.let { println("▸ Confidence: $it") }
        }
        println("▸ ================================")

        println("\n▸ Unloading model...")
        client.models.unload(modelId)
        println("▸ Model unloaded successfully.")
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
