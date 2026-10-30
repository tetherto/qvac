// Kotlin port of packages/sdk/examples/diffusion-img2vid-minimax-h3.ts.
//
// Image-to-video with MiniMax-H3, using the same diffusion + Qwen3-VL + video
// VAE layout as H3 text-to-video; no CLIP-vision encoder is needed. The audio
// VAE is omitted for silent output -- add `audioVaeModelSrc` when loading the
// model to generate synchronized 32 kHz audio. The three files are read from a
// local directory you pass as args, so nothing is downloaded.
//
// This example needs powerful hardware. `offload_to_cpu` stays on so the run
// fits on a single GPU; tune placement through the H3_* environment variables.
//
// TypeScript's `video()` takes `init_image` as raw bytes and base64-encodes
// them on the way to the worker. The typed `VideoStreamRequest` carries the
// encoded string, so the example encodes the file with `java.util.Base64`. The
// returned `QvacMediaRun` splits progress (`events` Flow) from the clips and
// stats (`final` Deferred), as TypeScript does.
//
// RUN: ./gradlew run -Pexample=DiffusionImg2vidMinimaxH3 --args="<models-directory> <init-image> [output.avi]"

import io.tether.qvac.sdk.JvmBareRpcTransport
import io.tether.qvac.sdk.QvacClient
import io.tether.qvac.sdk.generated.schema.VideoStreamRequest
import io.tether.qvac.sdk.generated.schema.VideoStreamRequestMode
import io.tether.qvac.sdk.media
import io.tether.qvac.sdk.models
import java.nio.file.Files
import java.nio.file.Path
import java.util.Base64
import kotlin.system.exitProcess
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

private const val DEFAULT_PROMPT =
    "The boat glides forward through the mist while the camera slowly pulls " +
        "back, cinematic natural motion."

fun main(args: Array<String>): Unit = runBlocking {
    val modelsDir = args.getOrNull(0)
    val initImagePath = args.getOrNull(1)?.let { Path.of(it) }
    if (modelsDir.isNullOrEmpty() || initImagePath == null) {
        System.err.println("✖ models directory and init image path are required")
        System.err.println(
            "Usage: ./gradlew run -Pexample=DiffusionImg2vidMinimaxH3 " +
                "--args=\"<modelsDirectory> <initImagePath> [output.avi]\"",
        )
        exitProcess(1)
    }

    val outputPath = Path.of(args.getOrNull(2) ?: "minimax-h3-img2vid.avi")
    val root = Path.of(modelsDir).toAbsolutePath().normalize()
    val modelSrc = root.resolve(System.getenv("H3_MODEL") ?: "minimax_h3_fl2va_pruned-Q4_K.gguf")
    val llmModelSrc = root.resolve(System.getenv("H3_LLM") ?: "qwen3vl_32b_minimax_h3-Q4_K_M.gguf")
    val vaeModelSrc = root.resolve("vae/minimax_h3_video_vae_fp16.safetensors")
    for (file in listOf(modelSrc, llmModelSrc, vaeModelSrc, initImagePath)) {
        if (!Files.isRegularFile(file)) {
            System.err.println("✖ missing model file: $file")
            exitProcess(1)
        }
    }

    val modelConfig = buildJsonObject {
        put("mode", "video")
        put("llmModelSrc", llmModelSrc.toString())
        put("vaeModelSrc", vaeModelSrc.toString())
        put("device", "gpu")
        put("diffusion_fa", true)
        put("offload_to_cpu", System.getenv("H3_OFFLOAD_TO_CPU") != "0")
        put("stream_layers", System.getenv("H3_STREAM_LAYERS") == "1")
        for ((key, variable) in listOf(
            "backend" to "H3_BACKEND",
            "params_backend" to "H3_PARAMS_BACKEND",
            "max_vram" to "H3_MAX_VRAM",
        )) {
            System.getenv(variable)?.takeIf { it.isNotEmpty() }?.let { put(key, it) }
        }
    }

    val client = QvacClient(JvmBareRpcTransport.connectResolved(installWorkerIfMissing = true))
    try {
        println("▸ Loading MiniMax-H3 model (diffusion + Qwen3-VL + video VAE)...")
        val loaded = client.models.load(
            source = modelSrc.toString(),
            modelType = "sdcpp-generation",
            modelConfig = modelConfig,
        )
        val modelId = loaded.modelId ?: error(loaded.error ?: "loadModel failed")
        try {
            println("▸ Model loaded: $modelId")

            val initImage = Base64.getEncoder().encodeToString(Files.readAllBytes(initImagePath))
            val prompt = System.getenv("PROMPT")?.takeIf { it.isNotEmpty() } ?: DEFAULT_PROMPT
            println("▸ Generating video for: \"$prompt\"")

            val run = client.media.video(
                VideoStreamRequest(
                    modelId = modelId,
                    mode = VideoStreamRequestMode.IMG2VID,
                    prompt = prompt,
                    init_image = initImage,
                    width = 864,
                    height = 480,
                    // H3 uses 17*k+5 frames and requires 24 FPS.
                    video_frames = System.getenv("FRAMES")?.takeIf { it.isNotEmpty() }?.toLong() ?: 124,
                    fps = 24.0,
                    steps = 8,
                    cfg_scale = 1.0,
                    seed = 11,
                ),
            )
            run.events.collect { event ->
                if (event.step != null && event.totalSteps != null) {
                    println("▸ step %.0f/%.0f".format(event.step, event.totalSteps))
                }
            }
            val result = run.final.await()

            val clip = result.data.firstOrNull() ?: error("Generation finished without an AVI result")
            Files.write(outputPath, Base64.getDecoder().decode(clip))
            println("▸ Saved $outputPath ${result.stats}")
        } finally {
            client.models.unload(modelId, clearStorage = false)
        }
    } finally {
        client.close()
    }
}
