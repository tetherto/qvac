// Kotlin port of packages/sdk/examples/diffusion-simple.ts.
//
// Minimal diffusion example: a single GGUF model, no companion files needed.
// Works with SD 1.x / 2.x all-in-one models.
//
// `client.media.diffusion()` returns a `QvacMediaRun`: an `events` Flow (per-step
// progress) and a `final` Deferred that aggregates the base64 images and the
// closing stats. Like the TypeScript `outputs` promise, this example awaits only
// `final` and never collects `events`.
//
// RUN: ./gradlew run -Pexample=DiffusionSimple --args="[model-src] [prompt]"

import io.tether.qvac.sdk.JvmBareRpcTransport
import io.tether.qvac.sdk.QvacClient
import io.tether.qvac.sdk.generated.Models
import io.tether.qvac.sdk.media
import io.tether.qvac.sdk.models
import java.nio.file.Files
import java.nio.file.Path
import java.util.Base64
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

fun main(args: Array<String>): Unit = runBlocking {
    val modelSrc = args.getOrNull(0) ?: Models.SD_V2_1_1B_Q8_0.src
    val prompt = args.getOrNull(1) ?: "a photo of a cat sitting on a windowsill"

    val client = QvacClient(JvmBareRpcTransport.connectResolved(installWorkerIfMissing = true))
    try {
        val loaded = client.models.load(
            source = modelSrc,
            modelType = "sdcpp-generation",
            modelConfig = buildJsonObject { put("prediction", "v") },
        )
        val modelId = loaded.modelId ?: error(loaded.error ?: "loadModel failed")

        val result = client.media.diffusion(modelId = modelId, prompt = prompt).final.await()

        Files.write(Path.of("output.png"), Base64.getDecoder().decode(result.data.first()))
        println("▸ Saved output.png")

        client.models.unload(modelId)
    } finally {
        client.close()
    }
}
