// Kotlin port of packages/sdk/examples/vla-smolvla.ts.
//
// Vision-language-action inference with SmolVLA. Loads the GGUF model, reads the
// model's hyperparameters, builds synthetic inputs sized to those hparams
// (gray images + BOS-only tokens + zero state + zero noise), runs one inference
// pass, and prints the produced action chunk.
//
// The VLA helpers (`qvacVlaPreprocessImage`, `qvacVlaPadState`) work on plain
// `FloatArray`/`IntArray`/`ByteArray`, so unlike the Python port this needs no
// numpy-style dependency. `client.vla.hparams()` returns the typed
// `QvacVlaHparams`.
//
// RUN: ./gradlew run -Pexample=Vla [--args="path/to/smolvla.gguf"]

import io.tether.qvac.sdk.JvmBareRpcTransport
import io.tether.qvac.sdk.QvacClient
import io.tether.qvac.sdk.QvacProgressEvent
import io.tether.qvac.sdk.generated.Models
import io.tether.qvac.sdk.generated.schema.LoadModelResponse
import io.tether.qvac.sdk.generated.schema.ModelProgressResponse
import io.tether.qvac.sdk.models
import io.tether.qvac.sdk.qvacVlaPadState
import io.tether.qvac.sdk.qvacVlaPreprocessImage
import io.tether.qvac.sdk.vla
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.putJsonArray

fun main(args: Array<String>): Unit = runBlocking {
    val modelSrc = args.getOrNull(0) ?: Models.SMOLVLA_LIBERO_VISION_Q8.src

    val client = QvacClient(JvmBareRpcTransport.connectResolved(installWorkerIfMissing = true))
    try {
        println("▸ Loading SmolVLA model...")
        val modelId = client.loadWithProgress(
            modelSrc,
            modelType = "ggml-vla",
            modelConfig = buildJsonObject { putJsonArray("backend") { add("cpu") } },
        )
        println("▸ Model loaded: $modelId")

        val (hparams, backendName) = client.vla.hparams(modelId)
        println("▸ Backend: ${backendName ?: "(unknown)"}")
        println("▸ Hparams: $hparams")

        // Synthetic inputs sized to the model's expectations. A real consumer
        // would read camera frames, tokenize the instruction with the
        // SmolVLM2 tokenizer, and read the robot's current end-effector pose.
        val size = hparams.visionImageSize
        val dummyPixels = FloatArray(size * size * 3) { 128f }
        val front = qvacVlaPreprocessImage(dummyPixels, size, size, size = size)
        val wrist = qvacVlaPreprocessImage(dummyPixels, size, size, size = size)

        val tokens = IntArray(hparams.tokenizerMaxLength)
        val mask = ByteArray(hparams.tokenizerMaxLength)
        // BOS-only "instruction" for the smoke test.
        tokens[0] = 1
        mask[0] = 1

        val state = qvacVlaPadState(FloatArray(6), hparams.maxStateDim)
        val noise = FloatArray(hparams.chunkSize * hparams.maxActionDim)

        println("▸ Running VLA inference...")
        val result = client.vla.run(
            modelId = modelId,
            images = listOf(front, wrist),
            imgWidth = size,
            imgHeight = size,
            state = state,
            tokens = tokens,
            mask = mask,
            noise = noise,
        )

        println("▸ Got ${result.chunkSize} action steps of dim ${result.actionDim}.")
        println(result.actions.copyOf(result.actionDim).toList())
        result.stats?.let { println("▸ Timing: $it") }

        client.models.unload(modelId)
        println("▸ Model unloaded.")
    } finally {
        client.close()
    }
}

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
