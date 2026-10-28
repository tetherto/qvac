package io.tether.qvac.e2e.consumer

import io.tether.qvac.e2e.runner.Calls
import io.tether.qvac.e2e.runner.Interpreter
import io.tether.qvac.e2e.runner.Resources
import io.tether.qvac.e2e.runner.StepResult
import io.tether.qvac.e2e.runner.Wire
import io.tether.qvac.e2e.runner.asList
import io.tether.qvac.e2e.runner.asMap
import io.tether.qvac.sdk.QvacClient
import io.tether.qvac.sdk.generated.ModelConstant
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import java.util.concurrent.atomic.AtomicInteger

class Runtime(
    val client: QvacClient,
    val wire: Wire,
    val resources: Resources,
    val calls: Calls,
    val interpreter: Interpreter,
)

/**
 * The runtime starts in [bootstrap], after registration, as the JS mobile consumer's worker does:
 * worker startup does not have to fit in the producer's registration window.
 */
class E2eRunner(
    private val start: suspend () -> Runtime,
    private val log: (String) -> Unit,
) : TestRunner {
    private var started: Runtime? = null

    private suspend fun runtime(): Runtime = started ?: start().also { started = it }

    override suspend fun bootstrap(tests: List<Map<String, Any?>>?) {
        val runtime = runtime()
        val resources = runtime.resources
        // As runners/js/shared/collect-test-deps.ts: declared deps, or every key without a filter.
        val deps = tests?.flatMap(::declaredDeps)?.toSet() ?: resources.keys
        val constants = resources.constantsFor(deps)
        log("📥 Pre-downloading ${constants.size} unique model constant(s) for ${deps.size} resource key(s)...")
        val gate = Semaphore(DOWNLOAD_CONCURRENCY)
        val done = AtomicInteger()
        coroutineScope {
            for (constant in constants) {
                launch {
                    gate.withPermit { download(runtime.wire, constant) }
                    log("   [${done.incrementAndGet()}/${constants.size}] ${constant.name}")
                }
            }
        }
        log("📦 All ${constants.size} constant(s) pre-cached")
    }

    /** One model into the cache, retried: a registry download over a phone's network is flaky. */
    private suspend fun download(wire: Wire, constant: ModelConstant) {
        var attempt = 1
        while (true) {
            try {
                val response = wire.send(
                    mapOf(
                        "type" to "downloadAsset",
                        "assetSrc" to constant.src,
                        "withProgress" to false,
                        "seed" to false,
                        "requestId" to Wire.requestId(),
                    ),
                )
                Wire.requireSuccess(response, "DOWNLOAD_ASSET_FAILED")
                return
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                if (attempt >= DOWNLOAD_ATTEMPTS) throw IllegalStateException("pre-download of ${constant.name} failed: ${error.message}", error)
                log("   ⚠️  ${constant.name} attempt $attempt failed (${error.message}); retrying")
                delay(DOWNLOAD_RETRY_DELAY_MS * attempt)
                attempt++
            }
        }
    }

    override suspend fun execute(definition: Map<String, Any?>): StepResult {
        val steps = asList(definition["steps"]).map(::asMap)
        if (steps.isEmpty()) {
            // A test without a declarative body is written per client; this one has none of those.
            return StepResult.incomplete("${definition["testId"]} carries no steps and this client has no body for it")
        }
        return runtime().interpreter.run(
            steps = steps,
            params = asMap(definition["params"]),
            expectation = asMap(definition["expectation"]),
            teardown = asList(definition["finally"]).map(::asMap),
        )
    }

    override suspend fun reload() = runtime().resources.close()

    override suspend fun close() {
        val runtime = started ?: return
        try {
            runtime.resources.close()
            runtime.calls.close()
        } finally {
            // Bounded and non-cancellable: the worker must not outlive the run, nor a wedged one
            // keep shutdown from leaving the broker.
            withContext(NonCancellable) { withTimeoutOrNull(CLIENT_CLOSE_TIMEOUT_MS) { runtime.client.close() } }
        }
    }

    private fun declaredDeps(test: Map<String, Any?>): List<String> {
        val metadata = asMap(test["metadata"])
        val single = (metadata["dependency"] as? String)?.takeIf { it != "none" }?.split("+").orEmpty()
        val multi = asList(metadata["dependencies"]).map(Any?::toString)
        return (single + multi).filter { it.isNotEmpty() && it != "none" }
    }

    private companion object {
        /** DEFAULT_DOWNLOAD_CONCURRENCY.mobile in runners/js/shared/bootstrap-downloads.ts. */
        const val DOWNLOAD_CONCURRENCY = 4
        const val DOWNLOAD_ATTEMPTS = 3
        const val DOWNLOAD_RETRY_DELAY_MS = 5000L
        const val CLIENT_CLOSE_TIMEOUT_MS = 10_000L
    }
}
