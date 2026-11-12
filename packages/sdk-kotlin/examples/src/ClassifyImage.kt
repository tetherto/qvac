// Kotlin port of packages/sdk/examples/classification/classify-image.ts.
//
// Classify an image with MobileNetV3-Small, which produces three classes:
// "food", "report", "other".
//
// The load uses the typed `GgmlClassification` arm of the generated
// `LoadModelRequest` union, which fixes `modelType` to "ggml-classification";
// `modelSrc` is the registry source of `Models.MOBILENETV3_3CLASS_V3_FP16`.
// `client.vision.classify()`
// takes the image as base64, so the example encodes the file with
// `java.util.Base64`, and returns the collected results.
//
// RUN: ./gradlew -p examples run -Pexample=ClassifyImage --args="<image-path>"

import io.tether.qvac.sdk.QvacClient
import io.tether.qvac.sdk.generated.Models
import io.tether.qvac.sdk.generated.schema.LoadModelRequest
import io.tether.qvac.sdk.generated.schema.LoadModelSrcRequest
import io.tether.qvac.sdk.generated.schema.LoadModelSrcRequestGgmlClassification
import io.tether.qvac.sdk.jvm.JvmBareKitTransport
import io.tether.qvac.sdk.models
import io.tether.qvac.sdk.vision
import java.nio.file.Files
import java.nio.file.Path
import java.util.Base64
import kotlin.system.exitProcess
import kotlinx.coroutines.runBlocking

fun main(args: Array<String>): Unit = runBlocking {
    if (args.isEmpty()) {
        System.err.println("Usage: ./gradlew -p examples run -Pexample=ClassifyImage --args=\"<image-path>\"")
        exitProcess(1)
    }

    val imagePath = args[0]

    val client = QvacClient(JvmBareKitTransport.connect())
    try {
        val loaded = client.models.load(
            LoadModelRequest.LoadModelSrcRequest(
                LoadModelSrcRequest.GgmlClassification(
                    LoadModelSrcRequestGgmlClassification(modelSrc = Models.MOBILENETV3_3CLASS_V3_FP16.src),
                ),
            ),
        )
        val modelId = loaded.modelId ?: error(loaded.error ?: "loadModel failed")

        val image = Files.readAllBytes(Path.of(imagePath))
        val results = client.vision.classify(modelId, Base64.getEncoder().encodeToString(image))

        println("Classification results:")
        for (result in results) {
            println("  ${result.label}: ${"%.1f".format(result.confidence * 100)}%")
        }

        client.models.unload(modelId)
    } finally {
        client.close()
    }
}
