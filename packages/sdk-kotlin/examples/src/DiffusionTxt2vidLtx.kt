// Kotlin port of packages/sdk/examples/diffusion-txt2vid-ltx.ts.
//
// Text-to-video (+ synchronized audio) with LTX-2. Unlike Wan, LTX-2 uses a
// Gemma text encoder (llmModelSrc), a video VAE (vaeModelSrc), a set of
// text-embedding connectors (embeddingsConnectorsModelSrc -- this is what
// selects the LTX-2 layout), and an optional audio VAE (audioVaeModelSrc) that
// produces a 48 kHz audio track muxed into the output AVI.
//
// This example needs powerful hardware: LTX-2.3 is a ~21B model, budget at
// least 20+ GB of video / unified memory.
//
// Pass your own paths / URLs via args to override any of the five sources.
//
// `client.media.video()` returns a `QvacMediaRun`: progress arrives on the
// `events` Flow, and the clips and stats on the `final` Deferred, as TypeScript
// splits them.
//
// RUN: ./gradlew run -Pexample=DiffusionTxt2vidLtx --args="[diffusion-src] [llm-src] [vae-src] [audio-vae-src] [connectors-src] [prompt] [output-dir]"

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
    val diffusionModelSrc = args.getOrNull(0) ?: Models.LTX_2_3_22B_Q5_K_M.src
    val llmModelSrc = args.getOrNull(1) ?: Models.GEMMA_3_12B_Q4_K_XL.src
    val vaeModelSrc = args.getOrNull(2) ?: Models.LTX_2_3_VIDEO_VAE.src
    val audioVaeModelSrc = args.getOrNull(3) ?: Models.LTX_2_3_AUDIO_VAE.src
    val embeddingsConnectorsModelSrc = args.getOrNull(4) ?: Models.LTX_2_3_22B_DISTILLED_EMBEDDINGS_CONNECTORS.src

    val prompt = args.getOrNull(5) ?: "a claymation cat playing jazz on a piano"
    val outputDir = Path.of(args.getOrNull(6) ?: ".")

    println("▸ Loading LTX-2 model (diffusion + Gemma + video VAE + audio VAE + connectors)...")

    val client = QvacClient(JvmBareRpcTransport.connectResolved(installWorkerIfMissing = true))
    try {
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

        println("\n▸ Generating video for: \"$prompt\"")

        val run = client.media.video(
            VideoStreamRequest(
                modelId = modelId,
                mode = VideoStreamRequestMode.TXT2VID,
                prompt = prompt,
                negative_prompt = "blurry, low quality, static, jittery, watermark, distorted audio",
                // LTX-2 requires width/height as multiples of 32.
                width = 512,
                height = 320,
                // LTX-2 requires (8*k + 1) frames, max 257. At 24 fps:
                // 25~=1s, 121~=5s, 241~=10s.
                video_frames = 121,
                fps = 24.0,
                // Distilled variants run in 4-8 steps with cfg ~1.0; the
                // full --dev model wants steps >= 20 and cfg ~7.0.
                steps = 10,
                cfg_scale = 1.0,
                seed = 42,
                // Tile the video VAE decode along the time axis to cap peak
                // VRAM on long / HD clips (LTX-2 only).
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
            val outputPath = outputDir.resolve("ltx_t2v_$index.avi")
            Files.write(outputPath, Base64.getDecoder().decode(clip))
            println("▸ Saved $outputPath (play in VLC to hear the muxed audio track)")
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
