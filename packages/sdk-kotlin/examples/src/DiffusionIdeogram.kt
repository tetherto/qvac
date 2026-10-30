// Kotlin port of packages/sdk/examples/diffusion-ideogram.ts.
//
// Ideogram 4 in split layout: a diffusion model, an unconditional diffusion
// model, a Qwen3-VL LLM text encoder and a VAE, all handed to one load call
// through `modelConfig`. Its `prompt` is not prose but a serialized structured
// caption, with a bounding box per element in the target canvas coordinate
// space.
//
// The caption is built with `buildJsonObject`, which keeps insertion order, and
// `JsonObject.toString()` emits compact JSON byte-identical to what
// `JSON.stringify` sends in TypeScript -- the model is sensitive to this
// format. The returned `QvacMediaRun` splits progress (`events` Flow) from the
// images and stats (`final` Deferred), as TypeScript does.
//
// RUN: ./gradlew run -Pexample=DiffusionIdeogram --args="[model] [uncond] [llm] [vae] [output-dir]"

import io.tether.qvac.sdk.JvmBareRpcTransport
import io.tether.qvac.sdk.QvacClient
import io.tether.qvac.sdk.QvacProgressEvent
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
import kotlinx.serialization.json.add
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject

private const val DIFFUSION_MODEL_SRC =
    "https://huggingface.co/leejet/ideogram-4-GGUF/resolve/main/ideogram4-Q4_0.gguf"
private const val UNCOND_MODEL_SRC =
    "https://huggingface.co/leejet/ideogram-4-GGUF/resolve/main/ideogram4_uncond-Q4_0.gguf"
private const val LLM_MODEL_SRC =
    "https://huggingface.co/unsloth/Qwen3-VL-8B-Instruct-GGUF/resolve/main/Qwen3-VL-8B-Instruct-Q4_K_M.gguf"
private const val VAE_MODEL_SRC =
    "https://huggingface.co/Comfy-Org/flux2-dev/resolve/main/split_files/vae/flux2-vae.safetensors"

// Ideogram 4 expects a JSON-serialized structured caption with explicit
// bounding boxes. Plain-text prompts produce degenerate or placeholder output.
private val STRUCTURED_PROMPT = buildJsonObject {
    put(
        "high_level_description",
        "A bright product photo of one yellow coffee mug on a clean office desk " +
            "with a tiny readable label that says IDEO.",
    )
    putJsonObject("style_description") {
        put("aesthetics", "simple product photography, clean bright office desk, minimal composition")
        put("lighting", "soft studio light with gentle shadows")
        put("photo", "sharp focus, crisp readable label text")
        put("medium", "product photo")
        putJsonArray("color_palette") {
            add("#FFD54A")
            add("#FFFFFF")
            add("#111111")
            add("#7EC8E3")
        }
    }
    putJsonObject("compositional_deconstruction") {
        put("canvas", "Square canvas, upright orientation. All text is horizontal and readable.")
        put("background", "Clean white office desk with a soft blue background gradient.")
        putJsonArray("elements") {
            addJsonObject {
                put("type", "obj")
                putJsonArray("bbox") { listOf(230, 260, 800, 740).forEach { add(it) } }
                put("desc", "Exactly one matte yellow ceramic coffee mug centered on the desk.")
            }
            addJsonObject {
                put("type", "text")
                putJsonArray("bbox") { listOf(510, 360, 620, 640).forEach { add(it) } }
                put("text", "IDEO")
                put("desc", "Small black label printed horizontally on the mug.")
            }
        }
    }
}

fun main(args: Array<String>): Unit = runBlocking {
    if ("--help" in args) {
        println("Usage: ./gradlew run -Pexample=DiffusionIdeogram --args=\"[model] [uncond] [llm] [vae] [output-dir]\"")
        println("▸ Defaults use the four Hugging Face model URLs supported by the diffusion addon.")
        return@runBlocking
    }

    val diffusionModelSrc = args.getOrNull(0) ?: DIFFUSION_MODEL_SRC
    val uncondModelSrc = args.getOrNull(1) ?: UNCOND_MODEL_SRC
    val llmModelSrc = args.getOrNull(2) ?: LLM_MODEL_SRC
    val vaeModelSrc = args.getOrNull(3) ?: VAE_MODEL_SRC
    val outputDir = Path.of(args.getOrNull(4) ?: ".")

    val client = QvacClient(JvmBareRpcTransport.connectResolved(installWorkerIfMissing = true))
    try {
        println("▸ Loading Ideogram 4 split-layout model...")
        val modelId = client.loadWithProgress(
            source = diffusionModelSrc,
            modelType = "sdcpp-generation",
            modelConfig = buildJsonObject {
                put("device", "gpu")
                put("threads", 4)
                put("diffusion_fa", true)
                put("offload_to_cpu", true)
                put("llmModelSrc", llmModelSrc)
                put("vaeModelSrc", vaeModelSrc)
                put("uncondModelSrc", uncondModelSrc)
            },
        )
        println("▸ Model loaded: $modelId")

        try {
            val run = client.media.diffusion(
                DiffusionStreamRequest(
                    modelId = modelId,
                    // Compact JSON, like JSON.stringify; the model is sensitive
                    // to the caption's exact format.
                    prompt = STRUCTURED_PROMPT.toString(),
                    width = 768,
                    height = 768,
                    steps = 16,
                    cfg_scale = 7.0,
                    seed = 42,
                ),
            )
            run.events.collect { event ->
                if (event.step != null && event.totalSteps != null) {
                    println("▸ step %.0f/%.0f".format(event.step, event.totalSteps))
                }
            }
            val result = run.final.await()

            result.data.forEachIndexed { index, image ->
                val outputPath = outputDir.resolve("ideogram_$index.png")
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
