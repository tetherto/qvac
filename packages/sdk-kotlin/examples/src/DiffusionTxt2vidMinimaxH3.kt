// Kotlin port of packages/sdk/examples/diffusion-txt2vid-minimax-h3.ts.
//
// Text-to-video (+ synchronized 32 kHz audio) with MiniMax-H3, which uses a
// split layout: a diffusion model, a Qwen3-VL text encoder, a video VAE and an
// audio VAE. The four files are read from a local directory you pass as args,
// so nothing is downloaded.
//
// This example needs powerful hardware. `offload_to_cpu` stays on so the run
// fits on a single GPU; tune placement through the H3_* environment variables.
//
// TypeScript's `video()` hands back separate channels and the example drains
// the progress one concurrently with `Promise.all`. The Kotlin `QvacMediaRun`
// buffers its `events` Flow, so collecting it first and then awaiting the
// `final` Deferred needs no extra concurrency.
//
// RUN: ./gradlew run -Pexample=DiffusionTxt2vidMinimaxH3 --args="<models-directory> [output.avi]"

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
    "Premium cinematic coffee commercial. A confident adult sits at a small " +
        "café table at sunrise, slowly lifts one matte black coffee cup, takes a " +
        "relaxed sip, and smiles. Warm golden rim light, drifting steam, realistic " +
        "skin, natural hands, shallow depth of field, subtle slow camera push-in, " +
        "restrained natural motion, polished live-action advertising, no dialogue, " +
        "no text overlay."

fun main(args: Array<String>): Unit = runBlocking {
    // Pass a directory containing the four MiniMax-H3 files, followed by an
    // output path.
    val modelsDir = args.getOrNull(0)
    if (modelsDir.isNullOrEmpty()) {
        System.err.println(
            "Usage: ./gradlew run -Pexample=DiffusionTxt2vidMinimaxH3 --args=\"<models-directory> [output.avi]\"",
        )
        exitProcess(1)
    }

    val outputPath = Path.of(args.getOrNull(1) ?: "minimax-h3.avi")
    val root = Path.of(modelsDir).toAbsolutePath().normalize()
    val modelSrc = root.resolve(System.getenv("H3_MODEL") ?: "minimax_h3_fl2va_pruned-Q4_K.gguf")
    val llmModelSrc = root.resolve(System.getenv("H3_LLM") ?: "qwen3vl_32b_minimax_h3-Q4_K_M.gguf")
    val vaeModelSrc = root.resolve("vae/minimax_h3_video_vae_fp16.safetensors")
    val audioVaeModelSrc = root.resolve("vae/minimax_h3_audio_vae_fp32.safetensors")
    for (file in listOf(modelSrc, llmModelSrc, vaeModelSrc, audioVaeModelSrc)) {
        if (!Files.isRegularFile(file)) {
            System.err.println("✖ missing model file: $file")
            exitProcess(1)
        }
    }

    val modelConfig = buildJsonObject {
        put("mode", "video")
        put("llmModelSrc", llmModelSrc.toString())
        put("vaeModelSrc", vaeModelSrc.toString())
        put("audioVaeModelSrc", audioVaeModelSrc.toString())
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
        val loaded = client.models.load(
            source = modelSrc.toString(),
            modelType = "sdcpp-generation",
            modelConfig = modelConfig,
        )
        val modelId = loaded.modelId ?: error(loaded.error ?: "loadModel failed")
        try {
            val run = client.media.video(
                VideoStreamRequest(
                    modelId = modelId,
                    mode = VideoStreamRequestMode.TXT2VID,
                    prompt = System.getenv("PROMPT")?.takeIf { it.isNotEmpty() } ?: DEFAULT_PROMPT,
                    negative_prompt = "extra people, duplicate cup, malformed hands, cup " +
                        "fused to hand, text, subtitles, watermark, cartoon, " +
                        "CGI, blur, flicker, jitter, camera shake",
                    width = 960,
                    height = 544,
                    // H3 uses 17*k+5 frames; 124 frames at 24 FPS is
                    // approximately 5.17 seconds.
                    video_frames = System.getenv("FRAMES")?.takeIf { it.isNotEmpty() }?.toLong() ?: 124,
                    fps = 24.0,
                    steps = 8,
                    cfg_scale = 1.0,
                    seed = 11,
                ),
            )
            run.events.collect { event ->
                if (event.step != null && event.totalSteps != null) {
                    println("Step %.0f/%.0f".format(event.step, event.totalSteps))
                }
            }
            val result = run.final.await()

            val clip = result.data.firstOrNull() ?: error("Generation finished without an AVI result")
            Files.write(outputPath, Base64.getDecoder().decode(clip))
            println("Saved $outputPath ${result.stats}")
        } finally {
            client.models.unload(modelId, clearStorage = false)
        }
    } finally {
        client.close()
    }
}
