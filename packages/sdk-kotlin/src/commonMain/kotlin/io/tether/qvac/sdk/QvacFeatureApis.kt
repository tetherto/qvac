package io.tether.qvac.sdk

import io.tether.qvac.sdk.generated.AudioGenStreamRequest
import io.tether.qvac.sdk.generated.AudioGenStreamResponse
import io.tether.qvac.sdk.generated.BciTranscribeRequest
import io.tether.qvac.sdk.generated.BciTranscribeStreamRequest
import io.tether.qvac.sdk.generated.ClassifyRequest
import io.tether.qvac.sdk.generated.DiffusionStreamRequest
import io.tether.qvac.sdk.generated.DiffusionStreamResponse
import io.tether.qvac.sdk.generated.EmbedRequest
import io.tether.qvac.sdk.generated.OcrStreamRequest
import io.tether.qvac.sdk.generated.TextToSpeechRequest
import io.tether.qvac.sdk.generated.TranscribeRequest
import io.tether.qvac.sdk.generated.TranslateRequest
import io.tether.qvac.sdk.generated.UpscaleStreamRequest
import io.tether.qvac.sdk.generated.UpscaleStreamResponse
import io.tether.qvac.sdk.generated.VideoStreamRequest
import io.tether.qvac.sdk.generated.VideoStreamResponse
import io.tether.qvac.sdk.generated.WorldSceneStreamRequest
import io.tether.qvac.sdk.generated.WorldSceneStreamResponse
import io.tether.qvac.sdk.generated.WorldStepStreamRequest
import io.tether.qvac.sdk.generated.WorldStepStreamResponse
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

val QvacClient.speech: QvacSpeech get() = QvacSpeech(this)
val QvacClient.vision: QvacVision get() = QvacVision(this)
val QvacClient.translation: QvacTranslation get() = QvacTranslation(this)
val QvacClient.embeddings: QvacEmbeddings get() = QvacEmbeddings(this)
val QvacClient.media: QvacMedia get() = QvacMedia(this)
val QvacClient.bci: QvacBci get() = QvacBci(this)

sealed interface QvacDataInput {
    fun toJson(): JsonObject

    data class FilePath(val path: String) : QvacDataInput {
        override fun toJson() = buildJsonObject {
            put("type", "filePath")
            put("value", path)
        }
    }

    data class Base64(val value: String) : QvacDataInput {
        override fun toJson() = buildJsonObject {
            put("type", "base64")
            put("value", value)
        }
    }
}

data class QvacTranscriptionSegment(
    val text: String,
    val startMs: Double? = null,
    val endMs: Double? = null,
    val append: Boolean? = null,
    val id: Double? = null,
)

data class QvacTranscriptionResult(
    val text: String,
    val segments: List<QvacTranscriptionSegment>,
    val stats: JsonObject? = null,
)

data class QvacVoiceOptions(
    val voice: String? = null,
    val description: String? = null,
    val emotion: String? = null,
    val pitch: String? = null,
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
        request: io.tether.qvac.sdk.generated.schema.TranscribeStreamRequest,
        audio: Flow<ByteArray>,
    ): Flow<io.tether.qvac.sdk.generated.schema.TranscribeStreamResponse> = client.transcribeStream(request, audio)

    /** Text chunks are UTF-8 bytes. Collect concurrently with producing input. No result aggregation. */
    fun synthesizeStream(
        request: io.tether.qvac.sdk.generated.schema.TextToSpeechStreamRequest,
        text: Flow<ByteArray>,
    ): Flow<io.tether.qvac.sdk.generated.schema.TextToSpeechStreamResponse> = client.textToSpeechStream(request, text)

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
                audioChunk = audio.toJson(),
                metadata = metadata,
                modelId = modelId,
                prompt = prompt,
                requestId = requestId,
                type = "transcribe",
            ),
        ).collect { response ->
            response.error?.let { throw QvacFeatureException("Transcription failed: $it") }
            response.text?.let(text::append)
            response.segment?.let { segments += it.toTranscriptionSegment() }
            response.stats?.let { stats = it }
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
                emotion = voice.emotion,
                expressivity = voice.expressivity,
                modelId = modelId,
                noise = voice.noise,
                pace = voice.pace,
                pitch = voice.pitch,
                quality = voice.quality,
                reverb = voice.reverb,
                stream = true,
                text = text,
                type = "textToSpeech",
                voice = voice.voice,
            ),
        ).collect { response ->
            samples += response.buffer
            response.sentenceChunk?.let(sentences::add)
            response.stats?.let { stats = it }
        }
        return QvacSpeechResult(samples, sentences, stats)
    }
}

data class QvacBciStreamOptions(
    val windowTimesteps: Int? = null,
    val hopTimesteps: Int? = null,
    val emit: String? = null,
) {
    internal fun toJson(): JsonObject {
        require(windowTimesteps == null || windowTimesteps > 0) { "windowTimesteps must be positive" }
        require(hopTimesteps == null || hopTimesteps > 0) { "hopTimesteps must be positive" }
        require(windowTimesteps == null || hopTimesteps == null || hopTimesteps < windowTimesteps) {
            "hopTimesteps must be less than windowTimesteps"
        }
        require(emit == null || emit == "delta" || emit == "full") { "emit must be 'delta' or 'full'" }
        return buildJsonObject {
            windowTimesteps?.let { put("windowTimesteps", it) }
            hopTimesteps?.let { put("hopTimesteps", it) }
            emit?.let { put("emit", it) }
        }
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
                neuralData = neuralData.toJson(),
                requestId = requestId,
                type = "bciTranscribe",
            ),
        ).collect { response ->
            response.error?.let { throw QvacFeatureException("BCI transcription failed: $it") }
            response.text?.let(text::append)
            response.segment?.let { segments += it.toTranscriptionSegment() }
            response.stats?.let { stats = it }
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
        val streamOptions = options.toJson().takeIf { it.isNotEmpty() }
        client.bciTranscribeStream(
            BciTranscribeStreamRequest(
                metadata = metadata,
                modelId = modelId,
                requestId = requestId,
                streamOpts = streamOptions,
                type = "bciTranscribeStream",
            ),
            neuralChunks,
        ).collect { response ->
            response.error?.let { throw QvacFeatureException("BCI streaming transcription failed: $it") }
            response.text?.let(text::append)
            response.segment?.let { segments += it.toTranscriptionSegment() }
            response.stats?.let { stats = it }
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
    val label: String?,
    val score: Double?,
    val raw: JsonObject,
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
                image = image.toJson(),
                modelId = modelId,
                options = buildJsonObject { put("paragraph", paragraph) },
                type = "ocrStream",
            ),
        ).collect { response ->
            response.error?.let { throw QvacFeatureException("OCR failed: $it") }
            response.blocks.orEmpty().forEach { block -> blocks += block.toOcrBlock() }
            response.stats?.let { stats = it }
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
                channels = channels?.toLong(),
                height = height?.toLong(),
                image = imageBase64,
                modelId = modelId,
                topK = topK?.toLong(),
                type = "classify",
                width = width?.toLong(),
            ),
        ).collect { response ->
            response.results.forEach { raw ->
                results += QvacClassification(
                    label = raw["label"]?.jsonPrimitive?.contentOrNull,
                    score = raw["score"]?.jsonPrimitive?.doubleOrNull
                        ?: raw["confidence"]?.jsonPrimitive?.doubleOrNull,
                    raw = raw,
                )
            }
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
        val response = client.cancel(
            io.tether.qvac.sdk.generated.schema.CancelRequest.Request(
                io.tether.qvac.sdk.generated.schema.CancelRequestRequest(requestId = requestId)),
        )
        return response.success && (response.cancelled ?: 0L) > 0L
    }
}

class QvacTranslation internal constructor(private val client: QvacClient) {
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
        val tokens = Channel<String>(Channel.UNLIMITED)
        val result = CompletableDeferred<QvacTranslationFinal>()
        val request = TranslateRequest(
            context = context,
            from = from,
            modelId = modelId,
            modelType = modelType,
            requestId = requestId,
            stream = stream,
            text = text,
            to = to,
            type = "translate",
        )
        client.scope.launch {
            val fullText = StringBuilder()
            var stats: JsonObject? = null
            try {
                client.translate(request).collect { response ->
                    response.error?.let { throw QvacFeatureException("Translation failed: $it") }
                    fullText.append(response.token)
                    if (response.token.isNotEmpty()) tokens.send(response.token)
                    response.stats?.let { stats = it }
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

class QvacEmbeddings internal constructor(private val client: QvacClient) {
    suspend fun embed(modelId: String, text: String, requestId: String = qvacRequestId()): List<Double> {
        val response = client.embed(
            EmbedRequest(
                modelId = modelId,
                requestId = requestId,
                text = JsonPrimitive(text),
                type = "embed",
            ),
        )
        if (!response.success) throw QvacFeatureException(response.error ?: "Embedding failed")
        return response.embedding.toDoubleList()
    }

    suspend fun embed(modelId: String, texts: List<String>, requestId: String = qvacRequestId()): List<List<Double>> {
        val response = client.embed(
            EmbedRequest(
                modelId = modelId,
                requestId = requestId,
                text = JsonArray(texts.map(::JsonPrimitive)),
                type = "embed",
            ),
        )
        if (!response.success) throw QvacFeatureException(response.error ?: "Embedding failed")
        return response.embedding.jsonArray.map(JsonElement::toDoubleList)
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
            type = "audioGenStream",
        ),
    )

    fun audio(request: AudioGenStreamRequest): QvacMediaRun<AudioGenStreamResponse> =
        mediaRun(client.audioGenStream(request)) { event ->
            MediaFrame(event.data, event.stats, event.stopReason, event.done)
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
            type = "diffusionStream",
            width = width?.toLong(),
        ),
    )

    fun diffusion(request: DiffusionStreamRequest): QvacMediaRun<DiffusionStreamResponse> =
        mediaRun(client.diffusionStream(request)) { event ->
            MediaFrame(event.data, event.stats, null, event.done == true)
        }

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
            mode = mode,
            modelId = modelId,
            prompt = prompt,
            type = "videoStream",
            video_frames = frames?.toLong(),
            width = width?.toLong(),
        ),
    )

    fun video(request: VideoStreamRequest): QvacMediaRun<VideoStreamResponse> =
        mediaRun(client.videoStream(request)) { event ->
            MediaFrame(event.data, event.stats, null, event.done == true)
        }

    fun upscale(modelId: String, imageBase64: String, repeats: Int? = null) = upscale(
        UpscaleStreamRequest(
            image = imageBase64,
            modelId = modelId,
            repeats = repeats?.toLong(),
            type = "upscaleStream",
        ),
    )

    fun upscale(request: UpscaleStreamRequest): QvacMediaRun<UpscaleStreamResponse> =
        mediaRun(client.upscaleStream(request)) { event ->
            MediaFrame(event.data, event.stats, null, event.done == true)
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
            type = "worldSceneStream",
            width = width?.toLong(),
        ),
    )

    fun worldScene(request: WorldSceneStreamRequest): QvacMediaRun<WorldSceneStreamResponse> =
        mediaRun(client.worldSceneStream(request)) { event ->
            MediaFrame(event.data, event.stats, null, event.done == true)
        }

    fun worldStep(
        modelId: String,
        keys: List<String>? = null,
        requestId: String = qvacRequestId(),
    ) = worldStep(
        WorldStepStreamRequest(
            keys = keys,
            modelId = modelId,
            requestId = requestId,
            type = "worldStepStream",
        ),
    )

    fun worldStep(request: WorldStepStreamRequest): QvacMediaRun<WorldStepStreamResponse> =
        mediaRun(client.worldStepStream(request)) { event ->
            MediaFrame(event.data, event.stats, null, event.done == true)
        }

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
    val done: Boolean,
)

private fun JsonObject.toTranscriptionSegment() = QvacTranscriptionSegment(
    text = get("text")?.jsonPrimitive?.content.orEmpty(),
    startMs = get("startMs")?.jsonPrimitive?.doubleOrNull,
    endMs = get("endMs")?.jsonPrimitive?.doubleOrNull,
    append = get("append")?.jsonPrimitive?.booleanOrNull,
    id = get("id")?.jsonPrimitive?.doubleOrNull,
)

private fun JsonObject.toOcrBlock() = QvacOcrBlock(
    text = get("text")?.jsonPrimitive?.content.orEmpty(),
    boundingBox = get("bbox")?.jsonArray?.mapNotNull { it.jsonPrimitive.doubleOrNull }.orEmpty(),
    confidence = get("confidence")?.jsonPrimitive?.doubleOrNull,
)

private fun JsonElement.toDoubleList(): List<Double> =
    jsonArray.mapNotNull { it.jsonPrimitive.doubleOrNull }
