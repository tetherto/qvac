// Kotlin port of packages/sdk/examples/registry-query.ts.
//
// Query the QVAC model registry: list, filter, search by engine / quantization
// / addon, and fetch one model's full record. These are request-reply calls on
// `client.registry`; no model needs to be loaded, but a running worker is
// required.
//
// Searches take the generated `ModelRegistrySearchRequest`, whose fields are
// named and optional. Each reply carries `success`, `models` (or `model`) and
// `error`, so `listed()` below unwraps it. Registry `addon` and `engine` are
// generated enums; `wireName()` renders the wire string, matching the JS SDK's
// plain-string fields.
//
// RUN: ./gradlew run -Pexample=RegistryQuery

import io.tether.qvac.sdk.JvmBareRpcTransport
import io.tether.qvac.sdk.QvacClient
import io.tether.qvac.sdk.generated.schema.ModelRegistryListResponseModelsItem
import io.tether.qvac.sdk.generated.schema.ModelRegistrySearchRequest
import io.tether.qvac.sdk.registry
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.jsonPrimitive

/** The wire string of a generated enum, e.g. `llamacpp-embedding`. */
private inline fun <reified T> T.wireName(): String = Json.encodeToJsonElement(this).jsonPrimitive.content

private fun formatSize(n: Double): String = when {
    n < 1024 -> "${n.toLong()}B"
    n < 1024.0 * 1024 -> "%.1fKB".format(n / 1024)
    n < 1024.0 * 1024 * 1024 -> "%.1fMB".format(n / (1024.0 * 1024))
    else -> "%.1fGB".format(n / (1024.0 * 1024 * 1024))
}

private fun listed(success: Boolean, models: List<ModelRegistryListResponseModelsItem>?, error: String?) =
    if (success) models.orEmpty() else error(error ?: "registry query failed")

fun main(): Unit = runBlocking {
    val client = QvacClient(JvmBareRpcTransport.connectResolved(installWorkerIfMissing = true))
    try {
        println("▸ QVAC Model Registry Query Examples\n")

        println("▸ Listing all models in QVAC model registry...")
        val allModels = client.registry.list().let { listed(it.success, it.models, it.error) }
        println("▸ Found ${allModels.size} models in registry\n")

        println("▸ Sample models:")
        for (m in allModels.take(5)) {
            println("   - ${m.name} (${m.addon.wireName()}, ${m.engine.wireName()}, ${formatSize(m.expectedSize)})")
        }
        println()

        println("▸ Searching for \"whisper\" models...")
        val whisper = client.registry.search(ModelRegistrySearchRequest(filter = "whisper"))
            .let { listed(it.success, it.models, it.error) }
        println("▸ Found ${whisper.size} whisper-related models\n")

        println("▸ Searching by engine (llamacpp-embedding)...")
        val embedModels = client.registry.search(ModelRegistrySearchRequest(engine = "llamacpp-embedding"))
            .let { listed(it.success, it.models, it.error) }
        println("▸ Found ${embedModels.size} embedding models")
        for (m in embedModels.take(3)) println("   - ${m.name} (${m.quantization})")
        println()

        println("▸ Searching for Q4 quantized models...")
        val q4 = client.registry.search(ModelRegistrySearchRequest(quantization = "q4"))
            .let { listed(it.success, it.models, it.error) }
        println("▸ Found ${q4.size} Q4 quantized models")
        for (m in q4.take(3)) println("   - ${m.name}")
        println()

        allModels.firstOrNull()?.let { sample ->
            println("▸ Getting specific model: ${sample.registrySource}/${sample.registryPath}")
            val response = client.registry.get(sample.registrySource, sample.registryPath)
            val model = response.model ?: error(response.error ?: "model not found")
            println("   Model details:")
            println("   - Name: ${model.name}")
            println("   - Addon: ${model.addon.wireName()}")
            println("   - Engine: ${model.engine.wireName()}")
            println("   - Quantization: ${model.quantization}")
            println("   - Expected size: ${formatSize(model.expectedSize)}")
            println()
        }

        println("▸ QVAC model registry query examples completed successfully!")
    } finally {
        client.close()
    }
}
