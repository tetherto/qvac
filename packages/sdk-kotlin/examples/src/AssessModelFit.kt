// Kotlin port of packages/sdk/examples/assess-model-fit.ts.
//
// Which models fit this machine, asked before downloading any weights. Each
// engine's fitter reads the registry's weightless description of a model, so
// nothing is fetched beyond tens of KB, loaded or reserved.
//
// Each model gets its own status and the memory it takes on each device, and
// the set gets one verdict for all of them loaded together, with what it takes
// from each memory pool. `unknown` is a valid answer: show it as "can't say",
// never as "no".
//
// The request and response are the generated typed models: each candidate
// carries the model's full descriptor (as the JS and Python SDKs send a model
// constant), and the status is an enum, so the mark lookup below is an
// exhaustive `when` checked at compile time.
//
// RUN: ./gradlew -p examples run -Pexample=AssessModelFit

import io.tether.qvac.sdk.QvacClient
import io.tether.qvac.sdk.generated.ModelConstant
import io.tether.qvac.sdk.generated.Models
import io.tether.qvac.sdk.generated.schema.AssessModelFitRequest
import io.tether.qvac.sdk.generated.schema.AssessModelFitRequestModelsItem
import io.tether.qvac.sdk.generated.schema.AssessModelFitRequestModelsItemModelSrc
import io.tether.qvac.sdk.generated.schema.AssessModelFitRequestModelsItemModelSrc1E6973DC
import io.tether.qvac.sdk.generated.schema.AssessModelFitRequestModelsItemModelType
import io.tether.qvac.sdk.generated.schema.ModelFitModelResultStatus
import io.tether.qvac.sdk.jvm.JvmBareKitTransport
import io.tether.qvac.sdk.models
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.jsonPrimitive

// The fitter sizes the load as `loadModel` would run it, context included.
private const val CONTEXT_TOKENS = 8192

// A ladder ending well past what a laptop has, so one screen shows every verdict.
private val CANDIDATES = listOf(
    Models.QWEN3_600M_INST_Q4,
    Models.QWEN3_1_7B_INST_Q4,
    Models.QWEN3_4B_INST_Q4_K_M,
    Models.QWEN3_8B_INST_Q4_K_M,
    Models.QWEN3_8_27B_MULTIMODAL_UD_Q8_K_XL,
)

fun main(): Unit = runBlocking {
    val client = QvacClient(JvmBareKitTransport.connect())
    try {
        val result = client.models.assessFit(
            AssessModelFitRequest(
                models = CANDIDATES.map { model ->
                    AssessModelFitRequestModelsItem(
                        modelSrc = model.toFitSource(),
                        modelType = AssessModelFitRequestModelsItemModelType.LLAMACPPCOMPLETION,
                        modelConfig = mapOf("ctx_size" to JsonPrimitive(CONTEXT_TOKENS)),
                    )
                },
            ),
        )

        println("▸ At $CONTEXT_TOKENS tokens of context, each model alone")
        CANDIDATES.zip(result.models).forEach { (candidate, model) ->
            val mark = when (model.status) {
                ModelFitModelResultStatus.FITS -> "✔"
                ModelFitModelResultStatus.DOESNOTFIT -> "✖"
                ModelFitModelResultStatus.UNKNOWN -> "?"
            }
            val size = gib(candidate.expectedSize.toDouble()).padStart(9)
            println("  $mark ${candidate.name.padEnd(46)} $size on disk")
            model.devices.forEach { device ->
                println("      ${device.name.padEnd(10)} ${gib(device.usedBytes).padStart(10)}")
            }
        }

        println("\n▸ All five loaded together: ${wireName(result.verdict)}")
        result.pools.forEach { pool ->
            val free = pool.freeBytes?.let { "of ${gib(it)} free" } ?: "no free figure"
            println("  ${pool.id.padEnd(14)} ${gib(pool.usedBytes).padStart(10)} $free")
        }
    } finally {
        client.close()
    }
}

/** The model's full descriptor, as the JS and Python SDKs send a model constant. */
private fun ModelConstant.toFitSource() = AssessModelFitRequestModelsItemModelSrc.Value1E6973DC(
    AssessModelFitRequestModelsItemModelSrc1E6973DC(
        src = src,
        name = name,
        modelId = modelId,
        registryPath = registryPath,
        registrySource = registrySource,
        blobCoreKey = blobCoreKey,
        engine = engine,
        expectedSize = expectedSize.toDouble(),
        sha256Checksum = sha256Checksum,
    ),
)

private fun gib(bytes: Double) = "%.2f GiB".format(bytes / (1L shl 30))

/** The value as it appears on the wire, e.g. `does-not-fit` rather than `DOESNOTFIT`. */
private inline fun <reified T> wireName(value: T): String = Json.encodeToJsonElement(value).jsonPrimitive.content
