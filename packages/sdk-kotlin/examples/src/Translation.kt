// Kotlin port of packages/sdk/examples/translation/translation-llm.ts.
//
// LLM-backed translation with an explicit source language and with source
// auto-detection. `client.translation.run()` returns a `QvacTranslationRun`:
// `tokens` is a `Flow<String>` and `final` a `Deferred` with the full text,
// which `text()` awaits (non-stream mode here). With `from` omitted for an LLM
// model, the worker detects the source language from the input.
//
// RUN: ./gradlew run -Pexample=Translation

import io.tether.qvac.sdk.JvmBareRpcTransport
import io.tether.qvac.sdk.QvacClient
import io.tether.qvac.sdk.QvacProgressEvent
import io.tether.qvac.sdk.generated.ModelConstant
import io.tether.qvac.sdk.generated.Models
import io.tether.qvac.sdk.generated.schema.LoadModelResponse
import io.tether.qvac.sdk.generated.schema.ModelProgressResponse
import io.tether.qvac.sdk.models
import io.tether.qvac.sdk.translation
import kotlinx.coroutines.runBlocking

fun main(): Unit = runBlocking {
    val client = QvacClient(JvmBareRpcTransport.connectResolved(installWorkerIfMissing = true))
    try {
        val modelId = client.loadWithProgress(Models.SALAMANDRATA_2B_INST_Q4)

        // Explicit source language.
        val engText = "Hello, how are you today?"
        val explicit = client.translation.run(
            modelId = modelId,
            text = engText,
            from = "en",
            to = "it",
            modelType = "llamacpp-completion",
            stream = false,
        )
        val translatedExplicit = explicit.text()

        // Auto-detected source (await the previous translation first — the LLM
        // addon runs one job at a time).
        val espText = "Hola, como estas?"
        val autodetect = client.translation.run(
            modelId = modelId,
            text = espText,
            to = "en",
            modelType = "llamacpp-completion",
            stream = false,
        )
        val translatedAutodetect = autodetect.text()

        println("Explicit source: $engText -> \"$translatedExplicit\"")
        println("Autodetected source: $espText -> \"$translatedAutodetect\"")

        client.models.unload(modelId)
    } finally {
        client.close()
    }
}

/** Load [model], printing download progress, and return its model id. */
private suspend fun QvacClient.loadWithProgress(model: ModelConstant): String {
    var result: LoadModelResponse? = null
    models.loadWithProgress(model.src, model.engine, model.name).collect { event ->
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
