// Kotlin port of packages/sdk/examples/assess-model-fit.ts.
//
// Which models is this machine likely to run — asked before downloading any
// weights. Nothing is fetched, loaded or reserved.
//
// The header prints the evidence the answer rests on: `system-memory` on a
// CPU-only or integrated-GPU host, `device-memory` on a discrete card,
// `device-budget` for the per-process allowance Windows grants on one. Which
// of those applies depends on where the engine would put the model.
//
// `unknown` is a real answer, not an error: the evidence does not support a
// call either way. Show it as "can't say", never as "no".
//
// The request and response are the generated typed models: each candidate
// carries the model's full descriptor (as the JS and Python SDKs send a model
// constant), and the verdicts are enums, so the mark lookup below is an
// exhaustive `when` checked at compile time.
//
// RUN: ./gradlew run -Pexample=AssessModelFit

import io.tether.qvac.sdk.JvmBareRpcTransport
import io.tether.qvac.sdk.QvacClient
import io.tether.qvac.sdk.generated.ModelConstant
import io.tether.qvac.sdk.generated.Models
import io.tether.qvac.sdk.generated.schema.AssessModelFitRequest
import io.tether.qvac.sdk.generated.schema.AssessModelFitRequestExecution
import io.tether.qvac.sdk.generated.schema.AssessModelFitRequestModelsItem
import io.tether.qvac.sdk.generated.schema.AssessModelFitRequestModelsItemModelSrc
import io.tether.qvac.sdk.generated.schema.AssessModelFitRequestModelsItemModelSrc1E6973DC
import io.tether.qvac.sdk.generated.schema.AssessModelFitRequestModelsItemModelType
import io.tether.qvac.sdk.generated.schema.AssessModelFitResponseModelsItemEvidence
import io.tether.qvac.sdk.generated.schema.AssessModelFitResponseModelsItemVerdict
import io.tether.qvac.sdk.models
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.jsonPrimitive

// Sizes the assessment the way it sizes the load: the estimator reads the
// context out of the config `loadModel` would be given.
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
    val client = QvacClient(JvmBareRpcTransport.connectResolved(installWorkerIfMissing = true))
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
                // Declared for aggregation only, not a scheduling instruction:
                // SEQUENTIAL counts the largest operation peak, CONCURRENT
                // counts one per model.
                execution = AssessModelFitRequestExecution.SEQUENTIAL,
                policy = "interactive-v1",
            ),
        )

        println("▸ Budget basis: ${wireName(result.basis)}")
        result.budget?.let { budget ->
            println(
                "    ${gib(budget.availableAfterReserveBytes)} budget" +
                    " (${gib(budget.totalBytes)} total," +
                    " ${gib(budget.usedBytes)} in use," +
                    " ${gib(budget.availableBytes)} free," +
                    " ${gib(budget.reservedBytes)} held back)",
            )
        }

        // Says which device the verdicts assume, when the model would run on a GPU.
        result.assumptions.firstOrNull { "assumed to execute on" in it }?.let { println("▸ $it") }

        println("\n▸ At $CONTEXT_TOKENS tokens of context")
        result.models.forEachIndexed { index, model ->
            val mark = when (model.verdict) {
                AssessModelFitResponseModelsItemVerdict.LIKELYFITS -> "✔"
                AssessModelFitResponseModelsItemVerdict.LIKELYTOOLARGE -> "✖"
                AssessModelFitResponseModelsItemVerdict.UNKNOWN -> "?"
            }
            val size = gib(CANDIDATES[index].expectedSize.toDouble()).padStart(9)
            val floor = model.floorBytes
            val needs = if (model.evidence == AssessModelFitResponseModelsItemEvidence.COMPUTEDONLY && floor != null) {
                "at least ${gib(floor)}"
            } else {
                ""
            }
            println("  $mark ${model.name.padEnd(46)} $size on disk  $needs")
            // Present on every `unknown`, and worth surfacing: it names what is missing.
            if (model.verdict == AssessModelFitResponseModelsItemVerdict.UNKNOWN) {
                model.reasons.forEach { println("      $it") }
            }
        }

        println("\n▸ All five together, sequentially: ${wireName(result.verdict)}")
        println("▸ Advisory only — this does not gate loadModel or reserve anything.")
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

/** The value as it appears on the wire, e.g. `likely-fits` rather than `LIKELYFITS`. */
private inline fun <reified T> wireName(value: T): String = Json.encodeToJsonElement(value).jsonPrimitive.content
