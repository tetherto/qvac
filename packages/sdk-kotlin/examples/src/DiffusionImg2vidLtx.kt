// Kotlin port of packages/sdk/examples/diffusion-img2vid-ltx.ts.
//
// Image-to-video (+ synchronized audio) with LTX-2. Unlike Wan I2V, LTX-2
// conditions on the first frame through its video VAE, so it needs NO CLIP
// vision weights (clipVisionModelSrc) -- the same LTX-2 layout used for
// txt2vid works for img2vid, you just add an init_image at generation time.
//
// This example needs powerful hardware: LTX-2.3 is a ~21B model, budget at
// least 20+ GB of video / unified memory.
//
// Pass your own paths / URLs via args to override any of the five sources.
//
// TypeScript's `video()` takes `init_image` as raw bytes and base64-encodes
// them on the way to the worker. The typed `VideoStreamRequest` carries the
// encoded string, so the example encodes the file with `java.util.Base64`. The
// returned `QvacMediaRun` splits progress (`events` Flow) from the clips and
// stats (`final` Deferred), as TypeScript does.
//
// RUN: ./gradlew run -Pexample=DiffusionImg2vidLtx --args="<init-image> [prompt] [output-dir] [diffusion-src] [llm-src] [vae-src] [audio-vae-src] [connectors-src]"

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
    val diffusionModelSrc = args.getOrNull(3) ?: Models.LTX_2_3_22B_Q5_K_M.src
    val llmModelSrc = args.getOrNull(4) ?: Models.GEMMA_3_12B_Q4_K_XL.src
    val vaeModelSrc = args.getOrNull(5) ?: Models.LTX_2_3_VIDEO_VAE.src
    val audioVaeModelSrc = args.getOrNull(6) ?: Models.LTX_2_3_AUDIO_VAE.src
    val embeddingsConnectorsModelSrc = args.getOrNull(7) ?: Models.LTX_2_3_22B_DISTILLED_EMBEDDINGS_CONNECTORS.src

    if (initImagePath.isNullOrEmpty()) {
        System.err.println("✖ init image path is required")
        System.err.println(
            "Usage: ./gradlew run -Pexample=DiffusionImg2vidLtx --args=\"<initImagePath> " +
                "[prompt] [outputDir] [diffusionModelSrc] [llmModelSrc] " +
                "[vaeModelSrc] [audioVaeModelSrc] [embeddingsConnectorsModelSrc]\"",
        )
        exitProcess(1)
    }

    println("▸ Loading LTX-2 model (diffusion + Gemma + video VAE + audio VAE + connectors)...")

    val client = QvacClient(JvmBareRpcTransport.connectResolved(installWorkerIfMissing = true))
    try {
        // No clipVisionModelSrc -- LTX-2 img2vid does not use CLIP vision.
        val modelId = client.loadWithProgress(
            source = diffusionModelSrc,
            modelType = "sdcpp-generation",
            modelConfig = buildJsonObject {
                put("mode", "video")
                put("device", "gpu")
                put("threads", 4)
                // Supplying embeddingsConnectorsModelSrc selects the LTX-2
                // layout.
                put("llmModelSrc", llmModelSrc)
                put("vaeModelSrc", vaeModelSrc)
                put("audioVaeModelSrc", audioVaeModelSrc)
                put("embeddingsConnectorsModelSrc", embeddingsConnectorsModelSrc)
                put("diffusion_fa", true)
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
                negative_prompt = "blurry, distorted, low quality, jittery, static, frozen, distorted audio",
                strength = 0.85,
                // LTX-2 requires width/height as multiples of 32 and
                // (8*k + 1) frames (max 257).
                width = 512,
                height = 320,
                video_frames = 121,
                fps = 24.0,
                steps = 10,
                cfg_scale = 1.0,
                seed = 42,
                temporal_tiling = true,
            ),
        )
        run.events.collect { event ->
            if (event.step != null && event.totalSteps != null) {
                println("▸ step %.0f/%.0f".format(event.step, event.totalSteps))
            }
        }
        val result = run.final.await()

        result.data.forEachIndexed { index, clip ->
            val outputPath = outputDir.resolve("ltx_i2v_$index.avi")
            Files.write(outputPath, Base64.getDecoder().decode(clip))
            println("▸ Saved $outputPath (play in VLC to hear the muxed audio track)")
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
