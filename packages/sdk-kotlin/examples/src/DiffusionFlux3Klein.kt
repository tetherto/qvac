// Kotlin port of packages/sdk/examples/diffusion-flux3-klein.ts.
//
// FLUX.3 Image Klein in split layout: a diffusion model, a Qwen3-VL 4B LLM text
// encoder and the FLUX.2 VAE, all handed to one load call through
// `modelConfig`. Without reference images it generates from text; up to 10
// reference images passed after the model arguments go in order through
// `init_images` for editing.
//
// TypeScript's `diffusion()` takes each reference as raw bytes and base64-encodes
// them on the way to the worker. The typed `DiffusionStreamRequest` carries the
// encoded strings, so the example encodes the files with `java.util.Base64`, and
// leaves `init_images` null when there are none. `sampling_method` is a
// generated enum (`DiffusionStreamRequestSamplingMethod`). The returned
// `QvacMediaRun` splits progress (`events` Flow) from the images and stats
// (`final` Deferred), as TypeScript does.
//
// The defaults download pinned Hugging Face weights. Model overrides accept local
// paths or URLs; an empty argument keeps the default.
// FLUX.3 model terms: https://huggingface.co/black-forest-labs/flux-3-image-klein/blob/09561231f44e41381c461caf53d5452005a60ac9/LICENSE.md
//
// RUN: ./gradlew -p examples run -Pexample=DiffusionFlux3Klein --args="[prompt] [output-dir] [model] [llm] [vae] [...references]"

import io.tether.qvac.sdk.QvacClient
import io.tether.qvac.sdk.QvacProgressEvent
import io.tether.qvac.sdk.generated.schema.DiffusionStreamRequest
import io.tether.qvac.sdk.generated.schema.DiffusionStreamRequestSamplingMethod
import io.tether.qvac.sdk.generated.schema.LoadModelResponse
import io.tether.qvac.sdk.generated.schema.ModelProgressResponse
import io.tether.qvac.sdk.jvm.JvmBareKitTransport
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

private const val HF = "https://huggingface.co"
private const val DIFFUSION_MODEL_SRC =
    "$HF/leejet/flux-3-image-klein-GGUF/resolve/" +
        "1c2ad2f9b9247ccca6506a23bdb033fdb0873321/flux3-image-klein-Q8_0.gguf"
private const val LLM_MODEL_SRC =
    "$HF/Qwen/Qwen3-VL-4B-Instruct-GGUF/resolve/" +
        "1cd86afb9a95c410a6038ab3b40d8b578c892266/Qwen3VL-4B-Instruct-Q4_K_M.gguf"
private const val VAE_MODEL_SRC =
    "$HF/Comfy-Org/Flux-2-Klein-4B/resolve/" +
        "5b3abca5c0dc1ecd4eaf3340868d09063fc1c965/split_files/vae/flux2-vae.safetensors"
private const val DEFAULT_PROMPT = "A lovely cat holding a sign that says 'FLUX3'"
private const val USAGE =
    "Usage: ./gradlew -p examples run -Pexample=DiffusionFlux3Klein --args=\"[prompt] [outputDir] " +
        "[model] [llm] [vae] [...references]\""

/** Pass URLs through; resolve local paths to absolute ones. */
private fun modelSource(source: String): String =
    if (source.startsWith("http://") || source.startsWith("https://")) {
        source
    } else {
        Path.of(source).toAbsolutePath().normalize().toString()
    }

fun main(args: Array<String>): Unit = runBlocking {
    if ("--help" in args) {
        println(USAGE)
        println("▸ Defaults download pinned Hugging Face weights. Model overrides accept paths or URLs.")
        println("▸ Pass up to 10 reference image paths to edit them instead of generating from text.")
        return@runBlocking
    }

    val prompt = args.getOrNull(0)?.takeIf { it.isNotEmpty() } ?: DEFAULT_PROMPT
    val outputDir = Path.of(args.getOrNull(1)?.takeIf { it.isNotEmpty() } ?: ".")
    val diffusionModelSrc = args.getOrNull(2)?.takeIf { it.isNotEmpty() } ?: DIFFUSION_MODEL_SRC
    val llmModelSrc = args.getOrNull(3)?.takeIf { it.isNotEmpty() } ?: LLM_MODEL_SRC
    val vaeModelSrc = args.getOrNull(4)?.takeIf { it.isNotEmpty() } ?: VAE_MODEL_SRC
    val referencePaths = args.drop(5)

    if (referencePaths.size > 10) {
        System.err.println("✖ FLUX.3 accepts at most 10 reference images")
        System.err.println(USAGE)
        exitProcess(1)
    }

    val client = QvacClient(JvmBareKitTransport.connect())
    try {
        val initImages = referencePaths.map { path ->
            Base64.getEncoder().encodeToString(Files.readAllBytes(Path.of(path)))
        }

        println("▸ Loading FLUX.3 Image Klein split-layout model...")
        val modelId = client.loadWithProgress(
            source = modelSource(diffusionModelSrc),
            modelType = "sdcpp-generation",
            modelConfig = buildJsonObject {
                put("llmModelSrc", modelSource(llmModelSrc))
                put("vaeModelSrc", modelSource(vaeModelSrc))
                put("flash_attn", true)
            },
        )
        println("▸ Model loaded: $modelId")

        try {
            println("▸ Generating: \"$prompt\"")

            // Recommended settings for the distilled model: 16 Euler steps at CFG 1.
            val run = client.media.diffusion(
                DiffusionStreamRequest(
                    modelId = modelId,
                    prompt = prompt,
                    init_images = initImages.ifEmpty { null },
                    width = 512,
                    height = 512,
                    steps = 16,
                    cfg_scale = 1.0,
                    sampling_method = DiffusionStreamRequestSamplingMethod.EULER,
                    seed = 42,
                ),
            )
            run.events.collect { event ->
                if (event.step != null && event.totalSteps != null) {
                    println("▸ step %.0f/%.0f".format(event.step, event.totalSteps))
                }
            }
            val result = run.final.await()

            check(result.data.isNotEmpty()) { "FLUX.3 returned no image." }
            result.data.forEachIndexed { index, image ->
                val outputPath = outputDir.resolve("flux3_$index.png")
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
