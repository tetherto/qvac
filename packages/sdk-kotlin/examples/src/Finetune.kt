// Kotlin port of packages/sdk/examples/finetune/llamacpp-finetune.ts.
//
// LoRA fine-tuning on a chat dataset with a separate eval file, printing every
// progress tick. Pass `--pause-resume` to pause the run mid-training and resume
// it from the last checkpoint.
//
// `client.training.progress()` is a server stream: a `Flow` of
// `QvacProgressEvent`s, `Progress` for each `FinetuneProgressResponse` tick and
// `Result` for the terminal `FinetuneResponse`. A pause is a separate unary
// `client.training.execute()` call carrying a `FinetuneStopRequest` with
// `operation = PAUSE`, sent from a child coroutine while that stream is open.
//
// The request is the generated typed `FinetuneRunRequest`: the validation mode
// is a sealed arm (`Dataset`, `Split`, `None`), operations and the result
// `status` are enums, and resuming is a `copy(operation = RESUME)` of the same
// request. Set `withProgress = true` on the request to receive the ticks.
//
// The datasets are the `train.jsonl` and `eval.jsonl` in the examples
// directory, where `run` executes; pass another directory as an argument to use
// your own. The worker resolves dataset paths against its own working
// directory, so they are made absolute first. The adapter and its checkpoints
// are written under `./finetune-output`.
//
// RUN: ./gradlew run -Pexample=Finetune --args="[--pause-resume] [<dataset dir>]"

import io.tether.qvac.sdk.JvmBareRpcTransport
import io.tether.qvac.sdk.QvacClient
import io.tether.qvac.sdk.QvacProgressEvent
import io.tether.qvac.sdk.generated.Models
import io.tether.qvac.sdk.generated.schema.FinetuneProgressResponse
import io.tether.qvac.sdk.generated.schema.FinetuneProgressResponseAccuracy
import io.tether.qvac.sdk.generated.schema.FinetuneProgressResponseLoss
import io.tether.qvac.sdk.generated.schema.FinetuneRequest
import io.tether.qvac.sdk.generated.schema.FinetuneResponse
import io.tether.qvac.sdk.generated.schema.FinetuneResponseStatus
import io.tether.qvac.sdk.generated.schema.FinetuneRunRequest
import io.tether.qvac.sdk.generated.schema.FinetuneRunRequestOperation
import io.tether.qvac.sdk.generated.schema.FinetuneRunRequestOptions
import io.tether.qvac.sdk.generated.schema.FinetuneRunRequestOptionsValidation
import io.tether.qvac.sdk.generated.schema.FinetuneRunRequestOptionsValidationDataset
import io.tether.qvac.sdk.generated.schema.FinetuneStopRequest
import io.tether.qvac.sdk.generated.schema.FinetuneStopRequestOperation
import io.tether.qvac.sdk.models
import io.tether.qvac.sdk.training
import java.nio.file.Path
import kotlin.math.roundToLong
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

// Relative to the directory `./gradlew run` executes in (packages/sdk-kotlin/examples).
private const val DEFAULT_DATASET_DIR = "."
private const val RESULTS_DIR = "./finetune-output"

/** One progress tick, train or validation. */
private fun tickLine(tick: FinetuneProgressResponse): String {
    val phase = if (tick.is_train) "train" else "val"
    // loss and accuracy are absent on some ticks, so guard the formatting.
    val loss = (tick.loss as? FinetuneProgressResponseLoss.Variant1)?.let { "%.4f".format(it.value) } ?: "-"
    val accuracy = (tick.accuracy as? FinetuneProgressResponseAccuracy.Variant1)?.let { "%.4f".format(it.value) }
        ?: "-"
    return "▸ epoch=${tick.current_epoch + 1} step=${tick.global_steps}" +
        " batch=${tick.current_batch}/${tick.total_batches} $phase" +
        " loss=$loss acc=$accuracy eta=${(tick.eta_ms / 1000).roundToLong()}s"
}

/** Print each tick as it arrives; return the terminal result. */
private suspend fun QvacClient.readProgress(
    request: FinetuneRunRequest,
    onTick: (Long) -> Unit = {},
): FinetuneResponse? {
    var result: FinetuneResponse? = null
    training.progress(FinetuneRequest.FinetuneRunRequest(request)).collect { event ->
        when (event) {
            is QvacProgressEvent.Progress -> {
                println(tickLine(event.value))
                onTick(event.value.global_steps)
            }
            is QvacProgressEvent.Result -> result = event.value
        }
    }
    return result
}

fun main(args: Array<String>): Unit = runBlocking {
    val pauseResumeEnabled = "--pause-resume" in args
    val datasetDir = Path.of(args.firstOrNull { !it.startsWith("--") } ?: DEFAULT_DATASET_DIR)
        .toAbsolutePath()
        .normalize()

    val client = QvacClient(JvmBareRpcTransport.connectResolved(installWorkerIfMissing = true))
    var modelId: String? = null
    try {
        val model = Models.QWEN3_600M_INST_Q4
        val loaded = client.models.load(
            source = model.src,
            modelType = model.engine,
            modelName = model.name,
            modelConfig = buildJsonObject {
                put("device", "gpu")
                put("ctx_size", 512)
            },
        )
        val id = loaded.modelId ?: error(loaded.error ?: "loadModel failed")
        modelId = id
        println("▸ Model loaded with ID: $id")

        val finetuneRequest = FinetuneRunRequest(
            modelId = id,
            withProgress = true,
            options = FinetuneRunRequestOptions(
                trainDatasetDir = datasetDir.resolve("train.jsonl").toString(),
                validation = FinetuneRunRequestOptionsValidation.Dataset(
                    FinetuneRunRequestOptionsValidationDataset(path = datasetDir.resolve("eval.jsonl").toString()),
                ),
                numberOfEpochs = 2,
                learningRate = 1e-4,
                lrMin = 1e-8,
                loraModules = "attn_q,attn_k,attn_v,attn_o,ffn_gate,ffn_up,ffn_down",
                assistantLossOnly = true,
                checkpointSaveSteps = 2,
                checkpointSaveDir = "$RESULTS_DIR/checkpoints",
                outputParametersDir = RESULTS_DIR,
            ),
        )

        var pauseCall: Deferred<FinetuneResponse>? = null

        val initialResult = client.readProgress(finetuneRequest) { globalSteps ->
            if (pauseResumeEnabled && pauseCall == null && globalSteps >= 10) {
                println("▸ Requesting a pause so the run can be resumed...")
                // A child coroutine: the progress stream is still being
                // collected, and the pause reply arrives on its own call.
                pauseCall = async {
                    client.training.execute(
                        FinetuneRequest.FinetuneStopRequest(
                            FinetuneStopRequest(modelId = id, operation = FinetuneStopRequestOperation.PAUSE),
                        ),
                    )
                }
            }
        }

        pauseCall?.await()

        println("▸ Initial finetune result: $initialResult")

        if (pauseResumeEnabled && initialResult?.status == FinetuneResponseStatus.PAUSED) {
            println("▸ Resuming from the saved checkpoint...")
            val resumedResult = client.readProgress(
                finetuneRequest.copy(operation = FinetuneRunRequestOperation.RESUME),
            )
            println("▸ Resumed finetune result: $resumedResult")
        }
    } finally {
        modelId?.let { client.models.unload(it) }
        client.close()
    }
}
