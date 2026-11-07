// Kotlin port of packages/sdk/examples/diffusion-esrgan-upscale.ts.
//
// ESRGAN post-processing: the upscaler is attached to the diffusion model at
// load time via `modelConfig.upscaler`, then triggered per generation with the
// request's `upscale` field. Two generations run from the same seed and
// prompt -- one single pass (x4) and one two-pass (x16) -- so the only
// difference between them is `upscale`.
//
// The ESRGAN constant goes inside `modelConfig` as its `src` string, not as the
// top-level model source. `upscale` is a generated sealed union: `Variant1(true)`
// for a single pass, or the object arm carrying `repeats` for several passes.
// Each `QvacMediaRun` splits progress (`events` Flow) from the images and
// stats (`final` Deferred), as TypeScript does.
//
// RUN: ./gradlew run -Pexample=DiffusionEsrganUpscale --args="[esrgan-src] [prompt] [output-dir]"

import io.tether.qvac.sdk.JvmBareRpcTransport
import io.tether.qvac.sdk.QvacClient
import io.tether.qvac.sdk.QvacMediaRun
import io.tether.qvac.sdk.QvacProgressEvent
import io.tether.qvac.sdk.generated.Models
import io.tether.qvac.sdk.generated.schema.DiffusionStreamRequest
import io.tether.qvac.sdk.generated.schema.DiffusionStreamRequestUpscale
import io.tether.qvac.sdk.generated.schema.DiffusionStreamRequestUpscale9B8B4FE2
import io.tether.qvac.sdk.generated.schema.DiffusionStreamResponse
import io.tether.qvac.sdk.generated.schema.LoadModelResponse
import io.tether.qvac.sdk.generated.schema.ModelProgressResponse
import io.tether.qvac.sdk.media
import io.tether.qvac.sdk.models
import java.nio.file.Files
import java.nio.file.Path
import java.util.Base64
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject

fun main(args: Array<String>): Unit = runBlocking {
    val esrganModelSrc = args.getOrNull(0) ?: Models.REALESRGAN_X4PLUS_ANIME_6B.src
    val prompt = args.getOrNull(1)
        ?: ("an illustrated red fox portrait, clean line art, " +
            "soft watercolor background, detailed fur, crisp eyes")
    val negativePrompt = "blurry, low quality, watermark, text"
    val outputDir = Path.of(args.getOrNull(2) ?: ".")
    val seed = 42L

    println("▸ Loading SD 2.1 + ESRGAN upscaler...")

    val client = QvacClient(JvmBareRpcTransport.connectResolved(installWorkerIfMissing = true))
    try {
        val modelId = client.loadWithProgress(
            source = Models.SD_V2_1_1B_Q8_0.src,
            modelType = "sdcpp-generation",
            modelConfig = buildJsonObject {
                put("prediction", "v")
                putJsonObject("upscaler") {
                    put("type", "esrgan")
                    put("model_src", esrganModelSrc)
                    put("tile_size", 128)
                }
            },
        )
        println("▸ Model loaded: $modelId")

        // Source size is intentionally small -- each ESRGAN repeat multiplies
        // dimensions.
        val baseParams = DiffusionStreamRequest(
            modelId = modelId,
            prompt = prompt,
            negative_prompt = negativePrompt,
            width = 128,
            height = 128,
            steps = 5,
            cfg_scale = 7.5,
            seed = seed,
        )

        println("▸ Generating ESRGAN x4 upscale: \"$prompt\"")
        val single = baseParams.copy(upscale = DiffusionStreamRequestUpscale.Variant1(true))
        saveImages(client.media.diffusion(single), outputDir, "sd2_esrgan_x4_seed$seed")

        println("▸ Generating ESRGAN two-pass x16 upscale...")
        val twoPass = baseParams.copy(
            upscale = DiffusionStreamRequestUpscale.Value9B8B4FE2(DiffusionStreamRequestUpscale9B8B4FE2(repeats = 2)),
        )
        saveImages(client.media.diffusion(twoPass), outputDir, "sd2_esrgan_x16_seed$seed")

        client.models.unload(modelId, clearStorage = false)
    } finally {
        client.close()
    }

    println("▸ Done")
}

/** Print step progress, then write each finished image as `<prefix>_<index>.png` and print the stats. */
private suspend fun saveImages(run: QvacMediaRun<DiffusionStreamResponse>, outputDir: Path, prefix: String) {
    run.events.collect { event ->
        if (event.step != null && event.totalSteps != null) {
            println("▸ step %.0f/%.0f".format(event.step, event.totalSteps))
        }
    }
    val result = run.final.await()

    result.data.forEachIndexed { index, image ->
        val outputPath = outputDir.resolve("${prefix}_$index.png")
        Files.write(outputPath, Base64.getDecoder().decode(image))
        println("▸ Saved $outputPath")
    }

    println("▸ Stats: ${result.stats}")
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
