// Kotlin port of packages/sdk/examples/llamacpp-multimodal.ts.
//
// Multimodal completion. Load a multimodal LLM together with its matching
// projection model, then hang `attachments` off a user turn: one image first,
// then both images in a single request so the model can compare them.
//
// The projection model goes in `modelConfig` as `projectionModelSrc`, the same
// wire field as JS and Python; a `ModelConstant` is passed by its `.src`.
// Attachments are typed `QvacAttachment` values on `QvacMessage.user()`.
//
// RUN: ./gradlew run -Pexample=Multimodal --args="<image path> [<second image path>]"

import io.tether.qvac.sdk.JvmBareRpcTransport
import io.tether.qvac.sdk.QvacAttachment
import io.tether.qvac.sdk.QvacClient
import io.tether.qvac.sdk.QvacMessage
import io.tether.qvac.sdk.QvacProgressEvent
import io.tether.qvac.sdk.completion
import io.tether.qvac.sdk.generated.ModelConstant
import io.tether.qvac.sdk.generated.Models
import io.tether.qvac.sdk.generated.schema.LoadModelResponse
import io.tether.qvac.sdk.generated.schema.ModelProgressResponse
import io.tether.qvac.sdk.models
import io.tether.qvac.sdk.run
import kotlin.system.exitProcess
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

fun main(args: Array<String>): Unit = runBlocking {
    if (args.isEmpty()) {
        System.err.println(
            "▸ Specify an image file path as the first argument and a second " +
                "image file path as the second (optional) argument",
        )
        exitProcess(1)
    }

    val imageFilePath = args[0]

    val client = QvacClient(JvmBareRpcTransport.connectResolved(installWorkerIfMissing = true))
    try {
        // Load the main model with projection in a single step
        val modelId = client.loadWithProgress(
            Models.SMOLVLM2_500M_MULTIMODAL_Q8_0,
            modelConfig = buildJsonObject {
                // An image is tiled into hundreds of context units before a
                // single word of the prompt is counted, and the comparison
                // below sends two at once.
                put("ctx_size", 8192)
                put("projectionModelSrc", Models.MMPROJ_SMOLVLM2_500M_MULTIMODAL_Q8_0.src)
            },
        )

        // Using one particular media
        val history = listOf(QvacMessage.user("What's in this image?", listOf(QvacAttachment(imageFilePath))))
        val run = client.completion.run(modelId = modelId, history = history)

        run.tokens.collect { print(it) }

        val final = run.final.await()
        println("\n▸ Performance Stats: ${final.stats?.raw}")
        println("▸ --------------------------------")

        // Using multiple media
        if (args.size < 2) {
            println("▸ Only one image provided, terminating")
            return@runBlocking
        }

        val imageFilePath2 = args[1]

        val history2 = listOf(
            QvacMessage.user(
                "Compare the two newspaper articles",
                listOf(QvacAttachment(imageFilePath), QvacAttachment(imageFilePath2)),
            ),
        )
        val run2 = client.completion.run(modelId = modelId, history = history2)

        run2.tokens.collect { print(it) }

        val final2 = run2.final.await()
        println("\n▸ Performance Stats: ${final2.stats?.raw}")
        println("▸ --------------------------------")

        client.models.unload(modelId)
    } finally {
        client.close()
    }
}

/** Load [model], printing download progress, and return its model id. */
private suspend fun QvacClient.loadWithProgress(model: ModelConstant, modelConfig: JsonObject? = null): String {
    var result: LoadModelResponse? = null
    models.loadWithProgress(model.src, model.engine, model.name, modelConfig = modelConfig).collect { event ->
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
