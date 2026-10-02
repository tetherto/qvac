package io.tether.qvac.sdk.sample

import io.tether.qvac.sdk.generated.Models
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

object AssistantModelConfig {
    val smolVlmProjectionSource = Models.MMPROJ_SMOLVLM2_500M_MULTIMODAL_Q8_0.src

    fun qwen() = buildJsonObject {
        put("ctx_size", 2048)
        put("device", "gpu")
        // Values above the model's layer count offload the entire model.
        put("gpu_layers", 99)
        // Let Qwen finish its reasoning; forcing non-thinking mode degraded
        // answer quality on the Pixel. This is independent of output length.
        put("reasoning_budget", -1)
    }

    fun qwenCpu() = buildJsonObject {
        put("ctx_size", 1024)
        put("device", "cpu")
        put("gpu_layers", 0)
        put("n_threads", 4)
        put("reasoning_budget", -1)
    }

    fun parakeet() = buildJsonObject {
        put("maxThreads", 4)
        put("useGPU", false)
    }

    fun smolVlm() = buildJsonObject {
        put("ctx_size", 1024)
        put("device", "cpu")
        put("gpu_layers", 0)
        put("projectionModelSrc", smolVlmProjectionSource)
    }

    fun whisperTiny() = buildJsonObject {
        put("audio_format", "f32le")
        put("language", "en")
        put("strategy", "greedy")
        put("n_threads", 4)
        put("translate", false)
        put("no_timestamps", true)
        put("contextParams", buildJsonObject {
            put("use_gpu", false)
            put("flash_attn", false)
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
        put("ctx_size", 512)
        put("device", "cpu")
        put("gpu_layers", 0)
        put("n_threads", 4)
    }

    fun bergamotEnFr() = buildJsonObject {
        put("engine", "Bergamot")
        put("from", "en")
        put("to", "fr")
        put("beamsize", 1)
        put("normalize", 1)
        put("temperature", 0.2)
        put("norepeatngramsize", 3)
        put("lengthpenalty", 1.2)
    }
}
