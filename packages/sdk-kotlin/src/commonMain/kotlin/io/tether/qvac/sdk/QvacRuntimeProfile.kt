package io.tether.qvac.sdk

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive

@Serializable
enum class QvacCapability {
    LLM,
    EMBEDDINGS,
    TRANSCRIPTION,
    TRANSLATION,
    TTS,
    OCR,
    CLASSIFICATION,
    AUDIO_GENERATION,
    IMAGE_GENERATION,
    VIDEO_GENERATION,
    UPSCALING,
    VLA,
    WORLD,
}

@Serializable
data class QvacRuntimeProfile(
    val name: String,
    val sdkVersion: String,
    val capabilities: Set<QvacCapability>,
    val plugins: List<String> = emptyList(),
) {
    fun supports(capability: QvacCapability) = capability in capabilities
}

class UnsupportedCapabilityException(
    val capability: QvacCapability,
    val profile: QvacRuntimeProfile,
) : QvacFeatureException(
    "QVAC runtime profile '${profile.name}' does not include ${capability.name}. " +
        "Choose an Android artifact containing that capability or use io.tether:qvac-sdk-android.",
)

internal fun QvacRuntimeProfile.requirePayload(payload: JsonObject) {
    val operation = payload["type"]?.jsonPrimitive?.contentOrNull ?: return
    val capability = when (operation) {
        "completionStream", "completionOrchestrate", "batchCompletionStream" -> QvacCapability.LLM
        "embed" -> QvacCapability.EMBEDDINGS
        "transcribe", "transcribeStream", "bciTranscribe", "bciTranscribeStream" ->
            QvacCapability.TRANSCRIPTION
        "translate" -> QvacCapability.TRANSLATION
        "textToSpeech", "textToSpeechStream" -> QvacCapability.TTS
        "ocrStream" -> QvacCapability.OCR
        "classify" -> QvacCapability.CLASSIFICATION
        "audioGenStream" -> QvacCapability.AUDIO_GENERATION
        "diffusionStream" -> QvacCapability.IMAGE_GENERATION
        "videoStream" -> QvacCapability.VIDEO_GENERATION
        "upscaleStream" -> QvacCapability.UPSCALING
        "worldSceneStream", "worldStepStream" -> QvacCapability.WORLD
        "pluginInvoke", "pluginInvokeStream" -> when (
            payload["handler"]?.jsonPrimitive?.contentOrNull
        ) {
            "vlaRun", "vlaHparams", "vlaSetEmbodiment" -> QvacCapability.VLA
            else -> null
        }
        "loadModel" -> payload["modelType"]?.jsonPrimitive?.contentOrNull?.toCapability()
        else -> null
    }
    if (capability != null && !supports(capability)) {
        throw UnsupportedCapabilityException(capability, this)
    }
}

private fun String.toCapability(): QvacCapability? = when (this) {
    "llm", "llamacpp-completion" -> QvacCapability.LLM
    "embeddings", "llamacpp-embedding" -> QvacCapability.EMBEDDINGS
    "whisper", "whispercpp-transcription", "parakeet", "parakeet-transcription",
    "bci", "bci-whispercpp-transcription" -> QvacCapability.TRANSCRIPTION
    "nmt", "nmtcpp-translation" -> QvacCapability.TRANSLATION
    "tts", "onnx-tts", "tts-ggml" -> QvacCapability.TTS
    "ocr", "ggml-ocr" -> QvacCapability.OCR
    "classification", "ggml-classification" -> QvacCapability.CLASSIFICATION
    "audiogen", "audiogen-ggml" -> QvacCapability.AUDIO_GENERATION
    "sdcpp-generation", "diffusion" -> QvacCapability.IMAGE_GENERATION
    "vla", "ggml-vla" -> QvacCapability.VLA
    else -> null
}
