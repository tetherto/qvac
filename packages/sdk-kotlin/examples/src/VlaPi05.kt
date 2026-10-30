// Kotlin port of packages/sdk/examples/vla-pi05.ts.
//
// π₀.₅ (pi05) vision-language-action inference. Loads the Physical Intelligence
// π₀.₅ GGUF model, runs a single inference pass with synthetic inputs
// (zero-filled gray images + BOS-only tokens + zero noise), and prints the
// produced action chunk + per-stage timings.
//
// π₀.₅ differs from SmolVLA in two ways the SDK surfaces via `client.vla.hparams()`:
//   - `numCameras: 3` — it expects exactly three camera frames (not two).
//   - `stateInputMode: "discrete"` — the robot state is tokenised into the
//     language prompt, so the `state` buffer is ignored. We pass an empty
//     `FloatArray`. π₀.₅ also requires the `noise` prior.
//
// By default the example pulls the registry-baked π₀.₅ GGUF (~3.9 GB) on first
// run and caches it locally. Pass an absolute path on the command line to
// override and load a local GGUF instead.
//
// The VLA helpers work on plain Kotlin arrays, so no numpy-style dependency is
// needed; `stats` is the raw `JsonObject` the addon returns.
//
// RUN: ./gradlew run -Pexample=VlaPi05 [--args="/abs/path/to/pi05.gguf"]

import io.tether.qvac.sdk.JvmBareRpcTransport
import io.tether.qvac.sdk.QvacClient
import io.tether.qvac.sdk.QvacProgressEvent
import io.tether.qvac.sdk.generated.Models
import io.tether.qvac.sdk.generated.schema.LoadModelResponse
import io.tether.qvac.sdk.generated.schema.ModelProgressResponse
import io.tether.qvac.sdk.models
import io.tether.qvac.sdk.qvacVlaPreprocessImage
import io.tether.qvac.sdk.vla
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.putJsonArray

fun main(args: Array<String>): Unit = runBlocking {
    val modelSrc = args.getOrNull(0) ?: Models.PI05_BASE_Q_AGGRESSIVE.src

    val client = QvacClient(JvmBareRpcTransport.connectResolved(installWorkerIfMissing = true))
    try {
        println("▸ Loading π₀.₅ (pi05) model...")
        val modelId = client.loadWithProgress(
            modelSrc,
            modelType = "ggml-vla",
            modelConfig = buildJsonObject { putJsonArray("backend") { add("cpu") } },
        )
        println("▸ Model loaded: $modelId")

        val (hparams, backendName) = client.vla.hparams(modelId)
        println("▸ Backend: ${backendName ?: "(unknown)"}")
        println("▸ Hparams: $hparams")

        // Build synthetic inputs sized to the model's expectations. A real
        // consumer would: read camera frames, tokenize the instruction with
        // the model's tokenizer, and (for π₀.₅) inline the robot state into
        // the prompt.
        val size = hparams.visionImageSize
        val numCameras = hparams.numCameras ?: 3
        val dummyPixels = FloatArray(size * size * 3) { 128f }
        // π₀.₅ expects exactly `numCameras` frames.
        val images = List(numCameras) { qvacVlaPreprocessImage(dummyPixels, size, size, size = size) }

        val tokens = IntArray(hparams.tokenizerMaxLength)
        val mask = ByteArray(hparams.tokenizerMaxLength)
        // BOS-only "instruction" for the smoke test.
        tokens[0] = 1
        mask[0] = 1

        // Discrete-state model: the state buffer is ignored (state is
        // tokenised into the prompt), so pass an empty array. π₀.₅
        // requires `noise`.
        val state = FloatArray(0)
        val noise = FloatArray(hparams.chunkSize * hparams.maxActionDim)

        println("▸ Running VLA inference...")
        val result = client.vla.run(
            modelId = modelId,
            images = images,
            imgWidth = size,
            imgHeight = size,
            state = state,
            tokens = tokens,
            mask = mask,
            noise = noise,
        )

        println("▸ Got ${result.chunkSize} action steps of dim ${result.actionDim}.")
        println(result.actions.copyOf(result.actionDim).toList())
        result.stats?.let { s ->
            println(
                "▸ Timing: vision=%.0fms prefill=%.0fms ode=%.0fms total=%.0fms".format(
                    s.ms("vision_ms"),
                    s.ms("prefill_total_ms"),
                    s.ms("ode_ms"),
                    s.ms("total_ms"),
                ),
            )
        }

        client.models.unload(modelId)
        println("▸ Model unloaded.")
    } finally {
        client.close()
    }
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
