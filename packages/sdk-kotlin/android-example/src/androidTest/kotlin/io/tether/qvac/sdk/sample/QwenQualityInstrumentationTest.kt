package io.tether.qvac.sdk.sample

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.filters.LargeTest
import androidx.test.platform.app.InstrumentationRegistry
import io.tether.qvac.sdk.*
import io.tether.qvac.sdk.barekit.AndroidServiceTransport
import io.tether.qvac.sdk.generated.Models
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.flow.onEach
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/** Opt-in diagnostic matrix; never turns a wrong model answer into a passing assertion. */
@RunWith(AndroidJUnit4::class)
class QwenQualityInstrumentationTest {
    @Test @LargeTest
    fun compareConfigurationAndWireOutput() = runBlocking {
        val arguments = InstrumentationRegistry.getArguments()
        assumeTrue(arguments.getString("qvacQuality") == "true")
        val devices = arguments.getString("qvacQualityDevices", "cpu,gpu").split(',')
        require(devices.isNotEmpty() && devices.all { it == "cpu" || it == "gpu" })
        withTimeout(20 * 60_000L) {
            val context = InstrumentationRegistry.getInstrumentation().targetContext
            val transport = AndroidServiceTransport.connect(context)
            val frames = mutableListOf<JsonObject>()
            var request: JsonObject? = null
            val client = QvacClient(object : QvacTransport by transport {
                override fun stream(payload: JsonObject) = transport.stream(payload).onEach {
                    request = payload
                    frames.add(it)
                }
            })
            val wrong = mutableListOf<String>()
            try {
                for (device in devices) {
                    val loaded = client.models.load(Models.QWEN3_600M_INST_Q4.src,
                        Models.QWEN3_600M_INST_Q4.engine, modelConfig = buildJsonObject {
                            put("ctx_size", 2048)
                            put("device", device)
                            put("gpu_layers", if (device == "gpu") 99 else 0)
                            put("reasoning_budget", 0)
                        })
                    assertTrue(loaded.error, loaded.success)
                    val id = requireNotNull(loaded.modelId)
                    try {
                        for (budget in listOf(0L, 32L, -1L)) for (temperature in listOf(0.0, 0.7)) {
                            frames.clear()
                            val label = "$device/budget=$budget/temp=$temperature"
                            println("QVAC_QUALITY_START $label")
                            val run = client.completion.run(id,
                                    listOf(QvacMessage.user("What is 2+2? Answer with only the number.")),
                                    options = QvacCompletionOptions(captureThinking = true, emitRawDeltas = true,
                                        generation = QvacGenerationOptions(temperature = temperature,
                                            topP = 0.8, topK = 20.0, seed = 42,
                                            predict = if (budget < 0) 512 else 128, reasoningBudget = budget)))
                            val result = try {
                                withTimeout(180_000) { run.final.await() }
                            } catch (error: TimeoutCancellationException) {
                                // The cancel acknowledgement precedes the terminal stream frame.
                                // Drain that final result before reusing the diagnostic buffer.
                                withTimeout(15_000) {
                                    run.cancel()
                                    try { run.final.await() }
                                    catch (_: QvacCompletionCancelledException) { }
                                }
                                val partialEvents = frames.flatMap { it["events"]?.jsonArray.orEmpty() }
                                    .map { it.jsonObject }
                                println("QVAC_QUALITY_TIMEOUT " + buildJsonObject {
                                    put("case", label)
                                    put("eventCount", partialEvents.size)
                                    put("raw", partialEvents.filter {
                                        it["type"]?.jsonPrimitive?.content == "rawDelta"
                                    }.joinToString("") { it["text"]?.jsonPrimitive?.content.orEmpty() })
                                })
                                wrong.add("$label (timed out)")
                                client.heartbeat()
                                continue
                            }
                            val wireText = frames.flatMap { it["events"]?.jsonArray.orEmpty() }
                                .map { it.jsonObject }.filter { it["type"]?.jsonPrimitive?.content == "contentDelta" }
                                .joinToString("") { it.getValue("text").jsonPrimitive.content }
                            println("QVAC_QUALITY " + buildJsonObject {
                                put("case", label); put("text", result.text); put("wireText", wireText)
                                put("raw", result.rawFullText); put("thinking", result.thinking)
                                put("stopReason", result.stopReason); put("backend", result.stats?.backendDevice)
                                put("request", request ?: JsonNull); put("correct", result.text.trim() == "4")
                            })
                            assertEquals("Kotlin decoding diverged from worker bytes: $label", wireText, result.text)
                            assertEquals(device, result.stats?.backendDevice)
                            if (result.text.trim() != "4") wrong.add(label)
                        }
                    } finally { withTimeout(15_000) { assertTrue(client.models.unload(id).success) } }
                }
            } finally { client.close() }
            assertTrue("Incorrect arithmetic configurations: $wrong", wrong.isEmpty())
        }
    }
}
