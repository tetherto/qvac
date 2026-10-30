// Kotlin port of packages/sdk/examples/diffusion-qwen-image-21.ts.
//
// Qwen-Image-2.1 in split layout: a diffusion model, a Qwen3-VL LLM text
// encoder, its vision projector and the 2.1 VAE, all handed to one load call
// through `modelConfig`. Two reference images go in order through
// `init_images`, and the prompt asks for an RGBA image with a transparent
// background.
//
// TypeScript's `diffusion()` takes each reference as raw bytes and base64-encodes
// them on the way to the worker. The typed `DiffusionStreamRequest` carries the
// encoded strings, so the example encodes the files with `java.util.Base64`.
// `sampling_method` is a generated enum (`DiffusionStreamRequestSamplingMethod`),
// so a misspelled sampler fails at compile time instead of at the worker. The
// returned `QvacMediaRun` splits progress (`events` Flow) from the images and
// stats (`final` Deferred), as TypeScript does.
//
// The defaults download pinned Hugging Face weights. Model overrides accept local
// paths or URLs.
// Model terms: https://huggingface.co/Qwen/Qwen-Image-2.1/blob/d26bb61231c349cf6b7896fa83353113880e1ba3/LICENSE
//
// RUN: ./gradlew run -Pexample=DiffusionQwenImage21 --args="<reference-a> <reference-b> [prompt] [output-dir] [model] [llm] [vae] [projector]"

import io.tether.qvac.sdk.JvmBareRpcTransport
import io.tether.qvac.sdk.QvacClient
import io.tether.qvac.sdk.QvacProgressEvent
import io.tether.qvac.sdk.generated.schema.DiffusionStreamRequest
import io.tether.qvac.sdk.generated.schema.DiffusionStreamRequestSamplingMethod
import io.tether.qvac.sdk.generated.schema.LoadModelResponse
import io.tether.qvac.sdk.generated.schema.ModelProgressResponse
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
private const val ENCODER_REPO = "$HF/Qwen/Qwen3-VL-8B-Instruct-GGUF/resolve/f982a07559d4a2f6c8744d840bf6fccab30eea96"
private const val DIFFUSION_MODEL_SRC =
    "$HF/leejet/Qwen-Image-2.1-GGUF/resolve/cc11433936a06e9765f7c0c0b1f0436cfd2b9856/qwen_image_2.1-Q4_K.gguf"
private const val LLM_MODEL_SRC = "$ENCODER_REPO/Qwen3VL-8B-Instruct-Q4_K_M.gguf"
private const val VAE_MODEL_SRC =
    "$HF/Comfy-Org/Qwen-Image-2.1/resolve/" +
        "a8342359c61979b06a8dafb1a47991fe1f30e994/vae/qwen_image_2.1_vae_bf16.safetensors"
private const val PROJECTION_MODEL_SRC = "$ENCODER_REPO/mmproj-Qwen3VL-8B-Instruct-F16.gguf"
private const val DEFAULT_PROMPT =
    "Place the subjects from both reference images side by side. " +
        "Generate an RGBA image with a transparent background and no scenery."
private const val USAGE =
    "Usage: ./gradlew run -Pexample=DiffusionQwenImage21 --args=\"<referenceA> <referenceB> " +
        "[prompt] [outputDir] [model] [llm] [vae] [projector]\""

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
        println("▸ The default prompt combines both subjects on a transparent background.")
        return@runBlocking
    }

    val referencePathA = args.getOrNull(0)
    val referencePathB = args.getOrNull(1)
    val prompt = args.getOrNull(2)?.takeIf { it.isNotEmpty() } ?: DEFAULT_PROMPT
    val outputDir = Path.of(args.getOrNull(3) ?: ".")
    val diffusionModelSrc = args.getOrNull(4) ?: DIFFUSION_MODEL_SRC
    val llmModelSrc = args.getOrNull(5) ?: LLM_MODEL_SRC
    val vaeModelSrc = args.getOrNull(6) ?: VAE_MODEL_SRC
    val projectionModelSrc = args.getOrNull(7) ?: PROJECTION_MODEL_SRC

    if (referencePathA.isNullOrEmpty() || referencePathB.isNullOrEmpty()) {
        System.err.println("✖ two reference image paths are required")
        System.err.println(USAGE)
        exitProcess(1)
    }

    val client = QvacClient(JvmBareRpcTransport.connectResolved(installWorkerIfMissing = true))
    try {
        val initImages = listOf(referencePathA, referencePathB).map { path ->
            Base64.getEncoder().encodeToString(Files.readAllBytes(Path.of(path)))
        }

        println("▸ Loading Qwen-Image-2.1 split-layout model...")
        val modelId = client.loadWithProgress(
            source = modelSource(diffusionModelSrc),
            modelType = "sdcpp-generation",
            modelConfig = buildJsonObject {
                put("llmModelSrc", modelSource(llmModelSrc))
                put("vaeModelSrc", modelSource(vaeModelSrc))
                put("projectionModelSrc", modelSource(projectionModelSrc))
                put("flash_attn", true)
            },
        )
        println("▸ Model loaded: $modelId")

        try {
            println("▸ Generating from \"$referencePathA\" and \"$referencePathB\": \"$prompt\"")

            val run = client.media.diffusion(
                DiffusionStreamRequest(
                    modelId = modelId,
                    prompt = prompt,
                    init_images = initImages,
                    width = 512,
                    height = 512,
                    steps = 30,
                    cfg_scale = 6.0,
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

            check(result.data.isNotEmpty()) { "Qwen-Image-2.1 returned no image." }
            result.data.forEachIndexed { index, image ->
                val outputPath = outputDir.resolve("qwen_image_21_$index.png")
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
