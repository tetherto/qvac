package io.tether.qvac.e2e.consumer

import io.tether.qvac.e2e.runner.StepResult
import io.tether.qvac.e2e.runner.asMap
import io.tether.qvac.e2e.runner.fromJson
import io.tether.qvac.e2e.runner.toJson
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

private class FakeLink : MqttLink {
    lateinit var listener: MqttLink.Listener
    val published = mutableListOf<Pair<String, Map<String, Any?>>>()
    var closed = false

    override fun connect(listener: MqttLink.Listener) {
        this.listener = listener
        listener.connected(reconnect = false)
    }

    override fun subscribe(topics: List<String>, done: (Throwable?) -> Unit) = done(null)

    override fun publish(topic: String, payload: ByteArray, qos: Int, done: ((Throwable?) -> Unit)?) {
        published += topic to asMap(fromJson(Json.parseToJsonElement(payload.decodeToString())))
        done?.invoke(null)
    }

    override fun close() {
        closed = true
    }

    fun deliver(topic: String, message: Map<String, Any?>) =
        listener.message(topic, toJson(message).toString().toByteArray())

    fun on(topic: String) = published.filter { it.first == topic }.map { it.second }
}

private class FakeRunner(private val results: MutableList<StepResult>) : TestRunner {
    var bootstrapped: List<Map<String, Any?>>? = null
    var reloads = 0
    var closed = false

    override suspend fun bootstrap(tests: List<Map<String, Any?>>?) {
        bootstrapped = tests
    }

    override suspend fun execute(definition: Map<String, Any?>): StepResult = results.removeAt(0)

    override suspend fun reload() {
        reloads++
    }

    override suspend fun close() {
        closed = true
    }
}

class ConsumerTest {
    private val definitions = listOf(
        mapOf("testId" to "runs", "metadata" to mapOf("estimatedDurationMs" to 1000L)),
        mapOf("testId" to "flaky", "retryOnFailure" to true),
        mapOf(
            "testId" to "skipped",
            "skip" to mapOf("reason" to "not on phones", "platforms" to listOf("kotlin-android")),
        ),
    )

    private fun TestScope.consumer(link: FakeLink, runner: TestRunner) = Consumer(
        scope = backgroundScope,
        link = link,
        consumerId = "c1",
        platform = "kotlin-android",
        runId = "run-1",
        runner = runner,
        definitions = definitions,
        log = {},
    ).also { it.start() }

    private fun ack(vararg testIds: String) = mapOf(
        "runId" to "run-1",
        "status" to "registered",
        "totalTests" to testIds.size.toLong(),
        "queue" to testIds.mapIndexed { index, id -> mapOf("uniqueTestId" to "u$index", "testId" to id) },
        "filteredTestIds" to testIds.toList(),
    )

    @Test
    fun `a run registers, reports each test and shuts down on batch-complete`() = runTest {
        val link = FakeLink()
        val runner = FakeRunner(mutableListOf(StepResult.ok("fine").copy(assertedValue = "42")))
        val consumer = consumer(link, runner)
        runCurrent()
        assertEquals(mapOf("runId" to "run-1", "consumerId" to "c1", "platform" to "kotlin-android"), link.on("qvac/register").first() - "timestamp")

        link.deliver("qvac/register-ack/c1", ack("runs") + ("runId" to "other"))
        runCurrent()
        assertTrue(link.on("qvac/results").isEmpty())

        link.deliver("qvac/register-ack/c1", ack("runs", "skipped"))
        advanceTimeBy(1_000)
        runCurrent()
        // Skipped tests contribute no bootstrap dependencies.
        assertEquals(listOf("runs"), runner.bootstrapped?.map { it["testId"] })
        val results = link.on("qvac/results")
        assertEquals(listOf("success", "skipped"), results.map { it["outcome"] })
        assertEquals("42", results[0]["assertedValue"])
        assertEquals("not on phones", results[1]["error"])
        assertEquals(2, link.on("qvac/test-prepare").size)
        assertEquals(1, link.on("qvac/test-start").size)

        link.deliver("qvac/batch-complete", mapOf("runId" to "run-1", "totalTests" to 2L))
        runCurrent()
        assertEquals("final", link.on("qvac/profiling").single()["kind"])
        assertTrue(consumer.finished.isCompleted && runner.closed && link.closed)
    }

    @Test
    fun `a failed retry-on-failure test is reloaded and run again`() = runTest {
        val link = FakeLink()
        val runner = FakeRunner(mutableListOf(StepResult.fail("first"), StepResult.ok("second")))
        consumer(link, runner)
        runCurrent()
        link.deliver("qvac/register-ack/c1", ack("flaky"))
        advanceTimeBy(1_000)
        runCurrent()
        assertEquals(1, runner.reloads)
        assertEquals(1, link.on("qvac/test-reload").size)
        val result = link.on("qvac/results").single()
        // The first attempt is the verdict; the retry rides along, as the JS consumer reports it.
        assertEquals("failure", result["outcome"])
        assertEquals(true, result["retried"])
        assertEquals(true, result["retryPassed"])
    }

    @Test
    fun `batch-complete during a test finalizes once it ends, and starts nothing after it`() = runTest {
        val link = FakeLink()
        val gate = CompletableDeferred<Unit>()
        val runner = object : TestRunner by FakeRunner(mutableListOf()) {
            override suspend fun execute(definition: Map<String, Any?>): StepResult {
                gate.await()
                return StepResult.ok("fine")
            }
        }
        val consumer = consumer(link, runner)
        runCurrent()
        link.deliver("qvac/register-ack/c1", ack("runs", "runs"))
        runCurrent()
        link.deliver("qvac/batch-complete", mapOf("runId" to "run-1", "totalTests" to 2L))
        runCurrent()
        assertFalse(consumer.finished.isCompleted)

        gate.complete(Unit)
        advanceTimeBy(1_000)
        runCurrent()
        assertEquals(1, link.on("qvac/results").size)
        assertEquals("final", link.on("qvac/profiling").single()["kind"])
        assertTrue(consumer.finished.isCompleted && link.closed)
    }

    @Test
    fun `a runner that never closes still lets the consumer leave the broker`() = runTest {
        val link = FakeLink()
        val runner = object : TestRunner by FakeRunner(mutableListOf()) {
            override suspend fun close() = awaitCancellation()
        }
        val consumer = consumer(link, runner)
        runCurrent()
        link.deliver("qvac/register-ack/c1", ack())
        runCurrent()
        link.deliver("qvac/batch-complete", mapOf("runId" to "run-1", "totalTests" to 0L))
        advanceTimeBy(120_000)
        runCurrent()
        assertTrue(consumer.finished.isCompleted && link.closed)
    }

    @Test
    fun `a test without a local definition fails rather than vanishing`() = runTest {
        val link = FakeLink()
        consumer(link, FakeRunner(mutableListOf()))
        runCurrent()
        link.deliver("qvac/register-ack/c1", ack("unknown"))
        advanceTimeBy(1_000)
        runCurrent()
        val result = link.on("qvac/results").single()
        assertEquals("failure", result["outcome"])
        assertEquals("No local test definition for: unknown", result["error"])
    }
}
