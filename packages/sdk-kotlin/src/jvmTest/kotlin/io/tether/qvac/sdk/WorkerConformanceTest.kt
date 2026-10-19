package io.tether.qvac.sdk

import io.tether.qvac.sdk.generated.Models
import java.nio.file.Files
import java.nio.file.Path
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.serialization.json.*
import org.junit.Assume.assumeTrue
import kotlin.math.sqrt
import kotlin.test.*

/** Opt-in, real inference using the exact JS/Python corpus. Unknown categories fail. */
class WorkerConformanceTest {
    @Test fun sharedCorpus(): Unit = runBlocking {
        assumeTrue("Enable with QVAC_RUN_CONFORMANCE=1 and build the workspace worker", System.getenv("QVAC_RUN_CONFORMANCE") == "1")
        val sdk = Path.of(System.getenv("QVAC_TEST_SDK_DIR") ?: "../sdk").toAbsolutePath().normalize()
        val cases = Json.parseToJsonElement(Files.readString(sdk.resolve("e2e/conformance/cases.json"))).jsonObject.getValue("cases").jsonArray
        assertTrue(cases.isNotEmpty())
        val home = Path.of(System.getenv("QVAC_E2E_HOME") ?: "build/e2e-home").toAbsolutePath()
        Files.createDirectories(home)
        for (entry in cases) {
            val case = entry.jsonObject
            val id = case.string("id")
            println("Conformance: $id")
            withTimeout(600_000) {
                val transport = JvmBareRpcTransport.connectResolved(sdkDirectory = sdk.toString(), homeDirectory = home.toString())
                val client = QvacClient(transport)
                try {
                    client.heartbeat()
                    val model = Models.all.single { it.name == case.string("model") }
                    val loaded = client.models.load(source = model.src, modelType = case.string("modelType"), modelConfig = case["modelConfig"] as? JsonObject)
                    assertTrue(loaded.success, "$id: ${loaded.error}")
                    val modelId = assertNotNull(loaded.modelId, id)
                    try { execute(client, modelId, case) }
                    finally { assertTrue(client.models.unload(modelId).success, "$id: unload failed") }
                } finally { client.close() }
                assertFalse(transport.isWorkerAlive, "$id: worker leaked")
            }
        }
    }

    private suspend fun execute(client: QvacClient, modelId: String, case: JsonObject) {
        val params = case.getValue("params").jsonObject
        val history = params["history"]?.jsonArray.orEmpty().map { QvacMessage(it.jsonObject.string("role"), it.jsonObject.string("content")) }
        val gen = params["generationParams"] as? JsonObject
        val options = QvacCompletionOptions(generation = QvacGenerationOptions(
            temperature = gen?.get("temp")?.jsonPrimitive?.double,
            seed = gen?.get("seed")?.jsonPrimitive?.long,
            predict = gen?.get("predict")?.jsonPrimitive?.long ?: -1,
            reasoningBudget = gen?.get("reasoning_budget")?.jsonPrimitive?.long,
        ))
        when (case.string("category")) {
            "completion" -> expectText(case, client.completion.run(modelId, history, options = options).text())
            "translate" -> expectText(case, client.translation.run(modelId, params.string("text"), case.string("modelType"), to = params.string("to"), stream = false).text())
            "embed" -> {
                val related = params.getValue("related").jsonArray
                val a = client.embeddings.embed(modelId, related[0].jsonPrimitive.content)
                val b = client.embeddings.embed(modelId, related[1].jsonPrimitive.content)
                val c = client.embeddings.embed(modelId, params.string("unrelated"))
                assertTrue(cosine(a, b) > cosine(a, c), case.string("id"))
            }
            "modelLifecycle" -> Unit // load/unload and worker exit are asserted by the caller
            "cancel" -> {
                val run = client.completion.run(modelId, history, options = options)
                run.tokens.first()
                assertTrue(run.cancel(), "worker did not acknowledge cancellation")
                val error = assertFailsWith<QvacCompletionCancelledException> { run.final.await() }
                assertEquals("cancelled", error.partial.stopReason)
            }
            "completionOrchestrate" -> {
                val tool = params.getValue("tool").jsonObject
                val calls = java.util.concurrent.atomic.AtomicInteger()
                val handler = QvacTool(tool.string("name"), tool.string("description"), handler = {
                    calls.incrementAndGet()
                    JsonPrimitive(tool.string("result"))
                })
                val result = client.completion.orchestrate(
                    modelId, history, listOf(handler), options = options.copy(captureThinking = true),
                ).final.await()
                println("${case.string("id")}: calls=${calls.get()}, stopReason=${result.stopReason}, tokens=${result.stats?.generatedTokens}")
                assertNotEquals("length", result.stopReason, "${case.string("id")}: exhausted generation budget")
                assertTrue(calls.get() > 0, "${case.string("id")}: tool handler was never invoked")
                assertTrue(result.text.isNotBlank(), "${case.string("id")}: empty answer; raw=${result.rawFullText}; thinking=${result.thinking}")
                expectText(case, result.text)
            }
            "tts" -> assertTrue(client.speech.synthesize(modelId, params.string("text")).samples.isNotEmpty())
            else -> fail("Unimplemented conformance category: ${case.string("category")}")
        }
    }

    private fun expectText(case: JsonObject, text: String) {
        val expected = case.getValue("expect").jsonObject
        when (expected.string("kind")) {
            "contains" -> assertTrue(expected.string("value") in text, "${case.string("id")}: $text")
            "nonempty" -> assertTrue(text.isNotBlank(), case.string("id"))
            else -> fail("Unknown text assertion: $expected")
        }
    }
    private fun cosine(a: List<Double>, b: List<Double>): Double {
        assertEquals(a.size, b.size)
        assertTrue(a.isNotEmpty())
        return a.zip(b).sumOf { (x, y) -> x * y } / sqrt(a.sumOf { it * it } * b.sumOf { it * it })
    }
    private fun JsonObject.string(key: String) = getValue(key).jsonPrimitive.content
}
