// Kotlin port of packages/sdk/examples/classification/classify-image.ts.
//
// Classify an image using the bundled MobileNetV3-Small model.
//
// The bundled model produces three classes: "food", "report", "other".
// No model source is needed -- the model ships inside @qvac/classification-ggml.
//
// The load uses the typed `GgmlClassification` arm of the generated
// `LoadModelRequest` union, which fixes `modelType` to "ggml-classification";
// an empty `modelSrc` loads the addon's own weights. `client.vision.classify()`
// takes the image as base64, so the example encodes the file with
// `java.util.Base64`, and returns the collected results.
//
// RUN: ./gradlew run -Pexample=ClassifyImage --args="<image-path>"

import io.tether.qvac.sdk.JvmBareRpcTransport
import io.tether.qvac.sdk.QvacClient
import io.tether.qvac.sdk.generated.schema.LoadModelRequest
import io.tether.qvac.sdk.generated.schema.LoadModelSrcRequest
import io.tether.qvac.sdk.generated.schema.LoadModelSrcRequestGgmlClassification
import io.tether.qvac.sdk.models
import io.tether.qvac.sdk.vision
import java.nio.file.Files
import java.nio.file.Path
import java.util.Base64
import kotlin.system.exitProcess
import kotlinx.coroutines.runBlocking

fun main(args: Array<String>): Unit = runBlocking {
    if (args.isEmpty()) {
        System.err.println("Usage: ./gradlew run -Pexample=ClassifyImage --args=\"<image-path>\"")
        exitProcess(1)
    }

    val imagePath = args[0]

    val client = QvacClient(JvmBareRpcTransport.connectResolved(installWorkerIfMissing = true))
    try {
        val loaded = client.models.load(
            LoadModelRequest.LoadModelSrcRequest(
                LoadModelSrcRequest.GgmlClassification(LoadModelSrcRequestGgmlClassification(modelSrc = "")),
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
