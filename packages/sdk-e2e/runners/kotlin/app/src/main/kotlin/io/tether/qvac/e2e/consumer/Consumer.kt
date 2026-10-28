package io.tether.qvac.e2e.consumer

import io.tether.qvac.e2e.runner.NotAsserted
import io.tether.qvac.e2e.runner.StepResult
import io.tether.qvac.e2e.runner.asList
import io.tether.qvac.e2e.runner.asMap
import io.tether.qvac.e2e.runner.fromJson
import io.tether.qvac.e2e.runner.summarise
import io.tether.qvac.e2e.runner.toJson
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.Json
import java.time.Instant
import java.util.Locale
import java.util.concurrent.atomic.AtomicBoolean

/** What the consumer runs; the protocol around it is [Consumer]'s. */
interface TestRunner {
    /** Pre-download what the run's tests need, before the first one starts. */
    suspend fun bootstrap(tests: List<Map<String, Any?>>?)

    suspend fun execute(definition: Map<String, Any?>): StepResult

    /** Put the models back between a failed first attempt and its retry. */
    suspend fun reload()

    suspend fun close()
}

/**
 * The batch consumer protocol, ported from packages/test-suite/src/core/consumer-base.ts. Log lines
 * match the JS consumer's: the Device Farm spec reads progress out of logcat by them.
 */
class Consumer(
    private val scope: CoroutineScope,
    private val link: MqttLink,
    private val consumerId: String,
    private val platform: String,
    private val runId: String,
    private val runner: TestRunner,
    definitions: List<Map<String, Any?>>,
    private val log: (String) -> Unit,
) : MqttLink.Listener {
    private val isWildcard = runId == "*"
    private val definitions = definitions.associateBy { it["testId"].toString() }
    private val inbox = Channel<Pair<String, ByteArray>>(Channel.UNLIMITED)

    @Volatile private var registered = false
    @Volatile private var bootstrapped = false
    @Volatile private var shutdownRequested = false
    @Volatile private var processingTest = false
    // Finalizing is reached from batch-complete and from the end of a test, on different threads.
    private val finalizeLock = Mutex()
    private val shutdownStarted = AtomicBoolean(false)
    private var finalProfilingPublished = false
    private var profilingSequence = 0
    // Counted on the queue's coroutine, read by batch-complete's.
    @Volatile private var totalTests = 0
    @Volatile private var testsCompleted = 0
    @Volatile private var testsRetried = 0
    @Volatile private var testsRetriedPassed = 0
    private var heartbeat: Job? = null
    private var registration: Job? = null

    val finished = CompletableDeferred<Unit>()

    fun start() {
        scope.launch {
            for ((topic, payload) in inbox) {
                try {
                    val message = asMap(fromJson(Json.parseToJsonElement(payload.decodeToString())))
                    if (!isWildcard && message["runId"] != runId) continue
                    when (topic) {
                        "qvac/register-ack/$consumerId" -> handleRegistrationAck(message)
                        "qvac/batch-complete" -> handleBatchComplete(message)
                    }
                } catch (error: Exception) {
                    log("❌ Error handling $topic: ${error.message}")
                }
            }
        }
        link.connect(this)
    }

    override fun connected(reconnect: Boolean) {
        if (registered) {
            log("✅ Reconnected to MQTT broker")
            return
        }
        log("✅ Connected to MQTT broker")
        log("🔑 Run ID: $runId${if (isWildcard) " (wildcard mode)" else ""}")
        link.subscribe(listOf("qvac/register-ack/$consumerId", "qvac/batch-complete")) { error ->
            if (error != null) {
                log("❌ Failed to subscribe: ${error.message}")
                return@subscribe
            }
            log("📡 Subscribed to topics\n")
            registration?.cancel()
            registration = scope.launch {
                sendRegistration()
                while (isActive && !registered) {
                    delay(REGISTRATION_RETRY_MS)
                    if (!registered) {
                        log("🔄 Re-sending registration...")
                        sendRegistration()
                    }
                }
            }
        }
    }

    override fun message(topic: String, payload: ByteArray) {
        inbox.trySend(topic to payload)
    }

    override fun lost(reason: String) {
        if (!shutdownStarted.get()) log("📴 Consumer offline: $reason")
    }

    private fun now() = Instant.now().toString()

    private fun publish(topic: String, payload: Map<String, Any?>, qos: Int = 1, done: ((Throwable?) -> Unit)? = null) {
        val report = done ?: { error: Throwable? ->
            if (error != null && !shutdownStarted.get()) log("⚠️  Failed to publish $topic: ${error.message}")
        }
        link.publish(topic, toJson(payload).toString().toByteArray(), qos, report)
    }

    /** What the JS consumer does after a reload or retry times out: the worker may be wedged. */
    private fun stopAfterTimeout(phase: String) {
        shutdownRequested = true
        log("   ⚠️  consumer will stop after $phase timeout")
    }

    private fun sendRegistration() {
        publish("qvac/register", mapOf("runId" to runId, "consumerId" to consumerId, "platform" to platform, "timestamp" to now()))
    }

    private suspend fun handleRegistrationAck(message: Map<String, Any?>) {
        val queue = message["queue"] as? List<*>
        val ackedTotal = (message["totalTests"] as? Number)?.toInt()
        if (queue == null || ackedTotal == null) {
            log("⚠️  Invalid register-ack payload: ${message.keys}")
            return
        }
        totalTests = maxOf(totalTests, ackedTotal)
        // Only the first acknowledgment bootstraps.
        if (registered) return
        registered = true
        log("🔌 Registration ack - $totalTests tests in queue\n")
        startHeartbeat()

        val filteredIds = message["filteredTestIds"] as? List<*>
        val filtered = filteredIds?.let { ids ->
            var unresolved = 0
            var skipped = 0
            val tests = ids.mapNotNull { id ->
                val definition = definitions[id.toString()]
                when {
                    definition == null -> { unresolved++; null }
                    Platforms.skipReason(definition, platform) != null -> { skipped++; null }
                    else -> definition
                }
            }
            if (unresolved > 0) log("⚠️  Producer sent ${ids.size} testId(s); $unresolved don't resolve against local definitions")
            if (skipped > 0) log("⏭️  Dropping bootstrap deps for $skipped test(s) marked as skipped on platform '$platform'")
            tests
        }
        log("🔧 Running bootstrap...")
        val started = System.currentTimeMillis()
        try {
            runner.bootstrap(filtered)
            bootstrapped = true
            log("🔧 Bootstrap completed in ${System.currentTimeMillis() - started}ms\n")
        } catch (error: Exception) {
            log("❌ Bootstrap failed: ${error.message}")
            shutdown()
            return
        }

        if (queue.isEmpty()) {
            publish("qvac/queue-empty", mapOf("runId" to runId, "consumerId" to consumerId, "timestamp" to now()))
            log("📭 No more tests in queue - waiting for batch-complete")
            return
        }
        scope.launch {
            try {
                executeQueue(queue.map(::asMap))
            } catch (error: Exception) {
                log("❌ Queue execution failed: ${error.message}")
                shutdownRequested = true
                finalize()
            }
        }
    }

    private suspend fun executeQueue(queue: List<Map<String, Any?>>) {
        for ((index, item) in queue.withIndex()) {
            // Dekker-style: set before reading shutdownRequested, which batch-complete sets before
            // reading this, so no test starts during shutdown and finalize is never missed.
            processingTest = true
            try {
                if (shutdownRequested) return
                val testId = item["testId"].toString()
                val uniqueTestId = item["uniqueTestId"].toString()
                val definition = definitions[testId]
                if (definition == null) {
                    publishTestPrepare(uniqueTestId)
                    log("❌ No local test definition for: $testId")
                    publishResult(testId, uniqueTestId, "failure", 0, "No local test definition for: $testId")
                } else {
                    executeTest(uniqueTestId, definition)
                }
            } finally {
                processingTest = false
                if (shutdownRequested) finalize()
            }
            if (!shutdownRequested && index < queue.size - 1) delay(INTER_TEST_DELAY_MS)
        }
        log("📭 No more tests in queue - waiting for batch-complete")
    }

    private fun publishTestPrepare(uniqueTestId: String) {
        publish("qvac/test-prepare", mapOf("runId" to runId, "consumerId" to consumerId, "uniqueTestId" to uniqueTestId, "timestamp" to now()))
    }

    private fun publishResult(testId: String, uniqueTestId: String, outcome: String, duration: Long, error: String?, extra: Map<String, Any?> = emptyMap()) {
        val payload = linkedMapOf<String, Any?>(
            "runId" to runId,
            "consumerId" to consumerId,
            "testId" to testId,
            "uniqueTestId" to uniqueTestId,
            "outcome" to outcome,
            "duration" to duration,
            "timestamp" to now(),
        )
        if (error != null) payload["error"] = error
        payload.putAll(extra)
        publish("qvac/results", payload)
    }

    private suspend fun handleBatchComplete(message: Map<String, Any?>) {
        log("\n🎉 Batch complete!")
        log("📊 Total: ${message["totalTests"] ?: 0}")
        log("✅ Passed: ${message["successCount"] ?: 0}")
        log("❌ Failed: ${message["failureCount"] ?: 0}")
        if (testsRetried > 0) {
            val parts = buildList {
                if (testsRetriedPassed > 0) add("✅ passed: $testsRetriedPassed")
                if (testsRetried - testsRetriedPassed > 0) add("❌ failed: ${testsRetried - testsRetriedPassed}")
            }
            log("🔄 Retried: $testsRetried (${parts.joinToString(", ")})")
        }
        log("⏱️  Duration: ${"%.2f".format(Locale.ROOT, ((message["duration"] as? Number)?.toDouble() ?: 0.0) / 1000)}s")
        shutdownRequested = true
        if (processingTest) {
            log("⏳ Waiting for in-progress test to complete before finalizing...")
            return
        }
        finalize()
    }

    private suspend fun executeTest(uniqueTestId: String, definition: Map<String, Any?>) {
        publishTestPrepare(uniqueTestId)
        val testId = definition["testId"].toString()
        val progress = if (totalTests > 0) "[${testsCompleted + 1}/$totalTests]" else ""
        log("▶️  $progress $testId")

        Platforms.skipReason(definition, platform)?.let { reason ->
            log("⏭️  $testId: $reason")
            testsCompleted++
            publishResult(testId, uniqueTestId, "skipped", 0, reason)
            return
        }

        publish("qvac/test-start", mapOf("runId" to runId, "consumerId" to consumerId, "uniqueTestId" to uniqueTestId, "timestamp" to now()))
        val startTime = System.currentTimeMillis()
        val estimated = (asMap(definition["metadata"])["estimatedDurationMs"] as? Number)?.toLong() ?: 0L
        val timeoutMs = maxOf(estimated * 2, MIN_TEST_TIMEOUT_MS)
        val retryOnFailure = definition["retryOnFailure"] == true

        try {
            val result = try {
                withTimeout(timeoutMs) { runner.execute(definition) }
            } catch (timeout: TimeoutCancellationException) {
                if (!retryOnFailure) throw IllegalStateException("Test timeout after ${timeoutMs / 1000}s")
                StepResult.fail("Test timeout after ${timeoutMs / 1000}s")
            }

            var retried = false
            var retryPassed: Boolean? = null
            var retryOutput: String? = null
            var attempt1DurationMs: Long? = null
            if (!result.passed && !result.incomplete && retryOnFailure) {
                retried = true
                log("   ❌ attempt 1:")
                result.output.lines().forEach { log("      $it") }
                log("   ┄┄ reload + retry ┄┄")
                val reloadBoundary = System.currentTimeMillis()
                attempt1DurationMs = reloadBoundary - startTime
                publish(
                    "qvac/test-reload",
                    mapOf("runId" to runId, "consumerId" to consumerId, "uniqueTestId" to uniqueTestId, "testId" to testId, "ts" to reloadBoundary),
                )
                try {
                    val reloadStart = System.currentTimeMillis()
                    withTimeout(timeoutMs) { runner.reload() }
                    log("   reload: ${System.currentTimeMillis() - reloadStart}ms")
                } catch (error: Exception) {
                    if (error is TimeoutCancellationException) stopAfterTimeout("reload")
                    log("   ⚠️  reload failed: ${error.message}")
                    retryPassed = false
                    retryOutput = "reload failed: ${error.message}"
                }
                if (retryOutput == null) {
                    try {
                        val retry = withTimeout(timeoutMs) { runner.execute(definition) }
                        retryPassed = retry.passed
                        retryOutput = retry.output
                        if (retry.passed) {
                            log("   ✅ attempt 2: PASSED")
                        } else {
                            log("   ❌ attempt 2: FAILED")
                            retry.output.lines().forEach { log("      $it") }
                        }
                    } catch (error: Exception) {
                        retryPassed = false
                        retryOutput = "retry threw: ${error.message}"
                        log("   ❌ attempt 2 threw: $retryOutput")
                        if (error is TimeoutCancellationException) stopAfterTimeout("retry")
                    }
                }
                testsRetried++
                if (retryPassed == true) testsRetriedPassed++
            }

            val duration = System.currentTimeMillis() - startTime
            val outcome = when {
                result.incomplete -> "incomplete"
                result.passed -> "success"
                else -> "failure"
            }
            when {
                result.incomplete -> log("🚧 $testId: ${result.reason ?: result.output}")
                retried -> log("⚠️  $testId (${duration}ms) [retry:${if (retryPassed == true) "✅ passed" else "❌ failed"}]")
                else -> {
                    log("${if (outcome == "success") "✅" else "❌"} $testId (${duration}ms)")
                    if (!result.passed && result.output.isNotEmpty()) result.output.lines().forEach { log("   $it") }
                }
            }
            testsCompleted++

            val extra = linkedMapOf<String, Any?>()
            if (result.incomplete) extra["incompleteReason"] = result.reason ?: result.output
            if (result.assertedValue !== NotAsserted) extra["assertedValue"] = summarise(result.assertedValue)
            if (retried) {
                extra["retried"] = true
                extra["retryPassed"] = retryPassed
                extra["retryOutput"] = retryOutput
                extra["attempt1DurationMs"] = attempt1DurationMs
            }
            val error = when {
                result.incomplete -> result.output
                result.passed -> null
                else -> result.output
            }
            publishResult(testId, uniqueTestId, outcome, if (result.incomplete) 0 else duration, error, extra)
        } catch (error: Exception) {
            val duration = System.currentTimeMillis() - startTime
            val message = error.message ?: "Unknown error"
            log("❌ $testId failed: $message")
            testsCompleted++
            publishResult(testId, uniqueTestId, "failure", duration, message)
        }
    }

    private fun startHeartbeat() {
        heartbeat = scope.launch {
            while (isActive) {
                delay(HEARTBEAT_MS)
                if (!shutdownRequested) {
                    publish(
                        "qvac/heartbeat",
                        mapOf("runId" to runId, "consumerId" to consumerId, "bootstrapped" to bootstrapped, "timestamp" to now()),
                        qos = 0,
                    )
                }
            }
        }
    }

    private suspend fun finalize() {
        finalizeLock.withLock { publishFinalProfiling() }
        shutdown()
    }

    private suspend fun publishFinalProfiling() {
        if (!finalProfilingPublished) {
            finalProfilingPublished = true
            // No profiler here, but the producer waits for a final export: send an empty one.
            val published = CompletableDeferred<Unit>()
            publish(
                "qvac/profiling",
                mapOf(
                    "runId" to runId,
                    "consumerId" to consumerId,
                    "timestamp" to now(),
                    "kind" to "final",
                    "sequence" to ++profilingSequence,
                    "profilerExport" to mapOf(
                        "config" to mapOf(
                            "enabled" to false,
                            "mode" to "summary",
                            "includeServerBreakdown" to false,
                            "operationFilters" to emptyList<Any?>(),
                            "maxRecentEvents" to 0,
                        ),
                        "aggregates" to emptyMap<String, Any?>(),
                        "exportedAt" to System.currentTimeMillis(),
                    ),
                ),
            ) { error ->
                if (error != null) log("⚠️  Failed to publish profiling data: ${error.message}") else log("📈 Profiling data published")
                published.complete(Unit)
            }
            withTimeoutOrNull(PROFILING_PUBLISH_TIMEOUT_MS) { published.await() }
        }
    }

    suspend fun shutdown() {
        if (!shutdownStarted.compareAndSet(false, true)) return
        log("\n👋 Consumer shutting down...")
        heartbeat?.cancel()
        registration?.cancel()
        try {
            // A worker wedged enough to have stopped the run must not keep the broker session open.
            withTimeoutOrNull(CLOSE_TIMEOUT_MS) { runner.close() }
                ?: log("⚠️  onShutdown: closing the runner did not finish within ${CLOSE_TIMEOUT_MS / 1000}s")
        } catch (error: Exception) {
            log("⚠️  onShutdown error: ${error.message}")
        } finally {
            link.close()
            inbox.close()
            finished.complete(Unit)
        }
    }

    private companion object {
        const val REGISTRATION_RETRY_MS = 3000L
        const val HEARTBEAT_MS = 15000L
        const val INTER_TEST_DELAY_MS = 100L
        const val MIN_TEST_TIMEOUT_MS = 120000L
        const val PROFILING_PUBLISH_TIMEOUT_MS = 10000L
        const val CLOSE_TIMEOUT_MS = 90000L
    }
}

/** Platform policy as the framework applies it (consumer-base.ts `getTestSkipReason`). */
object Platforms {
    private val OPERATING_SYSTEMS = setOf("macos", "linux", "windows", "ios", "android")

    /**
     * Matching is by segment prefix, and a coarse entry widens over the OS and nothing else:
     * `mobile` covers `mobile-android`, but `kotlin` does not cover some other Kotlin client.
     */
    fun matches(declared: List<*>, platform: String): Boolean {
        val segments = platform.split("-")
        return declared.any { raw ->
            val entry = raw.toString()
            if (entry == platform) return@any true
            val entrySegments = entry.split("-")
            entrySegments.size < segments.size &&
                entrySegments.indices.all { entrySegments[it] == segments[it] } &&
                segments.drop(entrySegments.size).all { it in OPERATING_SYSTEMS }
        }
    }

    fun skipReason(definition: Map<String, Any?>, platform: String): String? {
        val skip = asMap(definition["skip"])
        val platforms = asList(skip["platforms"])
        if (platforms.isEmpty() || !matches(platforms, platform)) return null
        val own = asList(skip["reasons"]).map(::asMap)
            .filter { matches(asList(it["platforms"]), platform) }
            .map { it["reason"].toString() }
        return if (own.isNotEmpty()) own.joinToString(" | ") else skip["reason"]?.toString()
    }
}
