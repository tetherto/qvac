// Kotlin port of packages/sdk/examples/diffusion-flux2-klein.ts.
//
// Text-to-image with FLUX.2 [klein], which uses a split layout: the diffusion
// model, an LLM text encoder and a VAE are three separate files handed to one
// load call through `modelConfig`.
//
// `client.media.diffusion()` returns a `QvacMediaRun`, the same split TypeScript
// gets: `events` is a `Flow` of typed `DiffusionStreamResponse` frames (per-step
// progress), and `final` is a `Deferred` with every base64 image plus the
// closing stats. The typed `DiffusionStreamRequest` overload carries the fields
// the convenience overload lacks (`guidance`, `cfg_scale`).
//
// RUN: ./gradlew run -Pexample=DiffusionFlux2Klein --args="[diffusion-src] [llm-src] [vae-src] [prompt] [output-dir]"

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
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

fun main(args: Array<String>): Unit = runBlocking {
    // FLUX.2 [klein] uses a split layout: separate diffusion model + LLM text
    // encoder + VAE
    val diffusionModelSrc = args.getOrNull(0) ?: Models.FLUX_2_KLEIN_4B_Q4_0.src
    val llmModelSrc = args.getOrNull(1) ?: Models.QWEN3_4B_Q4_K_M.src
    val vaeModelSrc = args.getOrNull(2) ?: Models.FLUX_2_KLEIN_4B_VAE.src
    val prompt = args.getOrNull(3) ?: "a futuristic city at sunset, photorealistic"
    val outputDir = Path.of(args.getOrNull(4) ?: ".")

    println("▸ Loading FLUX.2 [klein] split-layout model...")

    val client = QvacClient(JvmBareRpcTransport.connectResolved(installWorkerIfMissing = true))
    try {
        val modelId = client.loadWithProgress(
            source = diffusionModelSrc,
            modelType = "sdcpp-generation",
            modelConfig = buildJsonObject {
                put("device", "gpu")
                put("threads", 4)
                put("llmModelSrc", llmModelSrc)
                put("vaeModelSrc", vaeModelSrc)
            },
        )
        println("▸ Model loaded: $modelId")

        println("▸ Generating: \"$prompt\"")

        val run = client.media.diffusion(
            DiffusionStreamRequest(
                modelId = modelId,
                prompt = prompt,
                width = 512,
                height = 512,
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
            val outputPath = outputDir.resolve("flux2_$index.png")
            Files.write(outputPath, Base64.getDecoder().decode(image))
            println("▸ Saved $outputPath")
        }

        println("▸ Stats: ${result.stats}")

        client.models.unload(modelId)
    } finally {
        client.close()
    }

    println("▸ Done")
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
