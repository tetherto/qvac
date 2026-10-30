// Kotlin port of packages/sdk/examples/diffusion-ic-lora-ltx.ts.
//
// Reference-conditioned text-to-video with LTX-2 and an Ingredients (IC) LoRA.
// The LoRA is applied at runtime (`lora_apply_mode: "at_runtime"`), and a
// composite reference sheet is handed to generation in `reference_images` so
// the clip inherits the character / style it shows. Reference conditioning
// needs at least 121 frames, hence `video_frames = 217`.
//
// This example needs powerful hardware: LTX-2.3 is a ~21B model, budget at
// least 20+ GB of video / unified memory.
//
// TypeScript's `video()` takes `reference_images` as raw bytes and
// base64-encodes them on the way to the worker. The typed `VideoStreamRequest`
// carries the encoded strings, so the example encodes the file with
// `java.util.Base64`. `scheduler` is a generated enum and `vae_tile_size` a
// generated number-or-string union (`Variant1` holds the number). The returned
// `QvacMediaRun` splits progress (`events` Flow) from the clips and stats
// (`final` Deferred), as TypeScript does.
//
// RUN: ./gradlew run -Pexample=DiffusionIcLoraLtx --args="<absolute-lora-path> <reference-sheet-path> [prompt] [output-dir]"

import io.tether.qvac.sdk.JvmBareRpcTransport
import io.tether.qvac.sdk.QvacClient
import io.tether.qvac.sdk.QvacProgressEvent
import io.tether.qvac.sdk.generated.Models
import io.tether.qvac.sdk.generated.schema.LoadModelResponse
import io.tether.qvac.sdk.generated.schema.ModelProgressResponse
import io.tether.qvac.sdk.generated.schema.VideoStreamRequest
import io.tether.qvac.sdk.generated.schema.VideoStreamRequestMode
import io.tether.qvac.sdk.generated.schema.VideoStreamRequestScheduler
import io.tether.qvac.sdk.generated.schema.VideoStreamRequestVae_tile_size
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
    val loraPath = args.getOrNull(0)
    val referencePath = args.getOrNull(1)
    val prompt = args.getOrNull(2)
        ?: ("Reference sheet: a red-haired explorer in a blue parka. Generated " +
            "video: the explorer crosses a snowy ridge at sunrise.")
    val outputDir = Path.of(args.getOrNull(3) ?: ".")

    if (loraPath.isNullOrEmpty() || referencePath.isNullOrEmpty()) {
        System.err.println(
            "Usage: ./gradlew run -Pexample=DiffusionIcLoraLtx " +
                "--args=\"<absolute-lora-path> <reference-sheet-path> [prompt] [output-dir]\"",
        )
        exitProcess(1)
    }
    if (!Path.of(loraPath).isAbsolute) {
        System.err.println("✖ The LoRA adapter path must be absolute on the inference worker.")
        exitProcess(1)
    }

    val referenceSheet = Base64.getEncoder().encodeToString(Files.readAllBytes(Path.of(referencePath)))

    val client = QvacClient(JvmBareRpcTransport.connectResolved(installWorkerIfMissing = true))
    try {
        val modelId = client.loadWithProgress(
            source = Models.LTX_2_3_22B_Q5_K_M.src,
            modelType = "sdcpp-generation",
            modelConfig = buildJsonObject {
                put("mode", "video")
                put("device", "gpu")
                put("threads", 4)
                put("llmModelSrc", Models.GEMMA_3_12B_Q4_K_XL.src)
                put("vaeModelSrc", Models.LTX_2_3_VIDEO_VAE.src)
                put("audioVaeModelSrc", Models.LTX_2_3_AUDIO_VAE.src)
                put("embeddingsConnectorsModelSrc", Models.LTX_2_3_22B_DISTILLED_EMBEDDINGS_CONNECTORS.src)
                put("diffusion_fa", true)
                put("offload_to_cpu", true)
                put("vae_tiling", true)
                // Keep the LoRA out of the loaded weights so it can be swapped
                // per request.
                put("lora_apply_mode", "at_runtime")
            },
        )

        val run = client.media.video(
            VideoStreamRequest(
                modelId = modelId,
                mode = VideoStreamRequestMode.TXT2VID,
                prompt = prompt,
                negative_prompt = "blurry, low quality, static, jittery, watermark",
                width = 768,
                height = 448,
                // Reference conditioning requires at least 121 frames.
                video_frames = 217,
                fps = 24.0,
                steps = 8,
                scheduler = VideoStreamRequestScheduler.LTX2,
                cfg_scale = 1.0,
                seed = 84,
                lora = loraPath,
                lora_strength = 1.37,
                stg_scale = 1.0,
                stg_block = 29,
                reference_images = listOf(referenceSheet),
                reference_attention_strength = 1.0,
                reference_downscale_factor = 1.0,
                temporal_tiling = true,
                vae_tile_size = VideoStreamRequestVae_tile_size.Variant1(4.0),
            ),
        )
        run.events.collect { event ->
            if (event.step != null && event.totalSteps != null) {
                println("▸ step %.0f/%.0f".format(event.step, event.totalSteps))
            }
        }
        val result = run.final.await()

        Files.createDirectories(outputDir)
        result.data.forEachIndexed { index, clip ->
            val outputPath = outputDir.resolve("ltx_ic_lora_$index.avi")
            Files.write(outputPath, Base64.getDecoder().decode(clip))
            println("▸ Saved $outputPath")
        }

        println("▸ Stats: ${result.stats}")

        client.models.unload(modelId, clearStorage = false)
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
