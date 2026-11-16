// Kotlin port of packages/sdk/examples/diffusion-moss-image.ts.
//
// MOSS-Image in split layout: a diffusion model, a Qwen3.5 LLM text encoder,
// a VAE and the encoder's external `tokenizer.json`, all handed to one load
// call through `modelConfig`. Its `prompt` is a serialized JSON layout that
// places text and objects with boxes in centred pixel coordinates.
//
// The layout is built with `buildJsonObject`, and `JsonObject.toString()` emits
// compact JSON that leaves non-ASCII text as is, the same as `JSON.stringify`
// in TypeScript -- escaped text would reach the model as `\uXXXX` rather than
// the characters to render. The sampler and scheduler are typed enums on the
// generated `DiffusionStreamRequest`. The returned `QvacMediaRun` splits
// progress (`events` Flow) from the images and stats (`final` Deferred), as
// TypeScript does.
//
// RUN: ./gradlew -p examples run -Pexample=DiffusionMossImage --args="[output-dir] [model] [llm] [vae] [tokenizer]"

import io.tether.qvac.sdk.QvacClient
import io.tether.qvac.sdk.QvacProgressEvent
import io.tether.qvac.sdk.generated.schema.DiffusionStreamRequest
import io.tether.qvac.sdk.generated.schema.DiffusionStreamRequestSamplingMethod
import io.tether.qvac.sdk.generated.schema.DiffusionStreamRequestScheduler
import io.tether.qvac.sdk.generated.schema.LoadModelResponse
import io.tether.qvac.sdk.generated.schema.ModelProgressResponse
import io.tether.qvac.sdk.jvm.JvmBareKitTransport
import io.tether.qvac.sdk.media
import io.tether.qvac.sdk.models
import java.nio.file.Files
import java.nio.file.Path
import java.util.Base64
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject

private const val HF = "https://huggingface.co"
private const val MOSS_REPO = "$HF/Comfy-Org/MOSS-Image/resolve/530a4c94f92c35ef6818b1b035a983fe9dcf5f54"
private const val DIFFUSION_MODEL_SRC = "$MOSS_REPO/diffusion_models/moss_image_sft_bf16.safetensors"
private const val LLM_MODEL_SRC =
    "$HF/unsloth/Qwen3.5-9B-GGUF/resolve/3885219b6810b007914f3a7950a8d1b469d598a5/Qwen3.5-9B-Q4_K_M.gguf"
private const val VAE_MODEL_SRC = "$MOSS_REPO/vae/flux2-vae_small.safetensors"
private const val TOKENIZER_SRC =
    "$HF/OpenMOSS-Team/MOSS-Image-SFT/resolve/f972bd4b4b9e3852133cc5da954d87bc32cd8fb9/tokenizer/tokenizer.json"

private const val WIDTH = 1024
private const val HEIGHT = 1024

// Boxes are [y_min, x_min, y_max, x_max] in absolute pixels with the canvas
// centre as the origin, so a 1024x1024 canvas spans -512..512 on both axes.
// Keep them consistent with WIDTH and HEIGHT.
private val LAYOUT = buildJsonObject {
    putJsonObject("summary") {
        putJsonArray("meta") { add("poster") }
        put("canvas", "single")
        put("caption", "A minimalist travel poster of a snowy mountain at sunrise, flat illustration style.")
    }
    putJsonArray("items") {
        addJsonObject {
            put("label", "text")
            put("caption", "Bold white sans-serif title across the top of the poster.")
            put("text", "SUMMIT")
            putJsonArray("bbox") { listOf(-448, -352, -320, 352).forEach { add(it) } }
        }
        addJsonObject {
            put("label", "object")
            put("caption", "A snowy mountain peak lit by an orange sunrise.")
            putJsonArray("bbox") { listOf(-224, -320, 384, 320).forEach { add(it) } }
        }
    }
    put("bbox_coord_space", "abs_centralized")
    put("bbox_format", "yxyx")
}

fun main(args: Array<String>): Unit = runBlocking {
    if ("--help" in args) {
        println(
            "Usage: ./gradlew -p examples run -Pexample=DiffusionMossImage " +
                "--args=\"[output-dir] [model] [llm] [vae] [tokenizer]\"",
        )
        println("▸ Defaults download pinned Hugging Face weights. Model overrides accept paths or URLs.")
        return@runBlocking
    }

    val outputDir = Path.of(args.getOrNull(0) ?: ".")
    val diffusionModelSrc = args.getOrNull(1) ?: DIFFUSION_MODEL_SRC
    val llmModelSrc = args.getOrNull(2) ?: LLM_MODEL_SRC
    val vaeModelSrc = args.getOrNull(3) ?: VAE_MODEL_SRC
    val tokenizerSrc = args.getOrNull(4) ?: TOKENIZER_SRC

    val client = QvacClient(JvmBareKitTransport.connect())
    try {
        println("▸ Loading MOSS-Image...")
        val modelId = client.loadWithProgress(
            source = modelSource(diffusionModelSrc),
            modelType = "sdcpp-generation",
            modelConfig = buildJsonObject {
                put("llmModelSrc", modelSource(llmModelSrc))
                put("vaeModelSrc", modelSource(vaeModelSrc))
                put("tokenizerSrc", modelSource(tokenizerSrc))
                put("flash_attn", true)
            },
        )
        println("▸ Model loaded: $modelId")

        try {
            val run = client.media.diffusion(
                DiffusionStreamRequest(
                    modelId = modelId,
                    prompt = LAYOUT.toString(),
                    width = WIDTH.toLong(),
                    height = HEIGHT.toLong(),
                    steps = 50,
                    cfg_scale = 3.0,
                    sampling_method = DiffusionStreamRequestSamplingMethod.EULER,
                    scheduler = DiffusionStreamRequestScheduler.DISCRETE,
                    seed = 42,
                ),
            )
            run.events.collect { event ->
                if (event.step != null && event.totalSteps != null) {
                    println("▸ step %.0f/%.0f".format(event.step, event.totalSteps))
                }
            }
            val result = run.final.await()

            check(result.data.isNotEmpty()) { "MOSS-Image returned no image." }
            result.data.forEachIndexed { index, image ->
                val outputPath = outputDir.resolve("moss_image_$index.png")
                Files.write(outputPath, Base64.getDecoder().decode(image))
                println("▸ Saved $outputPath")
            }

            println("▸ Stats: ${result.stats}")
        } catch (error: Exception) {
            // Preserve the original error.
            runCatching { client.models.unload(modelId) }
            throw error
        }

        client.models.unload(modelId)
        println("▸ Done")
    } finally {
        client.close()
    }
}

/** Pass URLs through; resolve local paths to absolute ones. */
private fun modelSource(source: String): String =
    if (source.startsWith("http://") || source.startsWith("https://")) {
        source
    } else {
        Path.of(source).toAbsolutePath().toString()
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

// Progress fires many times per percent on a multi-GB download, so it prints
// once per whole percent of each file.
private val lastPercent = mutableMapOf<String, Int>()

private fun printProgress(p: ModelProgressResponse) {
    val percent = p.percentage.toInt()
    if (lastPercent[p.downloadKey] == percent) return
    lastPercent[p.downloadKey] = percent
    val line = "▸ Downloading %.0f%% (%.1f/%.1f MB)".format(p.percentage, p.downloaded / 1e6, p.total / 1e6)
    if (System.console() != null) System.err.print("\r$line") else System.err.println(line)
    if (p.percentage >= 100) System.err.println()
}
