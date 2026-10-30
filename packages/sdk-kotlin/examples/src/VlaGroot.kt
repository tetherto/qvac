// Kotlin port of packages/sdk/examples/vla-groot.ts.
//
// NVIDIA GR00T N1.7-3B (vision-language-action) inference. Loads the
// GR00T-N1.7-3B LIBERO GGUF model, runs a single inference pass with synthetic
// inputs, and prints the produced action chunk + per-stage timings.
//
// GR00T differs from SmolVLA / π₀.₅ in the ways the SDK surfaces via
// `client.vla.hparams()`:
//   - `imageInputMode: "patches"` — each `images` entry is a pre-patchified
//     buffer of `hparams.imagePatchElems` floats, NOT a `3·w·h` pixel plane.
//     A real consumer patchifies each camera frame the way `Gr00tPolicy` does
//     (the model's learned patch-embed runs inside the addon); here we feed
//     synthetic patch buffers of the right length.
//   - `stateInputMode: "continuous"` — the robot state is projected by an
//     in-model linear layer; pad it to `hparams.maxStateDim` with
//     `qvacVlaPadState`.
//   - `noise` is REQUIRED. GR00T is a flow-matching model that does not sample
//     its own prior; a missing `noise` is rejected as INVALID_INPUT.
//
// The prompt must place one contiguous run of `MERGED_TOKENS_PER_IMAGE`
// image-placeholder tokens per camera. A real consumer produces this by
// tokenising the instruction with the Qwen3-VL tokenizer, which inserts the
// image tokens; we lay it out by hand for the smoke.
//
// By default the example pulls the registry-baked GR00T-LIBERO GGUF (~3.76 GB)
// on first run and caches it locally. Pass an absolute path on the command line
// to override and load a local GGUF instead.
//
// Multi-embodiment GGUFs (vla-ggml >= 0.17.0): one GGUF can carry many
// embodiments, one active at a time. Optional env vars demonstrate selection:
//   QVAC_GROOT_EMBODIMENT        initial selection at load — a tag
//                                (e.g. 'libero_sim') or a numeric cat_id
//   QVAC_GROOT_SWITCH_EMBODIMENT after load, switch via client.vla.setEmbodiment()
//                                and run inference on the new embodiment
// Both are no-ops you can omit; the GGUF's default embodiment is used. On a
// single-embodiment GGUF a switch is rejected by the addon.
//
// The embodiment is the sealed `QvacVlaEmbodiment` (`Tag` or `CategoryId`),
// validated client-side before it reaches the worker. The VLA helpers work on
// plain Kotlin arrays, so no numpy-style dependency is needed.
//
// RUN: ./gradlew run -Pexample=VlaGroot [--args="/abs/path/to/groot.gguf"]

import io.tether.qvac.sdk.JvmBareRpcTransport
import io.tether.qvac.sdk.QvacClient
import io.tether.qvac.sdk.QvacProgressEvent
import io.tether.qvac.sdk.QvacVlaEmbodiment
import io.tether.qvac.sdk.QvacVlaHparams
import io.tether.qvac.sdk.generated.Models
import io.tether.qvac.sdk.generated.schema.LoadModelResponse
import io.tether.qvac.sdk.generated.schema.ModelProgressResponse
import io.tether.qvac.sdk.models
import io.tether.qvac.sdk.qvacVlaPadState
import io.tether.qvac.sdk.vla
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray

// LIBERO GR00T prompt layout (Qwen3-VL tokenizer). GR00T reports
// `hparams.tokenizerMaxLength == 0` — it does not surface a tokenizer
// length, so the prompt length is fixed by the model: 2 cameras × 64 merged
// image tokens (256 patches, 2×2 merge) = 128 image tokens, plus text ≈ 150
// total. A real consumer gets these from the tokenizer; the smoke hard-codes
// them. The prompt length follows the ACTIVE embodiment's camera count (a
// 4-camera DROID row needs 4 image-token runs, which a fixed 2-camera length
// cannot hold), so it is computed per inference, not a constant.
private const val IMAGE_TOKEN_ID = 151655
private const val MERGED_TOKENS_PER_IMAGE = 64
private const val PROMPT_TEXT_TAIL = 20
private const val TEXT_TOKEN_ID = 1000

fun main(args: Array<String>): Unit = runBlocking {
    val modelSrc = args.getOrNull(0) ?: Models.GROOT_Q8_VF16.src
    val embodiment = embodimentFromEnv("QVAC_GROOT_EMBODIMENT")
    val switchEmbodiment = embodimentFromEnv("QVAC_GROOT_SWITCH_EMBODIMENT")

    val client = QvacClient(JvmBareRpcTransport.connectResolved(installWorkerIfMissing = true))
    try {
        println("▸ Loading GR00T (N1.7-3B LIBERO) model...")
        val modelId = client.loadWithProgress(
            modelSrc,
            modelType = "ggml-vla",
            modelConfig = buildJsonObject {
                putJsonArray("backend") { add("cpu") }
                embodiment?.let { put("embodiment", it.toJson()) }
            },
        )
        println("▸ Model loaded: $modelId")

        val (hparams, backendName) = client.vla.hparams(modelId)
        println("▸ Backend: ${backendName ?: "(unknown)"}")
        println("▸ Hparams: $hparams")
        if (hparams.selectedEmbodimentTag != null) printEmbodiment(hparams)

        client.runInference(modelId, hparams)

        if (switchEmbodiment != null) {
            println("▸ Switching embodiment to ${switchEmbodiment.toJson()}...")
            val refreshed = client.vla.setEmbodiment(modelId, switchEmbodiment)
            printEmbodiment(refreshed)
            client.runInference(modelId, refreshed)
        }

        client.models.unload(modelId)
        println("▸ Model unloaded.")
    } finally {
        client.close()
    }
}

/**
 * Inputs are sized off the hparams, which follow the ACTIVE embodiment
 * (numCameras, actionDim, ...) — rebuild them after every embodiment switch.
 */
private suspend fun QvacClient.runInference(modelId: String, hp: QvacVlaHparams) {
    val patchElems = hp.imagePatchElems
    check(hp.imageInputMode == "patches" && patchElems != null) {
        "expected a patch-input model (imageInputMode 'patches' + imagePatchElems); " +
            "got imageInputMode=${hp.imageInputMode}"
    }

    val numCameras = hp.numCameras ?: 2

    // Patch-input model: each camera is a pre-patchified buffer of exactly
    // `imagePatchElems` floats. A real consumer patchifies each camera frame
    // the way `Gr00tPolicy` does (the model's learned patch-embed runs inside
    // the addon); we use small synthetic values.
    val images = List(numCameras) { FloatArray(patchElems) { 0.02f } }

    // Continuous-state model: pad the robot state to `maxStateDim`.
    val state = qvacVlaPadState(FloatArray(6), hp.maxStateDim)

    // GR00T requires the noise prior (flow-matching; it is not sampled in-model).
    val noise = FloatArray(hp.chunkSize * hp.maxActionDim)

    // Prompt: one run of `MERGED_TOKENS_PER_IMAGE` image tokens per camera,
    // each followed by a text separator, plus a short text tail. Sized off the
    // active embodiment's camera count — a fixed 2-camera length would silently
    // truncate the image-token runs of cameras 3+ after a switch to e.g. the
    // 4-camera DROID row.
    val promptLength = numCameras * (MERGED_TOKENS_PER_IMAGE + 1) + PROMPT_TEXT_TAIL
    val tokens = IntArray(promptLength)
    var w = 0
    for (cam in 0 until numCameras) {
        repeat(MERGED_TOKENS_PER_IMAGE) {
            if (w < promptLength) tokens[w++] = IMAGE_TOKEN_ID
        }
        if (w < promptLength) tokens[w++] = TEXT_TOKEN_ID + cam
    }
    for (i in w until promptLength) tokens[i] = TEXT_TOKEN_ID + i
    val mask = ByteArray(promptLength) { 1 }

    println("▸ Running VLA inference...")
    val result = vla.run(
        modelId = modelId,
        images = images,
        // Patch inputs ignore imgWidth/imgHeight, but the request requires
        // positive integers; pass the model's vision image size.
        imgWidth = hp.visionImageSize,
        imgHeight = hp.visionImageSize,
        state = state,
        tokens = tokens,
        mask = mask,
        noise = noise,
    )

    println("▸ Got ${result.chunkSize} action steps of dim ${result.actionDim}.")
    println(result.actions.copyOf(result.actionDim).toList())
    result.stats?.let { s ->
        println(
            "▸ Timing: vision=%.0fms ode=%.0fms total=%.0fms".format(
                s.ms("vision_ms"),
                s.ms("ode_ms"),
                s.ms("total_ms"),
            ),
        )
    }
}

private fun printEmbodiment(hp: QvacVlaHparams) {
    println(
        "▸ Embodiment: ${hp.selectedEmbodimentTag} " +
            "(cat_id ${hp.selectedEmbodimentCatId}, ${hp.numCameras} cameras)",
    )
}

/** A tag string or a numeric cat_id, straight from the env. "24" is a cat_id, "libero_sim" a tag. */
private fun embodimentFromEnv(name: String): QvacVlaEmbodiment? {
    val raw = System.getenv(name)
    if (raw.isNullOrEmpty()) return null
    return if (raw.all(Char::isDigit)) QvacVlaEmbodiment.CategoryId(raw.toInt()) else QvacVlaEmbodiment.Tag(raw)
}

/** A timing entry of the addon's `stats` object, 0 when absent. */
private fun JsonObject.ms(key: String): Double = (get(key) as? JsonPrimitive)?.doubleOrNull ?: 0.0

/** Load [source] as [modelType], printing download progress, and return its model id. */
private suspend fun QvacClient.loadWithProgress(source: String, modelType: String, modelConfig: JsonObject): String {
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
