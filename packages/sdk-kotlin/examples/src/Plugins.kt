// Kotlin port of packages/sdk/examples/plugins.ts (plugin invocation).
//
// The low-level plugin API. A model's `modelType` selects a plugin; each plugin
// exposes named `handler`s with their own request/response schemas.
// `client.plugins.invoke()` runs one handler and returns its result;
// `client.plugins.stream()` returns a `Flow` of streamed chunks.
//
// This example uses the `custom-echo-plugin` fixture (modelType `echo`), whose
// handlers are `echo` ({message} -> {message}) and `echoStream` ({message} ->
// {chunk} chunks). To run it you need a worker bundled with that plugin; point
// the loader at it via args, or adapt the handler/params to your own plugin.
// (A production model that exposes handlers is VLA — see Vla.kt, which drives
// the `vlaRun` / `vlaHparams` handlers through the typed `client.vla` wrapper.)
//
// Plugin payloads are plugin-defined, so `params` and `result` stay
// `JsonElement`. The stream flow carries every wire frame, including the
// closing `done` frame, so it is filtered out here.
//
// RUN: ./gradlew run -Pexample=Plugins --args="<model-src>"

import io.tether.qvac.sdk.JvmBareRpcTransport
import io.tether.qvac.sdk.QvacClient
import io.tether.qvac.sdk.QvacProgressEvent
import io.tether.qvac.sdk.generated.schema.LoadModelResponse
import io.tether.qvac.sdk.generated.schema.ModelProgressResponse
import io.tether.qvac.sdk.generated.schema.PluginInvokeRequest
import io.tether.qvac.sdk.generated.schema.PluginInvokeStreamRequest
import io.tether.qvac.sdk.models
import io.tether.qvac.sdk.plugins
import kotlin.system.exitProcess
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

fun main(args: Array<String>): Unit = runBlocking {
    if (args.isEmpty()) {
        System.err.println(
            "Usage: ./gradlew run -Pexample=Plugins --args=\"<model-src>\"\n" +
                "  <model-src> must resolve to a model whose plugin exposes the " +
                "'echo'/'echoStream' handlers (the custom-echo-plugin fixture).",
        )
        exitProcess(1)
    }
    val modelSrc = args[0]

    val client = QvacClient(JvmBareRpcTransport.connectResolved(installWorkerIfMissing = true))
    try {
        println("▸ Loading plugin-backed model...")
        val modelId = client.loadWithProgress(modelSrc, modelType = "echo")
        println("▸ Model loaded: $modelId")

        println("\n▸ 1. plugins.invoke (request/reply handler 'echo')")
        val response = client.plugins.invoke(
            PluginInvokeRequest(
                modelId = modelId,
                handler = "echo",
                params = buildJsonObject { put("message", "hello from the kotlin sdk") },
            ),
        )
        println("▸ echo -> ${response.result}")

        println("\n▸ 2. plugins.stream (streaming handler 'echoStream')")
        print("▸ chunks: ")
        client.plugins.stream(
            PluginInvokeStreamRequest(
                modelId = modelId,
                handler = "echoStream",
                params = buildJsonObject { put("message", "streamed message") },
            ),
        ).filter { it.done != true }.collect { frame ->
            val chunk = (frame.result as? JsonObject)?.get("chunk") ?: frame.result
            print((chunk as? JsonPrimitive)?.content ?: chunk.toString())
            System.out.flush()
        }
        println()

        client.models.unload(modelId)
        println("▸ Model unloaded")
    } finally {
        client.close()
    }
}

/** Load [source] as [modelType], printing download progress, and return its model id. */
private suspend fun QvacClient.loadWithProgress(source: String, modelType: String): String {
    var result: LoadModelResponse? = null
    models.loadWithProgress(source, modelType).collect { event ->
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
