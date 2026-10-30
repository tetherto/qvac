// Kotlin port of packages/sdk/examples/diffusion-txt2vid.ts.
//
// Text-to-video with Wan 2.1 T2V 1.3B, which uses a split layout: the diffusion
// model, a UMT5-XXL text encoder and a VAE are three separate files handed to
// one load call through `modelConfig`.
//
// This example needs powerful hardware: at least 16 GB of video memory or 20 GB
// of unified memory.
//
// `client.media.video()` returns a `QvacMediaRun`, the same split TypeScript
// gets: `events` is a `Flow` of typed `VideoStreamResponse` frames (per-step
// progress), and `final` is a `Deferred` with every base64 clip plus the
// closing stats. The typed `VideoStreamRequest` carries the fields the
// convenience overload lacks (negative prompt, fps, flow shift...), and `mode`
// is the generated `VideoStreamRequestMode` enum.
//
// RUN: ./gradlew run -Pexample=DiffusionTxt2vid --args="[diffusion-src] [t5-src] [vae-src] [prompt] [output-dir]"

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
    // Wan 2.1 uses a split layout: diffusion model + UMT5-XXL text encoder + VAE
    val diffusionModelSrc = args.getOrNull(0) ?: Models.WAN2_1_T2V_1_3B_FP16.src
    val t5XxlModelSrc = args.getOrNull(1) ?: Models.UMT5_XXL_FP16.src
    val vaeModelSrc = args.getOrNull(2) ?: Models.WAN_2_1_COMFYUI_REPACKAGED_VAE.src
    // Prompt tip: Wan 1.3B is small and has weak temporal priors. Use motion-
    // explicit verbs and avoid static framing words like "standing", "still",
    // or "portrait" in the positive prompt.
    val prompt = args.getOrNull(3) ?: "a colorful bird flapping its wings"
    val outputDir = Path.of(args.getOrNull(4) ?: ".")

    println("▸ Loading Wan 2.1 T2V model (diffusion + UMT5-XXL + VAE)...")

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
                put("params_backend", "vae=cpu")
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
                negative_prompt = "blurry, low quality, static, jittery, watermark",
                width = 480,
                height = 832,
                // Frame count must satisfy (4*k + 1), k >= 1. Common values at
                // 16 fps:
                // 17 frames ~= 1.06s (very fast, ~6 min on M3 Ultra Metal)
                // 33 frames ~= 2.06s (default in this example, ~11 min)
                // 49 frames ~= 3.06s (~17 min)
                // 65 frames ~= 4.06s (~22 min)
                // 81 frames ~= 5.06s (Wan 1.3B native training length, best
                // motion quality, ~28 min)
                // Going beyond 81 can degrade quality because it exceeds the
                // model's positional embeddings.
                video_frames = 33,
                fps = 16.0,
                steps = 30,
                cfg_scale = 6.0,
                // Wan 2.1 T2V needs flow_shift=3.0 for visible motion. Higher
                // values can make consecutive frames near-identical, which
                // looks like a frozen video.
                flow_shift = 3.0,
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
            val outputPath = outputDir.resolve("wan_t2v_$index.avi")
            Files.write(outputPath, Base64.getDecoder().decode(clip))
            println("▸ Saved $outputPath")
        }

        println("\n▸ Stats: ${result.stats}")

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
