package io.tether.qvac.sdk.sample

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.util.Base64
import io.tether.qvac.sdk.QvacClient
import io.tether.qvac.sdk.QvacAttachment
import io.tether.qvac.sdk.QvacCompletionOptions
import io.tether.qvac.sdk.QvacDataInput
import io.tether.qvac.sdk.QvacGenerationOptions
import io.tether.qvac.sdk.QvacMessage
import io.tether.qvac.sdk.QvacProgressEvent
import io.tether.qvac.sdk.completion
import io.tether.qvac.sdk.generated.LoadModelRequest
import io.tether.qvac.sdk.generated.ModelConstant
import io.tether.qvac.sdk.generated.Models
import io.tether.qvac.sdk.embeddings
import io.tether.qvac.sdk.loadModel
import io.tether.qvac.sdk.models
import io.tether.qvac.sdk.run
import io.tether.qvac.sdk.speech
import io.tether.qvac.sdk.translation
import io.tether.qvac.sdk.vision
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.collect
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.io.File
import java.io.FileOutputStream
import kotlin.time.Duration.Companion.milliseconds
import kotlin.time.TimeSource

/**
 * Executable Android examples for every small-model QVAC feature that is practical on a Pixel 8a.
 *
 * The feature-lab Activity and instrumentation suite both call this class, so a green device test
 * exercises the same public Kotlin API shown to application developers.
 */
class FeatureLabRunner(
    private val context: Context,
    private val client: QvacClient,
) {
    enum class Feature(val label: String) {
        LLM("LLM completion"),
        VISION("Vision"),
        OCR("OCR"),
        TRANSCRIPTION("Transcription"),
        TTS("Text to speech"),
        EMBEDDINGS("Embeddings"),
        TRANSLATION("Translation"),
        CLASSIFICATION("Classification"),
    }

    data class Result(
        val feature: Feature,
        val detail: String,
        val elapsedMs: Long,
    )

    suspend fun run(
        feature: Feature,
        progress: (String) -> Unit = {},
    ): Result {
        val started = TimeSource.Monotonic.markNow()
        val detail = when (feature) {
            Feature.LLM -> runLlm(progress)
            Feature.VISION -> runVision(progress)
            Feature.OCR -> runOcr(progress)
            Feature.TRANSCRIPTION -> runTranscription(progress)
            Feature.TTS -> runTts(progress)
            Feature.EMBEDDINGS -> runEmbeddings(progress)
            Feature.TRANSLATION -> runTranslation(progress)
            Feature.CLASSIFICATION -> runClassification(progress)
        }
        return Result(feature, detail, started.elapsedNow().inWholeMilliseconds)
    }

    suspend fun runAll(progress: (Feature, String) -> Unit = { _, _ -> }): List<Result> {
        return Feature.entries.map { feature ->
            progress(feature, "starting")
            run(feature) { message -> progress(feature, message) }
                .also { progress(feature, "passed in ${it.elapsedMs.milliseconds}") }
        }
    }

    private suspend fun runLlm(progress: (String) -> Unit): String =
        withModel(Models.QWEN3_600M_INST_Q4, AssistantModelConfig.qwen(), progress) { modelId ->
            val text = complete(
                modelId = modelId,
                prompt = "Reply with exactly QVAC_KOTLIN_OK",
                predict = -1,
            )
            check(text.contains("QVAC_KOTLIN_OK")) { "Unexpected completion: $text" }
            text.trim()
        }

    private suspend fun runVision(progress: (String) -> Unit): String {
        val image = createVisionImage()
        return try {
            withModel(Models.SMOLVLM2_500M_MULTIMODAL_Q8_0, AssistantModelConfig.smolVlm(), progress) { modelId ->
                val text = complete(
                    modelId = modelId,
                    prompt = "What is the dominant color? Answer with one word.",
                    attachment = image,
                    predict = 24,
                )
                check(text.isNotBlank()) { "Vision returned no text" }
                text.trim()
            }
        } finally {
            image.delete()
        }
    }

    private suspend fun runOcr(progress: (String) -> Unit): String {
        val image = createOcrImage()
        return try {
            withModel(Models.OCR_DOCTR, null, progress) { modelId ->
                val text = client.vision.ocr(
                    modelId = modelId,
                    image = QvacDataInput.FilePath(image.absolutePath),
                    paragraph = false,
                ).text.trim()
                check(text.isNotBlank()) { "OCR returned no text" }
                text
            }
        } finally {
            image.delete()
        }
    }

    private suspend fun runTranscription(progress: (String) -> Unit): String {
        val audio = copyAssetToCache("sample-16khz.wav")
        val plugins = client.runtimeProfile?.plugins.orEmpty()
        val (model, config) = when {
            plugins.any { "whispercpp-transcription" in it } ->
                Models.WHISPER_TINY_Q8_0 to AssistantModelConfig.whisperTiny()
            plugins.any { "parakeet-transcription" in it } ->
                Models.PARAKEET_CTC_0_6B_Q4_0 to AssistantModelConfig.parakeet()
            else -> error("The active QVAC profile does not contain a transcription plugin")
        }
        return try {
            withModel(model, config, progress) { modelId ->
                val text = client.speech.transcribe(
                    modelId = modelId,
                    audio = QvacDataInput.FilePath(audio.absolutePath),
                    metadata = false,
                ).text.trim()
                check(text.isNotBlank()) { "Whisper returned no transcript" }
                text
            }
        } finally {
            audio.delete()
        }
    }

    private suspend fun runTts(progress: (String) -> Unit): String =
        withModel(Models.TTS_MULTILINGUAL_SUPERTONIC3_Q4_0, AssistantModelConfig.supertonic(), progress) { modelId ->
            val samples = client.speech.synthesize(
                modelId = modelId,
                text = "QVAC Kotlin text to speech works on this phone.",
            ).samples.map { it.toInt().coerceIn(Short.MIN_VALUE.toInt(), Short.MAX_VALUE.toInt()).toShort() }
            check(samples.isNotEmpty()) { "TTS returned no audio samples" }
            val wav = File(context.cacheDir, "qvac-feature-lab-tts.wav")
            writePcm16Wav(wav, samples, 44_100)
            "${samples.size} samples · ${wav.name}"
        }

    private suspend fun runEmbeddings(progress: (String) -> Unit): String =
        withModel(Models.EMBEDDINGGEMMA_300M_Q4_0, AssistantModelConfig.embeddings(), progress) { modelId ->
            val vector = client.embeddings.embed(modelId, "QVAC runs private AI on device")
            check(vector.isNotEmpty()) { "Embedding vector was empty" }
            "${vector.size}-dimension vector"
        }

    private suspend fun runTranslation(progress: (String) -> Unit): String =
        withModel(Models.BERGAMOT_EN_FR, AssistantModelConfig.bergamotEnFr(), progress) { modelId ->
            val text = client.translation.run(
                from = "en",
                modelId = modelId,
                modelType = Models.BERGAMOT_EN_FR.engine,
                stream = false,
                text = "This is a small offline translation test.",
                to = "fr",
            ).text().trim()
            check(text.isNotBlank()) { "Translation returned no text" }
            text
        }

    private suspend fun runClassification(progress: (String) -> Unit): String {
        progress("loading bundled MobileNetV3")
        val weights = copyAssetToCache(
            "qvac/classification/mobilenetv3_3class_v3_fp16.gguf",
            "qvac-feature-lab-mobilenetv3.gguf",
        )
        val image = createVisionImage()
        var modelId: String? = null
        return try {
            val load = client.loadModel(
                LoadModelRequest(
                    modelConfig = buildJsonObject { put("modelPath", weights.absolutePath) },
                    modelSrc = JsonPrimitive(""),
                    modelType = "ggml-classification",
                    seed = JsonPrimitive(false),
                    type = "loadModel",
                    withProgress = JsonPrimitive(false),
                ),
            )
            check(load.success) { load.error ?: "Classification model failed to load" }
            modelId = requireNotNull(load.modelId)
            val encoded = Base64.encodeToString(image.readBytes(), Base64.NO_WRAP)
            val results = client.vision.classify(
                imageBase64 = encoded,
                modelId = requireNotNull(modelId),
                topK = 3,
            )
            check(results.isNotEmpty()) { "Classification returned no labels" }
            val best = results.first()
            val label = best.label ?: "unknown"
            val confidence = best.score
            "$label${confidence?.let { " · ${(it * 100).toInt()}%" }.orEmpty()}"
        } finally {
            image.delete()
            weights.delete()
            modelId?.let { runCatching { client.models.unload(it, clearStorage = false) } }
        }
    }

    private suspend fun complete(
        modelId: String,
        prompt: String,
        attachment: File? = null,
        predict: Int,
    ): String {
        return client.completion.run(
            modelId = modelId,
            history = listOf(
                QvacMessage.user(
                    content = prompt,
                    attachments = attachment?.let { listOf(QvacAttachment(it.absolutePath)) }.orEmpty(),
                ),
            ),
            options = QvacCompletionOptions(
                captureThinking = true,
                generation = QvacGenerationOptions(
                    predict = predict.toLong(),
                    reasoningBudget = -1,
                    temperature = 0.0,
                ),
            ),
        ).text()
    }

    private suspend fun <T> withModel(
        model: ModelConstant,
        config: JsonObject?,
        progress: (String) -> Unit,
        block: suspend (String) -> T,
    ): T {
        var modelId: String? = null
        var lastReportedPercentage = -1
        try {
            progress("loading ${model.name} (${megabytes(model.expectedSize)} MB)")
            client.models.loadWithProgress(
                source = model.src,
                modelType = model.engine,
                modelName = model.name,
                modelConfig = config,
            ).collect { event ->
                when (event) {
                    is QvacProgressEvent.Progress -> {
                        val percentage = event.value.percentage.toInt()
                        if (percentage != lastReportedPercentage) {
                            lastReportedPercentage = percentage
                            progress("downloading $percentage%")
                        }
                    }
                    is QvacProgressEvent.Result -> {
                        check(event.value.success) { event.value.error ?: "Could not load ${model.name}" }
                        modelId = event.value.modelId
                    }
                }
            }
            return block(requireNotNull(modelId) { "${model.name} returned no model ID" })
        } catch (error: CancellationException) {
            throw error
        } finally {
            modelId?.let { id -> runCatching { client.models.unload(id, clearStorage = false) } }
        }
    }

    private fun createVisionImage(): File {
        val file = File(context.cacheDir, "qvac-feature-lab-red.png")
        Bitmap.createBitmap(224, 224, Bitmap.Config.ARGB_8888).also { bitmap ->
            bitmap.eraseColor(Color.RED)
            FileOutputStream(file).use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
            bitmap.recycle()
        }
        return file
    }

    private fun createOcrImage(): File {
        val file = File(context.cacheDir, "qvac-feature-lab-ocr.png")
        Bitmap.createBitmap(800, 240, Bitmap.Config.ARGB_8888).also { bitmap ->
            val canvas = Canvas(bitmap)
            canvas.drawColor(Color.WHITE)
            val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                color = Color.BLACK
                textSize = 72f
                typeface = android.graphics.Typeface.DEFAULT_BOLD
            }
            canvas.drawText("QVAC KOTLIN 182", 48f, 142f, paint)
            FileOutputStream(file).use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
            bitmap.recycle()
        }
        return file
    }

    private fun copyAssetToCache(name: String, outputName: String = "qvac-feature-lab-$name"): File {
        val file = File(context.cacheDir, outputName)
        context.assets.open(name).use { input -> FileOutputStream(file).use(input::copyTo) }
        return file
    }

    private fun writePcm16Wav(file: File, samples: List<Short>, sampleRate: Int) {
        val dataLength = samples.size * 2
        val header = ByteArray(44)
        "RIFF".encodeToByteArray().copyInto(header, 0)
        putLittleEndianInt(header, 4, dataLength + 36)
        "WAVEfmt ".encodeToByteArray().copyInto(header, 8)
        putLittleEndianInt(header, 16, 16)
        header[20] = 1
        header[22] = 1
        putLittleEndianInt(header, 24, sampleRate)
        putLittleEndianInt(header, 28, sampleRate * 2)
        header[32] = 2
        header[34] = 16
        "data".encodeToByteArray().copyInto(header, 36)
        putLittleEndianInt(header, 40, dataLength)
        FileOutputStream(file).use { output ->
            output.write(header)
            samples.forEach { sample ->
                output.write(sample.toInt() and 0xff)
                output.write((sample.toInt() shr 8) and 0xff)
            }
        }
    }

    private fun putLittleEndianInt(buffer: ByteArray, offset: Int, value: Int) {
        repeat(4) { index -> buffer[offset + index] = (value shr (index * 8)).toByte() }
    }

    private fun megabytes(bytes: Long): Long = (bytes + 999_999) / 1_000_000
}
