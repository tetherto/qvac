// Kotlin port of packages/sdk/examples/decisions.ts.
//
// Loads the default registry decision checkpoint, or a local GGUF path passed
// as the first argument, and answers choice, urgency-score, and
// refund-probability questions about a support ticket.
//
// Kotlin calls the generated typed `decide` operation, so the request is built
// from the generated `DecideRequest` classes: each question is an arm of the
// sealed `DecideSingleRequestQuestionsValue` (`Choice`, `Score`, `Noul`), and a
// field that accepts several JSON types is a sealed union whose arms are named
// `Variant1`, `Variant2`, ... (`Variant1` is the string arm here). A question
// with a missing field or a wrong type is a compile error. The result is
// serialized back with its wire names, like the JS output.
//
// RUN: ./gradlew run -Pexample=Decisions --args="[path-to-decision.gguf]"

import io.tether.qvac.sdk.JvmBareRpcTransport
import io.tether.qvac.sdk.QvacClient
import io.tether.qvac.sdk.decide
import io.tether.qvac.sdk.generated.Models
import io.tether.qvac.sdk.generated.schema.DecideRequest
import io.tether.qvac.sdk.generated.schema.DecideSingleRequest
import io.tether.qvac.sdk.generated.schema.DecideSingleRequestQuestionsValue
import io.tether.qvac.sdk.generated.schema.DecideSingleRequestQuestionsValueChoice
import io.tether.qvac.sdk.generated.schema.DecideSingleRequestQuestionsValueChoiceCriteria
import io.tether.qvac.sdk.generated.schema.DecideSingleRequestQuestionsValueChoiceCriteriaVariant1Item
import io.tether.qvac.sdk.generated.schema.DecideSingleRequestQuestionsValueChoiceInstructions
import io.tether.qvac.sdk.generated.schema.DecideSingleRequestQuestionsValueNoul
import io.tether.qvac.sdk.generated.schema.DecideSingleRequestQuestionsValueNoulInstructions
import io.tether.qvac.sdk.generated.schema.DecideSingleRequestQuestionsValueScore
import io.tether.qvac.sdk.generated.schema.DecideSingleRequestQuestionsValueScoreCriteriaItem
import io.tether.qvac.sdk.generated.schema.DecideSingleRequestQuestionsValueScoreInstructions
import io.tether.qvac.sdk.generated.schema.DecideSingleRequestState
import io.tether.qvac.sdk.models
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

private val PRETTY = Json {
    prettyPrint = true
    explicitNulls = false
}

fun main(args: Array<String>): Unit = runBlocking {
    val modelSrc = args.getOrNull(0) ?: Models.LAYA_MULTILINGUAL_322M_Q8_0.src

    val client = QvacClient(JvmBareRpcTransport.connectResolved(installWorkerIfMissing = true))
    var modelId: String? = null
    try {
        System.err.println("▸ Loading decision model")
        val loaded = client.models.load(
            source = modelSrc,
            modelType = "llamacpp-decision",
            modelConfig = buildJsonObject { put("device", "cpu") },
        )
        modelId = loaded.modelId ?: error(loaded.error ?: "loadModel failed")

        val request = DecideRequest.DecideSingleRequest(
            DecideSingleRequest(
                modelId = modelId,
                state = DecideSingleRequestState.Variant1(
                    "My payment failed twice and I was charged both times. Please refund the duplicate.",
                ),
                questions = mapOf(
                    "department" to DecideSingleRequestQuestionsValue.Choice(
                        DecideSingleRequestQuestionsValueChoice(
                            instructions = DecideSingleRequestQuestionsValueChoiceInstructions.Variant1(
                                "Which team should handle this ticket?",
                            ),
                            criteria = DecideSingleRequestQuestionsValueChoiceCriteria.Variant1(
                                listOf("billing", "technical")
                                    .map(DecideSingleRequestQuestionsValueChoiceCriteriaVariant1Item::Variant1),
                            ),
                        ),
                    ),
                    "urgency" to DecideSingleRequestQuestionsValue.Score(
                        DecideSingleRequestQuestionsValueScore(
                            instructions = DecideSingleRequestQuestionsValueScoreInstructions.Variant1(
                                "How urgent is this?",
                            ),
                            criteria = listOf("not urgent", "somewhat urgent", "very urgent")
                                .map(DecideSingleRequestQuestionsValueScoreCriteriaItem::Variant1),
                        ),
                    ),
                    "refund" to DecideSingleRequestQuestionsValue.Noul(
                        DecideSingleRequestQuestionsValueNoul(
                            instructions = DecideSingleRequestQuestionsValueNoulInstructions.Variant1(
                                "The customer asks for a refund.",
                            ),
                        ),
                    ),
                ),
            ),
        )
        val response = client.decide(request)
        println(PRETTY.encodeToString(response.result))
    } finally {
        modelId?.let { client.models.unload(it) }
        client.close()
    }
}
