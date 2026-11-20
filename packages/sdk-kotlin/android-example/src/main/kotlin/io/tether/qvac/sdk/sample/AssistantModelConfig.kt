package io.tether.qvac.sdk.sample

import io.tether.qvac.sdk.generated.Models
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

object AssistantModelConfig {
    val smolVlmProjectionSource = Models.MMPROJ_SMOLVLM2_500M_MULTIMODAL_Q8_0.src

    fun qwen() = buildJsonObject {
        put("ctxSize", 2048)
        put("device", "gpu")
        // Values above the model's layer count offload the entire model.
        put("gpuLayers", 99)
        // Let Qwen finish its reasoning; forcing non-thinking mode degraded
        // answer quality on the Pixel. This is independent of output length.
        put("reasoningBudget", -1)
    }

    fun qwenCpu() = buildJsonObject {
        put("ctxSize", 1024)
        put("device", "cpu")
        put("gpuLayers", 0)
        put("reasoningBudget", -1)
    }

    fun parakeet() = buildJsonObject {
        put("maxThreads", 4)
        put("useGpu", false)
    }

    fun smolVlm() = buildJsonObject {
        put("ctxSize", 1024)
        put("device", "cpu")
        put("gpuLayers", 0)
        put("projectionModelSrc", smolVlmProjectionSource)
    }

    fun whisperTiny() = buildJsonObject {
        put("audioFormat", "f32le")
        put("language", "en")
        put("strategy", "greedy")
        put("threads", 4)
        put("translate", false)
        put("noTimestamps", true)
        put("contextParams", buildJsonObject {
            put("useGpu", false)
            put("flashAttention", false)
        })
    }

    fun supertonic() = buildJsonObject {
        put("ttsEngine", "supertonic")
        put("language", "en")
        put("voice", "F1")
        put("ttsSpeed", 1.05)
        put("ttsNumInferenceSteps", 5)
    }

    fun embeddings() = buildJsonObject {
        put("ctxSize", 512)
        put("device", "cpu")
        put("gpuLayers", 0)
    }

    fun bergamotEnFr() = buildJsonObject {
        put("engine", "Bergamot")
        put("from", "en")
        put("to", "fr")
        put("beamSize", 1)
        put("normalize", 1)
        put("temperature", 0.2)
        put("noRepeatNgramSize", 3)
        put("lengthPenalty", 1.2)
    }
}
