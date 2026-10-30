// Kotlin port of packages/sdk/examples/advisory-model-fit.ts.
//
// `modelFitPolicy` decides what the engine fitter's verdict does to a load:
// `LOG` (the default) reports it and loads anyway, `REFUSE` rejects a load the
// fitter projects will not fit, `OFF` skips the check.
//
// The load uses the generated typed llama.cpp request, so the policy and the
// KV cache types are typed fields rather than JSON keys. The verdict log
// listener is a child coroutine: cancelling it in `finally` unsubscribes the
// log stream. A refusal arrives as the typed
// `QvacKnownException.ServerModelFitRefused`, caught here because it is the
// outcome this example demonstrates.
//
// RUN: ./gradlew run -Pexample=AdvisoryModelFit

import io.tether.qvac.sdk.JvmBareRpcTransport
import io.tether.qvac.sdk.QvacClient
import io.tether.qvac.sdk.generated.Models
import io.tether.qvac.sdk.generated.QvacKnownException
import io.tether.qvac.sdk.generated.schema.LoadModelRequest
import io.tether.qvac.sdk.generated.schema.LoadModelSrcRequest
import io.tether.qvac.sdk.generated.schema.LoadModelSrcRequestLlamacppCompletion
import io.tether.qvac.sdk.generated.schema.LoadModelSrcRequestLlamacppCompletionModelConfig
import io.tether.qvac.sdk.generated.schema.LoadModelSrcRequestLlamacppCompletionModelFitPolicy
import io.tether.qvac.sdk.models
import io.tether.qvac.sdk.serverLogs
import kotlin.system.exitProcess
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking

// The worker's SDK log namespace (`SDK_LOG_ID` in the JS and Python SDKs).
private const val SDK_LOG_ID = "__sdk__"

fun main(): Unit = runBlocking {
    val client = QvacClient(JvmBareRpcTransport.connectResolved(installWorkerIfMissing = true))
    // Verdicts go to the SDK server log stream, not stdout.
    val verdicts = launch {
        client.serverLogs(SDK_LOG_ID)
            .catch { }
            .collect { log -> if ("[advisory-fit:" in log.message) println("▸ ${log.message}") }
    }
    val loaded = try {
        // gpt-oss-20B fits here at the default KV cache type and does not at f32.
        val model = Models.GPT_OSS_20B_INST_Q4_K_M
        val response = client.models.load(
            LoadModelRequest.LoadModelSrcRequest(
                LoadModelSrcRequest.LlamacppCompletion(
                    LoadModelSrcRequestLlamacppCompletion(
                        modelSrc = model.src,
                        modelName = model.name,
                        modelConfig = LoadModelSrcRequestLlamacppCompletionModelConfig(
                            ctx_size = 131072.0,
                            cachetypek = "f32",
                            cachetypev = "f32",
                        ),
                        modelFitPolicy = LoadModelSrcRequestLlamacppCompletionModelFitPolicy.REFUSE,
                    ),
                ),
            ),
        )
        response.modelId ?: error(response.error ?: "loadModel failed")
        println("▸ Loaded — the fitter projected this one to fit here")
        true
    } catch (refused: QvacKnownException.ServerModelFitRefused) {
        System.err.println("✖ ${refused.message}")
        false
    } finally {
        verdicts.cancelAndJoin()
        client.close()
    }
    if (!loaded) exitProcess(1)
}
