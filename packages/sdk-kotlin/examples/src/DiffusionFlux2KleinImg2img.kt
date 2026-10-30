// Kotlin port of packages/sdk/examples/diffusion-flux2-klein-img2img.ts.
//
// img2img with FLUX.2 [klein] split-layout -- uses in-context conditioning
// ("flux2_flow").
//
// TypeScript's `diffusion()` takes `init_image` as raw bytes and base64-encodes
// them on the way to the worker. The typed `DiffusionStreamRequest` carries the
// already-encoded string, so the example encodes the file with
// `java.util.Base64`. The returned `QvacMediaRun` splits the stream like
// TypeScript does: `events` (a `Flow` of per-step progress) and `final` (a
// `Deferred` with the images and the closing stats).
//
// No `width`/`height` is passed, so the generation runs at the input image's
// size. A large input therefore means much more work per step.
//
// RUN: ./gradlew run -Pexample=DiffusionFlux2KleinImg2img --args="<input-image> [prompt] [output-dir] [diffusion-src] [llm-src] [vae-src]"

import io.tether.qvac.sdk.JvmBareRpcTransport
import io.tether.qvac.sdk.QvacClient
import io.tether.qvac.sdk.QvacProgressEvent
import io.tether.qvac.sdk.generated.Models
import io.tether.qvac.sdk.generated.schema.DiffusionStreamRequest
import io.tether.qvac.sdk.generated.schema.LoadModelResponse
import io.tether.qvac.sdk.generated.schema.ModelProgressResponse
import io.tether.qvac.sdk.media
import io.tether.qvac.sdk.models
import java.nio.file.Files
import java.nio.file.Path
import java.util.Base64
import kotlin.system.exitProcess
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

fun main(args: Array<String>): Unit = runBlocking {
    val inputPath = args.getOrNull(0)
    val prompt = args.getOrNull(1) ?: "oil painting style, vibrant colors"
    val outputDir = Path.of(args.getOrNull(2) ?: ".")
    val diffusionModelSrc = args.getOrNull(3) ?: Models.FLUX_2_KLEIN_4B_Q4_0.src
    val llmModelSrc = args.getOrNull(4) ?: Models.QWEN3_4B_Q4_K_M.src
    val vaeModelSrc = args.getOrNull(5) ?: Models.FLUX_2_KLEIN_4B_VAE.src

    if (inputPath.isNullOrEmpty()) {
        System.err.println("✖ input image path is required")
        System.err.println(
            "Usage: ./gradlew run -Pexample=DiffusionFlux2KleinImg2img --args=\"<inputImage> " +
                "[prompt] [outputDir] [diffusionModelSrc] [llmModelSrc] [vaeModelSrc]\"",
        )
        exitProcess(1)
    }

    val client = QvacClient(JvmBareRpcTransport.connectResolved(installWorkerIfMissing = true))
    try {
        println("▸ Loading FLUX.2 [klein] split-layout model...")
        val modelId = client.loadWithProgress(
            source = diffusionModelSrc,
            modelType = "sdcpp-generation",
            modelConfig = buildJsonObject {
                put("device", "gpu")
                put("threads", 4)
                put("llmModelSrc", llmModelSrc)
                put("vaeModelSrc", vaeModelSrc)
                put("prediction", "flux2_flow")
            },
        )
        println("▸ Model loaded: $modelId")

        val initImage = Base64.getEncoder().encodeToString(Files.readAllBytes(Path.of(inputPath)))
        println("▸ Transforming \"$inputPath\" with prompt: \"$prompt\"")

        val run = client.media.diffusion(
            DiffusionStreamRequest(
                modelId = modelId,
                prompt = prompt,
                init_image = initImage,
                steps = 20,
                guidance = 3.5,
                cfg_scale = 1.0,
                seed = -1,
            ),
        )
        run.events.collect { event ->
            if (event.step != null && event.totalSteps != null) {
                println("▸ step %.0f/%.0f".format(event.step, event.totalSteps))
            }
        }
        val result = run.final.await()

        result.data.forEachIndexed { index, image ->
            val outputPath = outputDir.resolve("flux2_img2img_$index.png")
            Files.write(outputPath, Base64.getDecoder().decode(image))
            println("▸ Saved $outputPath")
        }

        println("▸ Stats: ${result.stats}")

        client.models.unload(modelId)
        println("▸ Done")
    } finally {
        client.close()
    }
}

/** Load [source] as [modelType], printing download progress, and return its model id. */
private suspend fun QvacClient.loadWithProgress(
    source: String,
    modelType: String,
    modelConfig: JsonObject? = null,
): String {
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

private fun printProgress(p: ModelProgressResponse) {
    val line = "▸ Downloading %.0f%% (%.1f/%.1f MB)".format(p.percentage, p.downloaded / 1e6, p.total / 1e6)
    if (System.console() != null) System.err.print("\r$line") else System.err.println(line)
    if (p.percentage >= 100) System.err.println()
}
