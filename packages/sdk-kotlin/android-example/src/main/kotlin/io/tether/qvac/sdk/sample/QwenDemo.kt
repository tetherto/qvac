package io.tether.qvac.sdk.sample

import io.tether.qvac.sdk.QvacClient
import io.tether.qvac.sdk.QvacProgressEvent
import io.tether.qvac.sdk.completion
import io.tether.qvac.sdk.models
import io.tether.qvac.sdk.generated.schema.CompletionStreamRequest
import io.tether.qvac.sdk.generated.schema.CompletionStreamRequestGenerationParams
import io.tether.qvac.sdk.generated.schema.CompletionStreamRequestHistoryItem
import io.tether.qvac.sdk.generated.schema.CompletionStreamResponseEventsItem
import io.tether.qvac.sdk.generated.schema.ModelProgressResponse
import kotlinx.coroutines.flow.collect
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlin.math.roundToInt

object QwenModel {
    const val NAME = "QWEN3_600M_INST_Q4"
    const val SOURCE =
        "registry://hf/unsloth/Qwen3-0.6B-GGUF/blob/50968a4468ef4233ed78cd7c3de230dd1d61a56b/Qwen3-0.6B-Q4_0.gguf"
    const val EXPECTED_SIZE_BYTES = 382_156_480L
}

data class ModelProgress(
    val downloaded: Long,
    val total: Long,
    val percentage: Int,
)

data class CompletionResult(
    val text: String,
    val tokensPerSecond: Double?,
    val stopReason: String?,
)

class QvacDemoException(
    message: String,
) : Exception(message)

class QwenDemo(
    private val client: QvacClient,
) {
    suspend fun downloadModel(onProgress: (ModelProgress) -> Unit) {
        var completed = false
        client.models.downloadWithProgress(
            source = QwenModel.SOURCE,
            seed = false,
        ).collect { event ->
            when (event) {
                is QvacProgressEvent.Progress -> onProgress(event.value.toModelProgress())
                is QvacProgressEvent.Result -> {
                    if (!event.value.success) {
                        throw QvacDemoException(event.value.error ?: "Model download failed")
                    }
                    completed = true
                }
            }
        }
        if (!completed) throw QvacDemoException("Model download stream ended without completion")
    }

    suspend fun loadModel(onProgress: (ModelProgress) -> Unit): String {
        var modelId: String? = null
        client.models.loadWithProgress(
            source = QwenModel.SOURCE,
            modelType = "llamacpp-completion",
            modelName = QwenModel.NAME,
            modelConfig = buildJsonObject {
                put("ctx_size", 2048)
                put("device", "gpu")
                put("gpu_layers", 99)
                put("reasoning_budget", -1)
            },
        ).collect { event ->
            when (event) {
                is QvacProgressEvent.Progress -> onProgress(event.value.toModelProgress())
                is QvacProgressEvent.Result -> {
                    if (!event.value.success) {
                        throw QvacDemoException(event.value.error ?: "Model load failed")
                    }
                    modelId = event.value.modelId
                        ?: throw QvacDemoException("Model load response has no modelId")
                }
            }
        }
        return modelId ?: throw QvacDemoException("Model load stream ended without completion")
    }

    suspend fun complete(
        modelId: String,
        prompt: String,
        onContent: (String) -> Unit,
    ): CompletionResult {
        require(prompt.isNotBlank()) { "Prompt must not be blank" }

        val content = StringBuilder()
        var tokensPerSecond: Double? = null
        var stopReason: String? = null
        client.completion.stream(
            CompletionStreamRequest(
                captureThinking = true,
                generationParams = CompletionStreamRequestGenerationParams(
                    predict = -1.0,
                    reasoning_budget = -1,
                    temp = 0.7,
                ),
                history = listOf(CompletionStreamRequestHistoryItem(role = "user", content = prompt)),
                modelId = modelId,
                stream = true,
            ),
        ).collect { response ->
            response.events.forEach { event ->
                when (event) {
                    is CompletionStreamResponseEventsItem.ContentDelta -> {
                        content.append(event.value.text)
                        onContent(event.value.text)
                    }
                    is CompletionStreamResponseEventsItem.CompletionStats ->
                        tokensPerSecond = event.value.stats.tokensPerSecond
                    is CompletionStreamResponseEventsItem.CompletionDoneError ->
                        throw QvacDemoException(event.value.error.message)
                    is CompletionStreamResponseEventsItem.CompletionDone ->
                        stopReason = event.value.stopReason?.let { Json.encodeToJsonElement(it).jsonPrimitive.content }
                    else -> Unit
                }
            }
        }
        return CompletionResult(content.toString(), tokensPerSecond, stopReason)
    }

    private fun ModelProgressResponse.toModelProgress(): ModelProgress {
        return ModelProgress(
            downloaded = downloaded.toLong(),
            total = total.toLong(),
            percentage = percentage.roundToInt(),
        )
    }
}
