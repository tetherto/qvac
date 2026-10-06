package io.tether.qvac.sdk

import io.tether.qvac.sdk.generated.schema.AudioGenStreamRequest
import io.tether.qvac.sdk.generated.schema.AudioGenStreamResponse
import io.tether.qvac.sdk.generated.schema.BciTranscribeRequest
import io.tether.qvac.sdk.generated.schema.BciTranscribeRequestNeuralData
import io.tether.qvac.sdk.generated.schema.BciTranscribeRequestNeuralDataBase64
import io.tether.qvac.sdk.generated.schema.BciTranscribeRequestNeuralDataFilePath
import io.tether.qvac.sdk.generated.schema.BciTranscribeStreamRequest
import io.tether.qvac.sdk.generated.schema.BciTranscribeStreamRequestStreamOpts
import io.tether.qvac.sdk.generated.schema.BciTranscribeStreamRequestStreamOptsEmit
import io.tether.qvac.sdk.generated.schema.CancelRequest
import io.tether.qvac.sdk.generated.schema.CancelRequestRequest
import io.tether.qvac.sdk.generated.schema.ClassifyRequest
import io.tether.qvac.sdk.generated.schema.DiffusionStreamRequest
import io.tether.qvac.sdk.generated.schema.DiffusionStreamResponse
import io.tether.qvac.sdk.generated.schema.EmbedRequest
import io.tether.qvac.sdk.generated.schema.EmbedRequestText
import io.tether.qvac.sdk.generated.schema.EmbedResponseEmbedding
import io.tether.qvac.sdk.generated.schema.OcrStreamRequest
import io.tether.qvac.sdk.generated.schema.OcrStreamRequestImage
import io.tether.qvac.sdk.generated.schema.OcrStreamRequestImageBase64
import io.tether.qvac.sdk.generated.schema.OcrStreamRequestImageFilePath
import io.tether.qvac.sdk.generated.schema.OcrStreamRequestOptions
import io.tether.qvac.sdk.generated.schema.OcrStreamResponseBlocksItem
import io.tether.qvac.sdk.generated.schema.TextToSpeechRequest
import io.tether.qvac.sdk.generated.schema.TextToSpeechRequestEmotion
import io.tether.qvac.sdk.generated.schema.TextToSpeechRequestPace
import io.tether.qvac.sdk.generated.schema.TextToSpeechStreamRequest
import io.tether.qvac.sdk.generated.schema.TextToSpeechStreamResponse
import io.tether.qvac.sdk.generated.schema.TranscribeRequest
import io.tether.qvac.sdk.generated.schema.TranscribeRequestAudioChunk
import io.tether.qvac.sdk.generated.schema.TranscribeRequestAudioChunkBase64
import io.tether.qvac.sdk.generated.schema.TranscribeRequestAudioChunkFilePath
import io.tether.qvac.sdk.generated.schema.TranscribeStreamRequest
import io.tether.qvac.sdk.generated.schema.TranscribeStreamResponse
import io.tether.qvac.sdk.generated.schema.TranslateLlmRequest
import io.tether.qvac.sdk.generated.schema.TranslateLlmRequestModelType
import io.tether.qvac.sdk.generated.schema.TranslateNmtRequest
import io.tether.qvac.sdk.generated.schema.TranslateNmtRequestModelType
import io.tether.qvac.sdk.generated.schema.TranslateNmtRequestText
import io.tether.qvac.sdk.generated.schema.TranslateRequest
import io.tether.qvac.sdk.generated.schema.UpscaleStreamRequest
import io.tether.qvac.sdk.generated.schema.UpscaleStreamResponse
import io.tether.qvac.sdk.generated.schema.VideoStreamRequest
import io.tether.qvac.sdk.generated.schema.VideoStreamRequestMode
import io.tether.qvac.sdk.generated.schema.VideoStreamResponse
import io.tether.qvac.sdk.generated.schema.WorldSceneStreamRequest
import io.tether.qvac.sdk.generated.schema.WorldSceneStreamResponse
import io.tether.qvac.sdk.generated.schema.WorldStepStreamRequest
import io.tether.qvac.sdk.generated.schema.WorldStepStreamRequestKeysItem
import io.tether.qvac.sdk.generated.schema.WorldStepStreamResponse
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

val QvacClient.speech: QvacSpeech get() = QvacSpeech(this)
val QvacClient.vision: QvacVision get() = QvacVision(this)
val QvacClient.translation: QvacTranslation get() = QvacTranslation(this)
val QvacClient.embeddings: QvacEmbeddings get() = QvacEmbeddings(this)
val QvacClient.media: QvacMedia get() = QvacMedia(this)
val QvacClient.bci: QvacBci get() = QvacBci(this)

sealed interface QvacDataInput {
    data class FilePath(val path: String) : QvacDataInput

    data class Base64(val value: String) : QvacDataInput
}

data class QvacTranscriptionSegment(
    val text: String,
    val startMs: Double,
    val endMs: Double,
    val append: Boolean,
    val id: Double,
)

data class QvacTranscriptionResult(
    val text: String,
    val segments: List<QvacTranscriptionSegment>,
    val stats: JsonObject? = null,
)

data class QvacVoiceOptions(
    val voice: String? = null,
    val description: String? = null,
    /** One of the worker's emotion names, e.g. "neutral" or "happy". */
    val emotion: String? = null,
    val pitch: String? = null,
    /** "slow", "moderate" or "fast". */
    val pace: String? = null,
    val expressivity: String? = null,
    val noise: String? = null,
    val reverb: String? = null,
    val quality: String? = null,
)

data class QvacSpeechResult(
    val samples: List<Double>,
    val sentenceChunks: List<String>,
    val stats: JsonObject? = null,
)

class QvacSpeech internal constructor(private val client: QvacClient) {
    /** Audio bytes follow the worker's format. Flow completion finishes input; cancellation closes both directions. */
    fun transcribeStream(
        request: TranscribeStreamRequest,
        audio: Flow<ByteArray>,
    ): Flow<TranscribeStreamResponse> = client.transcribeStream(request, audio)

    /** Text chunks are UTF-8 bytes. Collect concurrently with producing input. No result aggregation. */
    fun synthesizeStream(
        request: TextToSpeechStreamRequest,
        text: Flow<ByteArray>,
    ): Flow<TextToSpeechStreamResponse> = client.textToSpeechStream(request, text)

    suspend fun transcribe(
        modelId: String,
        audio: QvacDataInput,
        prompt: String? = null,
        metadata: Boolean = false,
        requestId: String = qvacRequestId(),
    ): QvacTranscriptionResult {
        val text = StringBuilder()
        val segments = mutableListOf<QvacTranscriptionSegment>()
        var stats: JsonObject? = null
        client.transcribe(
            TranscribeRequest(
                audioChunk = audio.toAudioChunk(),
                metadata = metadata,
                modelId = modelId,
                prompt = prompt,
                requestId = requestId,
            ),
        ).collect { response ->
            response.error?.let { throw QvacFeatureException("Transcription failed: $it") }
            response.text?.let(text::append)
            response.segment?.let { segments += QvacTranscriptionSegment(it.text, it.startMs, it.endMs, it.append, it.id) }
            response.stats?.let { stats = client.json.encodeToJsonElement(it).jsonObject }
        }
        return QvacTranscriptionResult(text.toString(), segments, stats)
    }

    suspend fun synthesize(
        modelId: String,
        text: String,
        voice: QvacVoiceOptions = QvacVoiceOptions(),
    ): QvacSpeechResult {
        val samples = mutableListOf<Double>()
        val sentences = mutableListOf<String>()
        var stats: JsonObject? = null
        client.textToSpeech(
            TextToSpeechRequest(
                description = voice.description,
                emotion = voice.emotion?.let { wireEnum<TextToSpeechRequestEmotion>("emotion", it) },
                expressivity = voice.expressivity,
                modelId = modelId,
                noise = voice.noise,
                pace = voice.pace?.let { wireEnum<TextToSpeechRequestPace>("pace", it) },
                pitch = voice.pitch,
                quality = voice.quality,
                reverb = voice.reverb,
                stream = true,
                text = text,
                voice = voice.voice,
            ),
        ).collect { response ->
            samples += response.buffer
            response.sentenceChunk?.let(sentences::add)
            response.stats?.let { stats = client.json.encodeToJsonElement(it).jsonObject }
        }
        return QvacSpeechResult(samples, sentences, stats)
    }
}

data class QvacBciStreamOptions(
    val windowTimesteps: Int? = null,
    val hopTimesteps: Int? = null,
    /** "delta" or "full". */
    val emit: String? = null,
) {
    internal fun toWire(): BciTranscribeStreamRequestStreamOpts? {
        require(windowTimesteps == null || windowTimesteps > 0) { "windowTimesteps must be positive" }
        require(hopTimesteps == null || hopTimesteps > 0) { "hopTimesteps must be positive" }
        require(windowTimesteps == null || hopTimesteps == null || hopTimesteps < windowTimesteps) {
            "hopTimesteps must be less than windowTimesteps"
        }
        if (windowTimesteps == null && hopTimesteps == null && emit == null) return null
        return BciTranscribeStreamRequestStreamOpts(
            windowTimesteps = windowTimesteps?.toLong(),
            hopTimesteps = hopTimesteps?.toLong(),
            emit = emit?.let { wireEnum<BciTranscribeStreamRequestStreamOptsEmit>("emit", it) },
        )
    }
}

class QvacBci internal constructor(private val client: QvacClient) {
    suspend fun transcribe(
        modelId: String,
        neuralData: QvacDataInput,
        metadata: Boolean = false,
        requestId: String = qvacRequestId(),
    ): QvacTranscriptionResult {
        val text = StringBuilder()
        val segments = mutableListOf<QvacTranscriptionSegment>()
        var stats: JsonObject? = null
        client.bciTranscribe(
            BciTranscribeRequest(
                metadata = metadata,
                modelId = modelId,
                neuralData = neuralData.toNeuralData(),
                requestId = requestId,
            ),
        ).collect { response ->
            response.error?.let { throw QvacFeatureException("BCI transcription failed: $it") }
            response.text?.let(text::append)
            response.segment?.let { segments += QvacTranscriptionSegment(it.text, it.startMs, it.endMs, it.append, it.id) }
            response.stats?.let { stats = client.json.encodeToJsonElement(it).jsonObject }
        }
        return QvacTranscriptionResult(text.toString(), segments, stats)
    }

    suspend fun transcribeStream(
        modelId: String,
        neuralChunks: Flow<ByteArray>,
        metadata: Boolean = false,
        options: QvacBciStreamOptions = QvacBciStreamOptions(),
        requestId: String = qvacRequestId(),
    ): QvacTranscriptionResult {
        val text = StringBuilder()
        val segments = mutableListOf<QvacTranscriptionSegment>()
        var stats: JsonObject? = null
        client.bciTranscribeStream(
            BciTranscribeStreamRequest(
                metadata = metadata,
                modelId = modelId,
                requestId = requestId,
                streamOpts = options.toWire(),
            ),
            neuralChunks,
        ).collect { response ->
            response.error?.let { throw QvacFeatureException("BCI streaming transcription failed: $it") }
            response.text?.let(text::append)
            response.segment?.let { segments += QvacTranscriptionSegment(it.text, it.startMs, it.endMs, it.append, it.id) }
            response.stats?.let { stats = client.json.encodeToJsonElement(it).jsonObject }
        }
        return QvacTranscriptionResult(text.toString(), segments, stats)
    }
}

data class QvacOcrBlock(
    val text: String,
    val boundingBox: List<Double> = emptyList(),
    val confidence: Double? = null,
)

data class QvacOcrResult(
    val blocks: List<QvacOcrBlock>,
    val text: String = blocks.joinToString("\n") { it.text },
    val stats: JsonObject? = null,
)

data class QvacClassification(
    val label: String,
    val confidence: Double,
)

class QvacVision internal constructor(private val client: QvacClient) {
    suspend fun ocr(
        modelId: String,
        image: QvacDataInput,
        paragraph: Boolean = true,
    ): QvacOcrResult {
        val blocks = mutableListOf<QvacOcrBlock>()
        var stats: JsonObject? = null
        client.ocrStream(
            OcrStreamRequest(
                image = image.toOcrImage(),
                modelId = modelId,
                options = OcrStreamRequestOptions(paragraph = paragraph),
            ),
        ).collect { response ->
            response.error?.let { throw QvacFeatureException("OCR failed: $it") }
            response.blocks.orEmpty().forEach { block -> blocks += block.toOcrBlock() }
            response.stats?.let { stats = client.json.encodeToJsonElement(it).jsonObject }
        }
        return QvacOcrResult(blocks, stats = stats)
    }

    suspend fun classify(
        modelId: String,
        imageBase64: String,
        width: Int? = null,
        height: Int? = null,
        channels: Int? = null,
        topK: Int? = null,
    ): List<QvacClassification> {
        val results = mutableListOf<QvacClassification>()
        client.classify(
            ClassifyRequest(
                channels = channels?.toDouble(),
                height = height?.toLong(),
                image = imageBase64,
                modelId = modelId,
                topK = topK?.toLong(),
                width = width?.toLong(),
            ),
        ).collect { response ->
            response.results.forEach { results += QvacClassification(it.label, it.confidence) }
        }
        return results
    }
}

data class QvacTranslationFinal(val text: String, val stats: JsonObject? = null)

class QvacTranslationRun internal constructor(
    val requestId: String,
    val tokens: Flow<String>,
    val final: Deferred<QvacTranslationFinal>,
    private val client: QvacClient,
) {
    suspend fun text() = final.await().text

    suspend fun cancel(): Boolean {
        val response = client.cancel(CancelRequest.Request(CancelRequestRequest(requestId = requestId)))
        return response.success && (response.cancelled ?: 0L) > 0L
    }
}

class QvacTranslation internal constructor(private val client: QvacClient) {
    /**
     * [modelType] selects the engine: "nmt"/"nmtcpp-translation" models translate in the
     * direction fixed at load time, while "llm"/"llamacpp-completion" models need [to].
     */
    fun run(
        modelId: String,
        text: String,
        modelType: String,
        to: String? = null,
        from: String? = null,
        context: String? = null,
        stream: Boolean = true,
        requestId: String = qvacRequestId(),
    ): QvacTranslationRun {
        val request = translateRequest(modelId, text, modelType, to, from, context, stream, requestId)
        val tokens = Channel<String>(Channel.UNLIMITED)
        val result = CompletableDeferred<QvacTranslationFinal>()
        client.scope.launch {
            val fullText = StringBuilder()
            var stats: JsonObject? = null
            try {
                client.translate(request).collect { response ->
                    response.error?.let { throw QvacFeatureException("Translation failed: $it") }
                    fullText.append(response.token)
                    if (response.token.isNotEmpty()) tokens.send(response.token)
                    response.stats?.let { stats = client.json.encodeToJsonElement(it).jsonObject }
                }
                result.complete(QvacTranslationFinal(fullText.toString(), stats))
                tokens.close()
            } catch (error: Throwable) {
                result.completeExceptionally(error)
                tokens.close(error)
            }
        }
        return QvacTranslationRun(requestId, tokens.receiveAsFlow(), result, client)
    }
}

private fun translateRequest(
    modelId: String,
    text: String,
    modelType: String,
    to: String?,
    from: String?,
    context: String?,
    stream: Boolean,
    requestId: String,
): TranslateRequest {
    TranslateNmtRequestModelType.entries.firstOrNull { modelType == Json.wireName(it) }?.let { nmtType ->
        require(to == null && from == null && context == null) {
            "from, to and context apply to LLM translation only; NMT direction is fixed when the model loads"
        }
        return TranslateRequest.TranslateNmtRequest(
            TranslateNmtRequest(
                modelId = modelId,
                text = TranslateNmtRequestText.Variant1(text),
                stream = stream,
                modelType = nmtType,
                requestId = requestId,
            ),
        )
    }
    val llmType = wireEnum<TranslateLlmRequestModelType>("modelType", modelType)
    requireNotNull(to) { "LLM translation requires a target language" }
    return TranslateRequest.TranslateLlmRequest(
        TranslateLlmRequest(
            modelId = modelId,
            text = text,
            stream = stream,
            modelType = llmType,
            from = from,
            to = to,
            context = context,
            requestId = requestId,
        ),
    )
}

class QvacEmbeddings internal constructor(private val client: QvacClient) {
    suspend fun embed(modelId: String, text: String, requestId: String = qvacRequestId()): List<Double> {
        val response = client.embed(
            EmbedRequest(
                modelId = modelId,
                requestId = requestId,
                text = EmbedRequestText.Variant1(text),
            ),
        )
        if (!response.success) throw QvacFeatureException(response.error ?: "Embedding failed")
        return when (val embedding = response.embedding) {
            is EmbedResponseEmbedding.Variant1 -> embedding.value
            is EmbedResponseEmbedding.Variant2 -> embedding.value.singleOrNull()
                ?: throw QvacFeatureException("Expected one embedding, got ${embedding.value.size}")
        }
    }

    suspend fun embed(modelId: String, texts: List<String>, requestId: String = qvacRequestId()): List<List<Double>> {
        val response = client.embed(
            EmbedRequest(
                modelId = modelId,
                requestId = requestId,
                text = EmbedRequestText.Variant2(texts),
            ),
        )
        if (!response.success) throw QvacFeatureException(response.error ?: "Embedding failed")
        return when (val embedding = response.embedding) {
            is EmbedResponseEmbedding.Variant1 -> listOf(embedding.value)
            is EmbedResponseEmbedding.Variant2 -> embedding.value
        }
    }
}

data class QvacMediaResult(
    val data: List<String>,
    val stats: JsonObject? = null,
    val stopReason: String? = null,
)

class QvacMediaRun<Event> internal constructor(
    val events: Flow<Event>,
    val final: Deferred<QvacMediaResult>,
)

class QvacMedia internal constructor(private val client: QvacClient) {
    fun audio(
        modelId: String,
        caption: String,
        durationSeconds: Double? = null,
        seed: Long? = null,
    ) = audio(
        AudioGenStreamRequest(
            caption = caption,
            duration = durationSeconds,
            modelId = modelId,
            seed = seed,
        ),
    )

    fun audio(request: AudioGenStreamRequest): QvacMediaRun<AudioGenStreamResponse> =
        mediaRun(client.audioGenStream(request)) { event ->
            MediaFrame(event.data, event.stats?.let { statsJson(it) }, event.stopReason?.let { client.json.wireName(it) })
        }

    fun diffusion(
        modelId: String,
        prompt: String,
        width: Int? = null,
        height: Int? = null,
        steps: Int? = null,
        seed: Long? = null,
    ) = diffusion(
        DiffusionStreamRequest(
            height = height?.toLong(),
            modelId = modelId,
            prompt = prompt,
            seed = seed,
            steps = steps?.toLong(),
            width = width?.toLong(),
        ),
    )

    fun diffusion(request: DiffusionStreamRequest): QvacMediaRun<DiffusionStreamResponse> =
        mediaRun(client.diffusionStream(request)) { event ->
            MediaFrame(event.data, event.stats?.let { statsJson(it) }, null)
        }

    /** [mode] is "txt2vid" or "img2vid". */
    fun video(
        modelId: String,
        prompt: String,
        mode: String = "txt2vid",
        width: Int? = null,
        height: Int? = null,
        frames: Int? = null,
    ) = video(
        VideoStreamRequest(
            height = height?.toLong(),
            mode = wireEnum<VideoStreamRequestMode>("mode", mode),
            modelId = modelId,
            prompt = prompt,
            video_frames = frames?.toLong(),
            width = width?.toLong(),
        ),
    )

    fun video(request: VideoStreamRequest): QvacMediaRun<VideoStreamResponse> =
        mediaRun(client.videoStream(request)) { event ->
            MediaFrame(event.data, event.stats?.let { statsJson(it) }, null)
        }

    fun upscale(modelId: String, imageBase64: String, repeats: Int? = null) = upscale(
        UpscaleStreamRequest(
            image = imageBase64,
            modelId = modelId,
            repeats = repeats?.toLong(),
        ),
    )

    fun upscale(request: UpscaleStreamRequest): QvacMediaRun<UpscaleStreamResponse> =
        mediaRun(client.upscaleStream(request)) { event ->
            MediaFrame(event.data, event.stats?.let { statsJson(it) }, null)
        }

    fun worldScene(
        modelId: String,
        imageBase64: String,
        prompt: String,
        width: Int? = null,
        height: Int? = null,
        returnPack: Boolean? = null,
        requestId: String = qvacRequestId(),
    ) = worldScene(
        WorldSceneStreamRequest(
            height = height?.toLong(),
            image = imageBase64,
            modelId = modelId,
            prompt = prompt,
            requestId = requestId,
            returnPack = returnPack,
            width = width?.toLong(),
        ),
    )

    fun worldScene(request: WorldSceneStreamRequest): QvacMediaRun<WorldSceneStreamResponse> =
        mediaRun(client.worldSceneStream(request)) { event ->
            MediaFrame(event.data, event.stats?.let { statsJson(it) }, null)
        }

    /** [keys] are the held movement keys: W, A, S, D, I, J, K or L. */
    fun worldStep(
        modelId: String,
        keys: List<String>? = null,
        requestId: String = qvacRequestId(),
    ) = worldStep(
        WorldStepStreamRequest(
            keys = keys?.map { wireEnum<WorldStepStreamRequestKeysItem>("key", it) },
            modelId = modelId,
            requestId = requestId,
        ),
    )

    fun worldStep(request: WorldStepStreamRequest): QvacMediaRun<WorldStepStreamResponse> =
        mediaRun(client.worldStepStream(request)) { event ->
            MediaFrame(event.data, event.stats?.let { statsJson(it) }, null)
        }

    private inline fun <reified Stats> statsJson(stats: Stats): JsonObject =
        client.json.encodeToJsonElement(stats).jsonObject

    private fun <Event> mediaRun(
        source: Flow<Event>,
        frame: (Event) -> MediaFrame,
    ): QvacMediaRun<Event> {
        val events = Channel<Event>(Channel.UNLIMITED)
        val result = CompletableDeferred<QvacMediaResult>()
        client.scope.launch {
            val data = mutableListOf<String>()
            var stats: JsonObject? = null
            var stopReason: String? = null
            try {
                source.collect { event ->
                    events.send(event)
                    val value = frame(event)
                    value.data?.let(data::add)
                    value.stats?.let { stats = it }
                    value.stopReason?.let { stopReason = it }
                }
                result.complete(QvacMediaResult(data, stats, stopReason))
                events.close()
            } catch (error: Throwable) {
                result.completeExceptionally(error)
                events.close(error)
            }
        }
        return QvacMediaRun(events.receiveAsFlow(), result)
    }
}

open class QvacFeatureException(message: String, cause: Throwable? = null) : Exception(message, cause)

private data class MediaFrame(
    val data: String?,
    val stats: JsonObject?,
    val stopReason: String?,
)

private fun QvacDataInput.toAudioChunk(): TranscribeRequestAudioChunk = when (this) {
    is QvacDataInput.FilePath -> TranscribeRequestAudioChunk.FilePath(TranscribeRequestAudioChunkFilePath(value = path))
    is QvacDataInput.Base64 -> TranscribeRequestAudioChunk.Base64(TranscribeRequestAudioChunkBase64(value = value))
}

private fun QvacDataInput.toNeuralData(): BciTranscribeRequestNeuralData = when (this) {
    is QvacDataInput.FilePath -> BciTranscribeRequestNeuralData.FilePath(BciTranscribeRequestNeuralDataFilePath(value = path))
    is QvacDataInput.Base64 -> BciTranscribeRequestNeuralData.Base64(BciTranscribeRequestNeuralDataBase64(value = value))
}

private fun QvacDataInput.toOcrImage(): OcrStreamRequestImage = when (this) {
    is QvacDataInput.FilePath -> OcrStreamRequestImage.FilePath(OcrStreamRequestImageFilePath(value = path))
    is QvacDataInput.Base64 -> OcrStreamRequestImage.Base64(OcrStreamRequestImageBase64(value = value))
}

private fun OcrStreamResponseBlocksItem.toOcrBlock() = QvacOcrBlock(
    text = text,
    boundingBox = bbox?.mapNotNull { it.jsonPrimitive.doubleOrNull }.orEmpty(),
    confidence = confidence,
)
