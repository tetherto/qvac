// Kotlin port of packages/sdk/examples/diffusion-txt2vid-wan22.ts.
//
// Text-to-video with Wan 2.2 TI2V-5B Turbo (Q5_K_S). Like Wan 2.1 this is a
// split layout -- diffusion model + UMT5-XXL text encoder + VAE -- but it needs
// the Wan 2.2 VAE specifically: its 16x spatial compression is what gives TI2V
// its 32-pixel grid, and the Wan 2.1 VAE is not interchangeable.
//
// TI2V-5B is a single-expert model. The high_noise_* / moe_boundary fields
// belong to the two-expert Wan 2.2 A14B layout and are rejected here.
//
// Budget at least 16 GB of video memory or 20 GB of unified memory. The
// artifacts total roughly 16.4 GB, dominated by the fp16 text encoder.
//
// The text encoder is byte-identical to the Wan 2.1 repackage, so both
// generations share the one UMT5_XXL_FP16 registry entry.
//
// `client.media.video()` returns a `QvacMediaRun`: progress arrives on the
// `events` Flow, and the clips and stats on the `final` Deferred, as TypeScript
// splits them.
//
// RUN: ./gradlew run -Pexample=DiffusionTxt2vidWan22 --args="[diffusion-src] [t5-src] [vae-src] [prompt] [output-dir]"

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
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

fun main(args: Array<String>): Unit = runBlocking {
    val diffusionModelSrc = args.getOrNull(0) ?: Models.WAN2_2_TI2V_5B_Q5_K_S.src
    val t5XxlModelSrc = args.getOrNull(1) ?: Models.UMT5_XXL_FP16.src
    val vaeModelSrc = args.getOrNull(2) ?: Models.WAN_2_2_COMFYUI_REPACKAGED_VAE.src
    // Prompt tip: Turbo responds well to explicit camera and lighting direction.
    // Describe continuous motion rather than a pose, or the clip reads as a
    // still.
    val prompt = args.getOrNull(3)
        ?: ("A single white porcelain espresso cup on a dark walnut table beside " +
            "a sunlit window, delicate steam curling upward, slow circular camera " +
            "move, warm morning light, sharp ceramic texture, realistic continuous " +
            "motion")
    val outputDir = Path.of(args.getOrNull(4) ?: ".")

    println("▸ Loading Wan 2.2 TI2V-5B Turbo model (diffusion + UMT5-XXL + Wan 2.2 VAE)...")

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
                put("diffusion_fa", true)
                put("offload_to_cpu", true)
                put("vae_tiling", true)
            },
        )
        println("▸ Model loaded: $modelId")

        println("\n▸ Generating video for: \"$prompt\"")

        val run = client.media.video(
            VideoStreamRequest(
                modelId = modelId,
                mode = VideoStreamRequestMode.TXT2VID,
                prompt = prompt,
                negative_prompt = "flickering, temporal jitter, morphing, duplicated subject, " +
                    "warped geometry, distorted anatomy, blurry details, low " +
                    "resolution, text, watermark, logo",
                // TI2V-5B requires width and height to be multiples of 32 --
                // stricter than the multiple of 16 the schema enforces for Wan
                // generally. Native validation derives this from the loaded
                // GGUF, so a non-conforming size fails at generation time
                // rather than at load.
                // Turbo was trained on this 720p, 24 fps, five-second shape;
                // 640x352 with 49 frames is a much cheaper way to smoke-test
                // the pipeline.
                width = 1280,
                height = 704,
                // Frame count must satisfy (4*k + 1), k >= 1. At 24 fps:
                // 49 ~= 2s, 121 ~= 5s (the trained length).
                video_frames = 121,
                fps = 24.0,
                // Turbo is distilled for very short schedules: 4 steps with
                // guidance effectively disabled. The non-distilled TI2V-5B
                // wants steps >= 30 and cfg ~5.0 instead.
                steps = 4,
                cfg_scale = 1.0,
                flow_shift = 5.0,
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
            val outputPath = outputDir.resolve("wan22_ti2v_t2v_$index.avi")
            Files.write(outputPath, Base64.getDecoder().decode(clip))
            println("▸ Saved $outputPath")
        }

        println("\n▸ Stats: ${result.stats}")

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
