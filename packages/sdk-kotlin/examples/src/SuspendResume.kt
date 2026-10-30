// Kotlin port of packages/sdk/examples/suspend-resume.ts.
//
// Loads a model, runs a completion, suspends the runtime, shows that a new
// completion is blocked while suspended, then resumes and runs another
// completion. `client.system.state()` is sampled at each step.
//
// `client.system` wraps the lifecycle operations: `pause()` sends `suspend`
// (`suspend` is a Kotlin keyword), `resume()` and `state()`. The lifecycle
// state is the generated `StateResponseState` enum. Worker errors map onto the
// typed `QvacKnownException` hierarchy, so the blocked call is caught by its
// own class, `ServerLifecycleOperationBlocked`, instead of comparing names.
//
// RUN: ./gradlew run -Pexample=SuspendResume

import io.tether.qvac.sdk.JvmBareRpcTransport
import io.tether.qvac.sdk.QvacClient
import io.tether.qvac.sdk.QvacCompletionOptions
import io.tether.qvac.sdk.QvacMessage
import io.tether.qvac.sdk.QvacProgressEvent
import io.tether.qvac.sdk.completion
import io.tether.qvac.sdk.generated.ModelConstant
import io.tether.qvac.sdk.generated.Models
import io.tether.qvac.sdk.generated.QvacKnownException
import io.tether.qvac.sdk.generated.schema.LoadModelResponse
import io.tether.qvac.sdk.generated.schema.ModelProgressResponse
import io.tether.qvac.sdk.models
import io.tether.qvac.sdk.run
import io.tether.qvac.sdk.system
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking

fun main(): Unit = runBlocking {
    val client = QvacClient(JvmBareRpcTransport.connectResolved(installWorkerIfMissing = true))
    try {
        // Load a model
        val modelId = client.loadWithProgress(Models.LLAMA_3_2_1B_INST_Q4_0)

        println("▸ Model loaded\n")

        println("▸ Lifecycle state: ${client.lifecycleState()}\n")

        // Run a completion before suspending
        println("▸ Completion before suspend")
        client.streamCompletion(modelId, "Say hello in one word")

        // Suspend all networking and storage (e.g. app going to background)
        println("▸ Suspending...")
        client.system.pause()
        println("▸ Lifecycle state: ${client.lifecycleState()}\n")

        try {
            client.completion.run(
                modelId = modelId,
                history = listOf(QvacMessage.user("This should fail")),
                options = QvacCompletionOptions(stream = false),
            ).text()
        } catch (error: QvacKnownException.ServerLifecycleOperationBlocked) {
            println("▸ Operation blocked while suspended (${error.errorName})")
        }

        // Simulate time in background
        println("\n▸ Simulating 3 seconds in background...")
        delay(3_000)

        // Resume when returning to foreground
        println("▸ Resuming...")
        client.system.resume()
        println("▸ Lifecycle state: ${client.lifecycleState()}\n")

        // Run another completion after resuming
        println("▸ Completion after resume")
        client.streamCompletion(modelId, "Say goodbye in one word")

        client.models.unload(modelId)
        println("▸ Model unloaded")
    } finally {
        client.close()
    }
}

/** The lifecycle state by its wire name: `active`, `suspending`, `suspended` or `resuming`. */
private suspend fun QvacClient.lifecycleState(): String = system.state().state.name.lowercase()

private suspend fun QvacClient.streamCompletion(modelId: String, content: String) {
    completion.run(modelId = modelId, history = listOf(QvacMessage.user(content))).tokens.collect { print(it) }
    println()
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
