// Kotlin port of packages/sdk/examples/diffusion-img2vid.ts.
//
// Image-to-video with Wan 2.1 I2V: a first-frame `init_image` animated by a
// motion prompt. The model uses a split layout of four files -- the I2V
// diffusion checkpoint plus UMT5-XXL, the Wan VAE and CLIP vision weights --
// all handed to one load call through `modelConfig`. The sources default to
// the registry constants, so the common case is just an init image path.
//
// TypeScript's `video()` takes `init_image` as raw bytes and base64-encodes
// them on the way to the worker. The typed `VideoStreamRequest` carries the
// encoded string, so the example encodes the file with `java.util.Base64`. The
// returned `QvacMediaRun` splits progress (`events` Flow) from the clips and
// stats (`final` Deferred), as TypeScript does.
//
// RUN: ./gradlew run -Pexample=DiffusionImg2vid --args="<init-image> [prompt] [output-dir] [i2v-src] [t5-src] [vae-src] [clip-vision-src]"

import io.tether.qvac.sdk.JvmBareRpcTransport
import io.tether.qvac.sdk.QvacClient
import io.tether.qvac.sdk.QvacProgressEvent
import io.tether.qvac.sdk.generated.Models
import io.tether.qvac.sdk.generated.schema.LoadModelResponse
import io.tether.qvac.sdk.generated.schema.ModelProgressResponse
import io.tether.qvac.sdk.generated.schema.VideoStreamRequest
import io.tether.qvac.sdk.generated.schema.VideoStreamRequestMode
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
    val initImagePath = args.getOrNull(0)
    val prompt = args.getOrNull(1) ?: "the subject slowly turns and smiles, soft natural lighting, cinematic"
    val outputDir = Path.of(args.getOrNull(2) ?: ".")
    val diffusionModelSrc = args.getOrNull(3) ?: Models.WAN2_1_I2V_14B_Q4_K_M.src
    val t5XxlModelSrc = args.getOrNull(4) ?: Models.UMT5_XXL_FP16.src
    val vaeModelSrc = args.getOrNull(5) ?: Models.WAN_2_1_COMFYUI_REPACKAGED_VAE.src
    val clipVisionModelSrc = args.getOrNull(6) ?: Models.CLIP_VISION_H.src

    if (initImagePath.isNullOrEmpty()) {
        System.err.println("✖ init image path is required")
        System.err.println(
            "Usage: ./gradlew run -Pexample=DiffusionImg2vid --args=\"<initImagePath> " +
                "[prompt] [outputDir] [i2vModelSrc] [t5XxlModelSrc] [vaeModelSrc] [clipVisionModelSrc]\"",
        )
        exitProcess(1)
    }

    println("▸ Loading Wan 2.1 I2V model (diffusion + UMT5-XXL + VAE + CLIP vision)...")

    val client = QvacClient(JvmBareRpcTransport.connectResolved(installWorkerIfMissing = true))
    try {
        val modelId = client.loadWithProgress(
            source = diffusionModelSrc,
            modelType = "sdcpp-generation",
            modelConfig = buildJsonObject {
                put("mode", "video")
                put("device", "gpu")
                put("threads", 4)
                put("t5XxlModelSrc", t5XxlModelSrc)
                put("vaeModelSrc", vaeModelSrc)
                put("clipVisionModelSrc", clipVisionModelSrc)
                put("diffusion_fa", true)
                put("offload_to_cpu", true)
                put("params_backend", "vae=cpu")
                put("vae_tiling", true)
            },
        )
        println("▸ Model loaded: $modelId")

        val initImage = Base64.getEncoder().encodeToString(Files.readAllBytes(Path.of(initImagePath)))
        println("▸ Generating video for: \"$prompt\"")

        val run = client.media.video(
            VideoStreamRequest(
                modelId = modelId,
                mode = VideoStreamRequestMode.IMG2VID,
                prompt = prompt,
                init_image = initImage,
                negative_prompt = "blurry, distorted, low quality, jittery, static, frozen",
                strength = 0.85,
                flow_shift = 3.0,
                video_frames = 33,
                fps = 16.0,
                steps = 30,
                cfg_scale = 6.0,
                seed = 42,
                vae_tiling = true,
            ),
        )
        run.events.collect { event ->
            if (event.step != null && event.totalSteps != null) {
                println("▸ step %.0f/%.0f".format(event.step, event.totalSteps))
            }
        }
        val result = run.final.await()

        result.data.forEachIndexed { index, clip ->
            val outputPath = outputDir.resolve("wan_i2v_$index.avi")
            Files.write(outputPath, Base64.getDecoder().decode(clip))
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
