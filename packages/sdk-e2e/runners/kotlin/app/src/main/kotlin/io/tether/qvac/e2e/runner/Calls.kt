package io.tether.qvac.e2e.runner

import io.tether.qvac.sdk.QvacException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.consumeAsFlow
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.flow.transformWhile
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.io.File
import java.nio.file.Files
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

typealias Call = suspend (params: Map<String, Any?>) -> Any?
typealias Fold = suspend (params: Map<String, Any?>, collect: String) -> Any?

/**
 * Contract method name -> how this client serves it. Mirrors runners/js/shared/step-bindings.ts so
 * every client returns the same shape; a method missing here makes its test incomplete.
 */
class Calls(
    private val wire: Wire,
    private val resources: Resources,
    /** Where `scratchDirectory` makes its directories. */
    private val scratchRoot: File,
) {
    private val scope = CoroutineScope(SupervisorJob())

    fun close() = scope.cancel()

    private fun incomplete(method: String, collect: String) =
        StepError("collect: \"$collect\" is not defined for $method", incomplete = true)

    private fun Map<String, Any?>.require(key: String): Any =
        this[key] ?: throw StepError("$key is required")

    private fun Map<String, Any?>.withRequestId(): Map<String, Any?> =
        this + ("requestId" to (this["requestId"] ?: Wire.requestId()))

    /** A stream up to and including the frame that says it is done. */
    private suspend fun frames(payload: Map<String, Any?>, type: String): List<Map<String, Any?>> =
        wire.stream(payload)
            .transformWhile { frame ->
                if (frame["type"] == type) emit(frame)
                frame["type"] != type || frame["done"] != true
            }
            .toList()

    // --- completion ------------------------------------------------------------

    /** `buildFinalFromEvents` from @qvac/inference, field for field. */
    private class Aggregate(
        val final: Map<String, Any?>,
        val error: Map<String, Any?>?,
        val cancelled: Boolean,
    )

    private fun aggregate(events: List<Map<String, Any?>>): Aggregate {
        val content = StringBuilder()
        val thinking = StringBuilder()
        var stats: Any? = null
        var rawFullText: String? = null
        var error: Map<String, Any?>? = null
        var stopReason: Any? = null
        var cancelled = false
        val toolCalls = mutableListOf<Any?>()
        val toolErrors = mutableListOf<Any?>()
        for (event in events) {
            when (event["type"]) {
                "contentDelta" -> content.append(event["text"] as? String ?: "")
                "thinkingDelta" -> thinking.append(event["text"] as? String ?: "")
                "completionStats" -> stats = event["stats"]
                "toolCall" -> toolCalls += event["call"]
                "toolError" -> toolErrors += event["error"]
                "completionDone" -> {
                    (event["raw"] as? Map<*, *>)?.let { rawFullText = it["fullText"] as? String }
                    if (event["stopReason"] == "error" && "error" in event) {
                        error = asMap(event["error"])
                    } else {
                        event["stopReason"]?.let { stopReason = it }
                        if (event["stopReason"] == "cancelled") cancelled = true
                    }
                }
            }
        }
        val fullText = rawFullText ?: content.toString()
        val final = LinkedHashMap<String, Any?>()
        final["contentText"] = content.toString()
        if (thinking.isNotEmpty()) final["thinkingText"] = thinking.toString()
        final["toolCalls"] = toolCalls
        if (toolErrors.isNotEmpty()) final["toolErrors"] = toolErrors
        stats?.let { final["stats"] = it }
        final["raw"] = mapOf("fullText" to fullText)
        if (toolCalls.isEmpty()) {
            final["cacheableAssistantContent"] = fullText
                .replace(Regex("<think>[\\s\\S]*?</think>", RegexOption.IGNORE_CASE), "")
                .replace(Regex("<think>[\\s\\S]*$", RegexOption.IGNORE_CASE), "")
                .trim()
        }
        stopReason?.let { final["stopReason"] = it }
        return Aggregate(final, error, cancelled)
    }

    /** The final a run resolves to, or the rejection it raises instead. */
    private fun settled(run: Aggregate, requestId: String): Map<String, Any?> {
        run.error?.let { error ->
            throw QvacException(
                errorName = "COMPLETION_FAILED",
                code = io.tether.qvac.sdk.generated.ErrorCodes.lookup("COMPLETION_FAILED"),
                message = error["message"]?.toString() ?: "completion failed",
                payload = toJson(error) as? JsonObject ?: JsonObject(emptyMap()),
                cause = RuntimeException(error.toString()),
            )
        }
        if (run.cancelled) {
            throw QvacException(
                errorName = "INFERENCE_CANCELLED",
                code = io.tether.qvac.sdk.generated.ErrorCodes.lookup("INFERENCE_CANCELLED"),
                message = "Inference cancelled: $requestId",
                payload = JsonObject(mapOf("requestId" to JsonPrimitive(requestId))),
            )
        }
        return run.final
    }

    private fun withContent(history: Any?): List<Any?> =
        asList(history).map { message -> asMap(message) + ("content" to (asMap(message)["content"] ?: "")) }

    /** A fold this client does not have is a gap, found before anything is sent. */
    private fun requireCollect(method: String, collect: String, supported: Set<String>) {
        if (collect !in supported) throw incomplete(method, collect)
    }

    private suspend fun completion(params: Map<String, Any?>, collect: String): Any? {
        requireCollect("completion", collect, setOf("text", "events", "all"))
        val requestId = params["requestId"]?.toString() ?: Wire.requestId()
        val tools = asList(params["tools"])
        val request = linkedMapOf(
            "type" to "completionStream",
            "modelId" to params.require("modelId"),
            "history" to withContent(params["history"]),
            "kvCache" to params["kvCache"],
            "prefill" to params["prefill"],
            "tools" to tools.ifEmpty { null },
            "stream" to (params["stream"] ?: true),
            "generationParams" to params["generationParams"],
            "captureThinking" to params["captureThinking"],
            "emitRawDeltas" to params["emitRawDeltas"],
            "toolDialect" to params["toolDialect"],
            "responseFormat" to params["responseFormat"],
            "requestId" to requestId,
        )
        val events = frames(request, "completionStream").flatMap { asList(it["events"]).map(::asMap) }
        val tokens = events.filter { it["type"] == "contentDelta" }.map { it["text"] as? String ?: "" }
        return when (collect) {
            "text" -> {
                val final = settled(aggregate(events), requestId)
                linkedMapOf(
                    "text" to if (params["stream"] == true) tokens.joinToString("") else final["contentText"],
                    "toolCalls" to final["toolCalls"],
                    "stats" to final["stats"],
                    "stopReason" to final["stopReason"],
                    "fullText" to asMap(final["raw"])["fullText"],
                )
            }
            "events" -> mapOf("events" to events)
            // A run that does not stream has an empty token stream in the JS client.
            "all" -> mapOf("all" to if (params["stream"] == true) tokens else emptyList())
            else -> throw incomplete("completion", collect)
        }
    }

    private suspend fun batchCompletion(params: Map<String, Any?>, collect: String): Any? {
        requireCollect("batchCompletion", collect, setOf("all", "events"))
        val prompts = asList(params["prompts"]).map(::asMap)
        val requestId = params["requestId"]?.toString() ?: Wire.requestId()
        val request = linkedMapOf(
            "type" to "batchCompletionStream",
            "modelId" to params.require("modelId"),
            "prompts" to prompts.map { prompt ->
                buildMap {
                    prompt["id"]?.let { put("id", it) }
                    put("history", withContent(prompt["history"]))
                    prompt["generationParams"]?.let { put("generationParams", it) }
                    prompt["responseFormat"]?.let { put("responseFormat", it) }
                    asList(prompt["tools"]).takeIf { it.isNotEmpty() }?.let { put("tools", it) }
                }
            },
            "stream" to (params["stream"] ?: true),
            "captureThinking" to params["captureThinking"],
            "emitRawDeltas" to params["emitRawDeltas"],
            "toolDialect" to params["toolDialect"],
            "requestId" to requestId,
        )
        var ids: List<String> = emptyList()
        val batchEvents = mutableListOf<Map<String, Any?>>()
        val perId = LinkedHashMap<String, MutableList<Map<String, Any?>>>()
        for (frame in frames(request, "batchCompletionStream")) {
            (frame["ids"] as? List<*>)?.let { list -> ids = list.map { it.toString() } }
            for (raw in asList(frame["events"])) {
                val item = asMap(raw)
                batchEvents += item
                perId.getOrPut(item["id"].toString()) { mutableListOf() } += asMap(item["event"])
            }
        }
        if (collect == "events") return mapOf("events" to batchEvents)
        if (ids.isEmpty()) ids = prompts.mapIndexed { index, prompt -> prompt["id"]?.toString() ?: index.toString() }
        val results = ids.map { id ->
            mapOf("id" to id, "final" to settled(aggregate(perId[id].orEmpty()), requestId))
        }
        return mapOf("all" to results, "events" to batchEvents)
    }

    // --- translation, ocr, speech -----------------------------------------------

    private suspend fun translate(params: Map<String, Any?>, collect: String): Any? {
        requireCollect("translate", collect, setOf("text", "all"))
        val request = params + ("type" to "translate") + ("requestId" to (params["requestId"] ?: Wire.requestId()))
        val tokens = mutableListOf<String>()
        var stats: Any? = null
        for (frame in frames(request, "translate")) {
            if (frame["done"] == true) stats = frame["stats"] else tokens += frame["token"] as? String ?: ""
        }
        val streamed = params["stream"] == true
        if (collect == "all") {
            // `text` is the drained token stream, which a run that does not stream leaves empty.
            val drained = if (streamed) tokens else emptyList()
            return linkedMapOf("all" to drained, "text" to drained.joinToString(""), "stats" to stats)
        }
        if (streamed) return linkedMapOf("text" to tokens.joinToString(""), "stats" to stats)
        val translations = if (params["text"] is List<*>) tokens else listOf(tokens.joinToString(""))
        return linkedMapOf(
            "text" to translations.joinToString("\n"),
            "translations" to translations,
            "stats" to stats,
        )
    }

    private suspend fun ocr(params: Map<String, Any?>, collect: String): Any? {
        requireCollect("ocr", collect, setOf("blocks", "all", "events", "text"))
        val request = buildMap {
            put("type", "ocrStream")
            put("modelId", params.require("modelId"))
            put("image", Wire.fileOrBase64(params["image"]))
            params["options"]?.let { put("options", it) }
        }
        val blocks = mutableListOf<Any?>()
        var stats: Any? = null
        for (frame in frames(request, "ocrStream")) {
            blocks.addAll(asList(frame["blocks"]))
            if (frame["done"] == true) stats = frame["stats"]
        }
        return when (collect) {
            "blocks" -> mapOf("blocks" to blocks, "stats" to stats)
            "all", "events" -> mapOf("all" to blocks, "events" to blocks, "stats" to stats)
            "text" -> mapOf("text" to blocks.joinToString(" ") { asMap(it)["text"]?.toString() ?: "" }, "stats" to stats)
            else -> throw incomplete("ocr", collect)
        }
    }

    private fun transcribeRequest(params: Map<String, Any?>): Map<String, Any?> = buildMap {
        put("type", "transcribe")
        put("modelId", params.require("modelId"))
        put("audioChunk", Wire.fileOrBase64(params["audioChunk"]))
        params["prompt"]?.let { put("prompt", it) }
        params["hotwords"]?.let { put("hotwords", it) }
        params["maxNewTokens"]?.let { put("maxNewTokens", it) }
        if (params["metadata"] == true) put("metadata", true)
        put("requestId", params["requestId"] ?: Wire.requestId())
    }

    private suspend fun transcribe(params: Map<String, Any?>): Any? {
        val responses = frames(transcribeRequest(params), "transcribe")
        if (params["metadata"] == true) return mapOf("segments" to responses.mapNotNull { it["segment"] })
        return mapOf("text" to responses.joinToString("") { it["text"] as? String ?: "" })
    }

    /** `transcribeStream()` with upfront audio: the pieces as they arrive. */
    private suspend fun transcribeStream(params: Map<String, Any?>, collect: String): Any? {
        requireCollect("transcribeStream", collect, setOf("blocks", "all", "last", "text"))
        val responses = frames(transcribeRequest(params), "transcribe")
        val pieces: List<Any?> = if (params["metadata"] == true) {
            responses.mapNotNull { it["segment"] }
        } else {
            responses.mapNotNull { (it["text"] as? String)?.takeIf(String::isNotEmpty) }
        }
        return when (collect) {
            "blocks" -> mapOf("blocks" to pieces)
            "all" -> mapOf("all" to pieces)
            "last" -> mapOf("last" to pieces.lastOrNull())
            "text" -> mapOf("text" to pieces.joinToString("") { jsString(it) })
            else -> throw incomplete("transcribeStream", collect)
        }
    }

    private suspend fun textToSpeech(params: Map<String, Any?>, collect: String): Any? {
        requireCollect("textToSpeech", collect, setOf("pcm", "all", "events"))
        val stream = params["stream"] ?: true
        val sentenceStream = params["sentenceStream"] ?: false
        if (collect == "events" && sentenceStream == true) throw incomplete("textToSpeech", "events (sentence stream)")
        if (sentenceStream == true && stream != true) {
            throw Wire.refusal("TEXT_TO_SPEECH_STREAM_FAILED", "textToSpeech: `sentenceStream: true` requires `stream: true`")
        }
        val request = params + mapOf(
            "inputType" to (params["inputType"] ?: "text"),
            "stream" to stream,
            "sentenceStream" to sentenceStream,
            "type" to "textToSpeech",
            "requestId" to (params["requestId"] ?: Wire.requestId()),
        )
        val pcm = mutableListOf<Any?>()
        var done = false
        var sampleRate: Any? = null
        var text: Any? = null
        for (frame in frames(request, "textToSpeech")) {
            pcm.addAll(asList(frame["buffer"]))
            if (frame["text"] != null) text = frame["text"]
            if (sampleRate == null && frame["sampleRate"] != null) sampleRate = frame["sampleRate"]
            if (frame["done"] == true) done = true
        }
        return when (collect) {
            "pcm" -> linkedMapOf("pcm" to pcm, "sampleRate" to sampleRate, "done" to done, "text" to text)
            "all" -> mapOf("all" to if (stream == true) pcm else emptyList())
            "events" -> mapOf("events" to emptyList<Any?>())
            else -> throw incomplete("textToSpeech", collect)
        }
    }

    private suspend fun classify(params: Map<String, Any?>): Any? {
        val image = params["image"]
        val request = buildMap {
            put("type", "classify")
            put("modelId", params.require("modelId"))
            put("image", Wire.base64(if (image is String) File(image).readBytes() else bytesOf(image)))
            listOf("topK", "width", "height", "channels").forEach { key -> params[key]?.let { put(key, it) } }
        }
        val done = frames(request, "classify").lastOrNull { it["done"] == true }
        return mapOf("results" to (done?.get("results") ?: emptyList<Any?>()))
    }

    private suspend fun pluginStream(params: Map<String, Any?>, collect: String): Any? {
        requireCollect("invokePluginStream", collect, setOf("all", "last", "text"))
        val request = mapOf(
            "type" to "pluginInvokeStream",
            "modelId" to params.require("modelId"),
            "handler" to params.require("handler"),
            "params" to params["params"],
        )
        val chunks = frames(request, "pluginInvokeStream").filter { it["done"] != true }.map { it["result"] }
        return when (collect) {
            "all" -> mapOf("all" to chunks)
            "last" -> mapOf("last" to chunks.lastOrNull())
            "text" -> mapOf("text" to chunks.joinToString("") { jsString(it) })
            else -> throw incomplete("invokePluginStream", collect)
        }
    }

    // --- models and registry ----------------------------------------------------

    private suspend fun loadModel(params: Map<String, Any?>): Any? {
        // `{ modelId, modelConfig }` without a source is a config reload of a loaded model.
        if (params["modelSrc"] == null && params["modelId"] != null) {
            val response = wire.send(
                mapOf(
                    "type" to "loadModel",
                    "modelId" to params["modelId"],
                    "modelType" to params["modelType"]?.let { Resources.canonicalModelType(it.toString()) },
                    "modelConfig" to params["modelConfig"],
                ),
            )
            Wire.requireSuccess(response, "MODEL_LOAD_FAILED")
            return mapOf("modelId" to (response["modelId"] ?: params["modelId"]))
        }
        if (params["withProgress"] != true) return mapOf("modelId" to resources.loadModel(params))

        val args = resources.loadArgs(params)
        val request = mapOf(
            "type" to "loadModel",
            "modelSrc" to args.src,
            "modelName" to args.name,
            "modelType" to args.type,
            "modelConfig" to args.config,
            "withProgress" to true,
            "requestId" to (args.requestId ?: Wire.requestId()),
        )
        val progress = mutableListOf<Any?>()
        var modelId: Any? = null
        wire.stream(request).collect { frame ->
            when (frame["type"]) {
                "modelProgress" -> progress += frame
                "loadModel" -> {
                    Wire.requireSuccess(frame, "MODEL_LOAD_FAILED")
                    modelId = frame["modelId"]
                }
            }
        }
        return mapOf("modelId" to (modelId ?: throw StepError("loadModel stream ended without a result")), "progress" to progress)
    }

    private suspend fun registry(type: String, extra: Map<String, Any?>, field: String, fallback: String? = null): Any? {
        val response = wire.send(mapOf("type" to type) + extra)
        if (response["success"] != true) throw Wire.refusal("QVAC_MODEL_REGISTRY_QUERY_FAILED", (response["error"] as? String) ?: fallback ?: "Unknown registry error")
        return response[field]
    }

    // --- runtime ----------------------------------------------------------------

    private fun cancelParams(params: Map<String, Any?>): Map<String, Any?> {
        val operation = params["operation"]
        if (operation != null) {
            return when (operation) {
                "request", "broad" -> params
                "inference" -> mapOf("operation" to "broad", "modelId" to params["modelId"], "kind" to "completion")
                else -> mapOf("operation" to "broad", "modelId" to params["modelId"], "kind" to "embeddings")
            }
        }
        if ("requestId" in params) {
            return buildMap {
                put("operation", "request")
                put("requestId", params["requestId"])
                params["clearCache"]?.let { put("clearCache", it) }
            }
        }
        return buildMap {
            put("operation", "broad")
            put("modelId", params["modelId"])
            params["kind"]?.let { put("kind", it) }
        }
    }

    private suspend fun deleteCache(params: Map<String, Any?>): Any? {
        val request = when {
            params["all"] == true -> mapOf("type" to "deleteCache", "all" to true)
            params["auto"] == true -> mapOf("type" to "deleteCache", "auto" to true)
            "kvCacheKey" in params -> mapOf("type" to "deleteCache", "kvCacheKey" to params["kvCacheKey"], "modelId" to params["modelId"])
            else -> throw Wire.refusal("INVALID_DELETE_CACHE_PARAMS", "deleteCache needs all, auto or kvCacheKey")
        }
        val response = wire.send(request)
        if (response["success"] != true && response["error"] != null) throw Wire.refusal("DELETE_CACHE_FAILED", response["error"] as? String)
        return mapOf("success" to response["success"])
    }

    private suspend fun downloadAsset(params: Map<String, Any?>): Any? {
        val source = params["assetSrc"]
        val request = buildMap {
            put("type", "downloadAsset")
            put("assetSrc", (source as? Map<*, *>)?.get("src") ?: source)
            put("withProgress", false)
            put("seed", params["seed"] ?: false)
            put("requestId", params["requestId"] ?: Wire.requestId())
            params["requireHttpChecksum"]?.let { put("requireHttpChecksum", it) }
            params["requireSecureTransport"]?.let { put("requireSecureTransport", it) }
        }
        val response = Wire.requireSuccess(wire.send(request), "DOWNLOAD_ASSET_FAILED")
        return mapOf("path" to response["assetId"])
    }

    // --- rag and vector index ---------------------------------------------------

    private suspend fun rag(operation: String, params: Map<String, Any?>, failure: String): Map<String, Any?> {
        val response = wire.send(params + mapOf("type" to "rag", "operation" to operation))
        return Wire.requireSuccess(response, failure)
    }

    private class OpenIndex(val dim: Any?, val storage: Any?, var length: Any?)

    // Registries are reached from the body and from calls it `start`ed, on different threads.
    private val indexes: MutableMap<String, OpenIndex> = ConcurrentHashMap()

    private fun index(indexId: Any?): OpenIndex =
        indexes[indexId.toString()] ?: throw StepError("vector index \"$indexId\" is not open in this client")

    private suspend fun vectorIndex(operation: String, fields: Map<String, Any?>): Map<String, Any?> {
        val response = wire.send(mapOf("type" to "vectorIndex", "operation" to operation) + fields)
        return Wire.requireSuccess(response, "VECTOR_INDEX_FAILED")
    }

    private fun describeIndex(response: Map<String, Any?>): Map<String, Any?> {
        val indexId = response["indexId"].toString()
        indexes[indexId] = OpenIndex(response["dim"], response["storage"], response["length"])
        return linkedMapOf("indexId" to indexId, "dim" to response["dim"], "storage" to response["storage"], "length" to response["length"])
    }

    // --- sessions: transcription and logs ---------------------------------------

    private class TranscribeSession(
        val input: Channel<ByteArray>,
        val events: Channel<Map<String, Any?>>,
        val stats: CompletableDeferred<Any?>,
        var job: Job? = null,
    )

    private val sessions: MutableMap<String, TranscribeSession> = ConcurrentHashMap()
    private val sessionSeq = AtomicInteger()

    private fun session(id: Any?): TranscribeSession =
        sessions[id.toString()] ?: throw StepError("transcription session \"$id\" is not open")

    /** The event a session yields for one frame, by the session's mode, as the JS client maps it. */
    private fun sessionEvent(frame: Map<String, Any?>, mode: String, wantsMetadata: Boolean): Map<String, Any?>? {
        if (mode == "conversation") {
            asMap(frame["vad"]).takeIf { frame["vad"] != null }?.let { vad ->
                return buildMap {
                    put("type", "vad")
                    put("speaking", vad["speaking"])
                    put("probability", vad["probability"])
                    vad["source"]?.let { put("source", it) }
                    if ("speakerId" in vad) put("speakerId", vad["speakerId"])
                }
            }
            asMap(frame["endOfTurn"]).takeIf { frame["endOfTurn"] != null }?.let { turn ->
                return if (turn["source"] == "whisper") {
                    mapOf("type" to "endOfTurn", "source" to "whisper", "silenceDurationMs" to turn["silenceDurationMs"])
                } else {
                    mapOf("type" to "endOfTurn", "source" to "parakeet")
                }
            }
        }
        if (mode == "metadata") return asMap(frame["segment"]).takeIf { frame["segment"] != null }
        if (mode == "conversation" && wantsMetadata) {
            return frame["segment"]?.let { mapOf("type" to "segment", "segment" to it) }
        }
        val text = frame["text"] as? String
        return if (text != null && text.isNotBlank()) mapOf("type" to "text", "text" to text) else null
    }

    private fun openSession(request: Map<String, Any?>, mode: String, wantsMetadata: Boolean): Map<String, Any?> {
        val session = TranscribeSession(Channel(Channel.UNLIMITED), Channel(Channel.UNLIMITED), CompletableDeferred())
        session.job = scope.launch(start = CoroutineStart.UNDISPATCHED) {
            try {
                wire.duplex(request, session.input.consumeAsFlow()).collect { frame ->
                    if (frame["error"] != null) throw Wire.refusal("TRANSCRIPTION_FAILED", frame["error"].toString())
                    if (frame["done"] == true) {
                        session.stats.complete(frame["stats"])
                        session.events.close()
                        return@collect
                    }
                    sessionEvent(frame, mode, wantsMetadata)?.let { session.events.send(it) }
                }
                session.stats.complete(null)
                session.events.close()
            } catch (error: Throwable) {
                session.stats.completeExceptionally(error)
                session.events.close(error)
            }
        }
        val id = "session-${sessionSeq.incrementAndGet()}"
        sessions[id] = session
        return mapOf("sessionId" to id)
    }

    private suspend fun transcribeStreamOpen(params: Map<String, Any?>): Any? {
        val request = buildMap {
            put("type", "transcribeStream")
            put("modelId", params.require("modelId"))
            (params["prompt"] as? String)?.takeIf(String::isNotEmpty)?.let { put("prompt", it) }
            if (params["metadata"] == true) put("metadata", true)
            if (params["emitVadEvents"] == true) put("emitVadEvents", true)
            params["endOfTurnSilenceMs"]?.let { put("endOfTurnSilenceMs", it) }
            params["vadRunIntervalMs"]?.let { put("vadRunIntervalMs", it) }
            params["parakeetStreamingConfig"]?.let { put("parakeetStreamingConfig", it) }
        }
        val mode = when {
            params["emitVadEvents"] == true || params["parakeetStreamingConfig"] != null -> "conversation"
            params["metadata"] == true -> "metadata"
            else -> "text"
        }
        return openSession(request, mode, params["metadata"] == true)
    }

    private suspend fun transcribeStreamWrite(params: Map<String, Any?>): Any? {
        val session = session(params["sessionId"])
        val decoded = Media.decodeWavToMonoF32(bytesOf(params["audio"]))
        val expected = asDouble(params["expectSampleRate"])?.toInt() ?: 16000
        if (decoded.sampleRate != expected) throw StepError("fixture sample rate ${decoded.sampleRate} != expected $expected")
        val wide = params["sampleFormat"] == "f32le"
        val bytesPerSample = if (wide) 4 else 2
        val speech = if (wide) Media.f32ToLeBytes(decoded.samplesMono) else Media.f32ToS16LeBytes(decoded.samplesMono)
        val silenceSamples = ((asDouble(params["trailingSilenceMs"]) ?: 0.0) / 1000 * decoded.sampleRate).toInt()
        val silence = ByteArray(silenceSamples * bytesPerSample)
        val chunkMs = asDouble(params.require("chunkMs"))!!
        val chunkSize = chunkLength((chunkMs / 1000 * decoded.sampleRate).toInt() * bytesPerSample, "chunkMs")
        val delayMs = if (params["pace"] == false) 0L else chunkMs.toLong()
        var chunks = 0
        for (payload in listOf(speech, silence)) {
            var offset = 0
            while (offset < payload.size) {
                session.input.send(payload.copyOfRange(offset, minOf(offset + chunkSize, payload.size)))
                chunks++
                if (delayMs > 0 && offset + chunkSize < payload.size) delay(delayMs)
                offset += chunkSize
            }
        }
        return mapOf("chunks" to chunks, "bytes" to speech.size + silence.size)
    }

    /** A chunk that holds nothing would never advance through the audio. */
    private fun chunkLength(bytes: Int, param: String): Int =
        bytes.takeIf { it > 0 } ?: throw StepError("$param gives chunks of $bytes bytes; it must give at least one")

    private suspend fun transcribeStreamWriteChunks(params: Map<String, Any?>): Any? {
        val session = session(params["sessionId"])
        val decoded = Media.decodeWavToMonoF32(bytesOf(params["audio"]))
        val speech = Media.f32ToS16LeBytes(decoded.samplesMono)
        val chunkSize = chunkLength(((asDouble(params.require("chunkMs"))!! / 1000) * decoded.sampleRate).toInt() * 2, "chunkMs")
        var written = 0
        for (index in 0 until (asDouble(params["chunks"])?.toInt() ?: 0)) {
            val offset = index * chunkSize
            if (offset >= speech.size) break
            session.input.send(speech.copyOfRange(offset, minOf(offset + chunkSize, speech.size)))
            written++
        }
        return mapOf("chunks" to written)
    }

    private suspend fun transcribeStreamWriteBytes(params: Map<String, Any?>): Any? {
        val session = session(params["sessionId"])
        val data = bytesOf(params["data"])
        val chunkBytes = chunkLength(asDouble(params.require("chunkBytes"))!!.toInt(), "chunkBytes")
        var chunks = 0
        var offset = 0
        while (offset < data.size) {
            session.input.send(data.copyOfRange(offset, minOf(offset + chunkBytes, data.size)))
            chunks++
            offset += chunkBytes
        }
        return mapOf("chunks" to chunks, "bytes" to data.size)
    }

    private suspend fun transcribeStreamDrain(params: Map<String, Any?>, collect: String): Any? {
        requireCollect("transcribeStreamDrain", collect, setOf("events"))
        val session = session(params["sessionId"])
        val abortAfter = asDouble(params["abortAfter"])?.toInt()
        val events = mutableListOf<Map<String, Any?>>()
        for (event in session.events) {
            events += event
            if (abortAfter != null && events.size >= abortAfter) {
                // The consumer erroring is what unwinds the session, not the session finishing.
                session.job?.cancel()
                session.input.close()
                break
            }
        }
        val stats = try {
            if (abortAfter != null && !session.stats.isCompleted) null else session.stats.await()
        } catch (error: Throwable) {
            if (abortAfter == null) throw error
            null
        }
        return mapOf("events" to events, "stats" to stats)
    }

    private suspend fun transcribeStreamDestroy(params: Map<String, Any?>): Any? {
        val id = params["sessionId"]?.toString() ?: return mapOf("destroyed" to false)
        val session = sessions.remove(id) ?: return mapOf("destroyed" to false)
        session.input.close()
        session.stats.complete(null)
        session.job?.cancelAndJoin()
        return mapOf("destroyed" to true)
    }

    private class LogStream(val collected: MutableList<Map<String, Any?>>, var cutoffMs: Long = 0, var job: Job? = null)

    private val logStreams: MutableMap<String, LogStream> = ConcurrentHashMap()
    private var logStreamSeq = 0

    private fun logStream(id: Any?): LogStream =
        logStreams[id.toString()] ?: throw StepError("log stream \"$id\" is not open")

    private suspend fun loggingStreamOpen(params: Map<String, Any?>): Any? {
        val state = LogStream(java.util.Collections.synchronizedList(mutableListOf()))
        val id = "logs-${++logStreamSeq}"
        logStreams[id] = state
        // Read in the background: the catalog triggers the logged operation before the collect step.
        state.job = scope.launch(start = CoroutineStart.UNDISPATCHED) {
            try {
                wire.stream(mapOf("type" to "loggingStream", "id" to (params["id"] ?: SDK_LOG_ID))).collect { entry ->
                    state.collected += entry
                }
            } catch (_: Throwable) {
                // An unknown id closes the stream; the collect step reports the count.
            }
        }
        return mapOf("streamId" to id)
    }

    private suspend fun loggingStreamCollect(params: Map<String, Any?>): Any? {
        val state = logStream(params["streamId"])
        val target = asDouble(params["target"])?.toInt() ?: 1
        val deadline = System.currentTimeMillis() + (asDouble(params["timeoutMs"])?.toLong() ?: 5000L)
        fun since() = synchronized(state.collected) {
            state.collected.filter { (asDouble(it["timestamp"]) ?: 0.0) >= state.cutoffMs }
        }
        while (since().size < target && System.currentTimeMillis() < deadline) delay(50)
        return mapOf("entries" to since())
    }

    private suspend fun loggingStreamClose(params: Map<String, Any?>): Any? {
        val id = params["streamId"]?.toString() ?: return mapOf("closed" to false)
        val state = logStreams.remove(id) ?: return mapOf("closed" to false)
        val closed = withTimeoutOrNull(5000) { state.job?.cancelAndJoin() }
        if (closed == null) throw StepError("log stream \"$id\" did not close within 5000ms")
        return mapOf("closed" to true)
    }

    // --- scratch directories ------------------------------------------------------

    private val scratchDirectories: MutableSet<File> = ConcurrentHashMap.newKeySet()

    private fun withinScratch(candidate: File): Boolean {
        val resolved = candidate.canonicalFile
        return scratchDirectories.any { root ->
            val base = root.canonicalFile
            resolved == base || resolved.path.startsWith(base.path + File.separator)
        }
    }

    fun scratch(method: String, params: Map<String, Any?>): Any? {
        when (method) {
            "scratchDirectory" -> {
                scratchRoot.mkdirs()
                val root = Files.createTempDirectory(scratchRoot.toPath(), "qvac-e2e-").toFile()
                val directories = LinkedHashMap<String, Any?>()
                for (name in asList(params["subdirectories"])) {
                    val directory = File(root, name.toString()).apply { mkdirs() }
                    directories[name.toString()] = directory.absolutePath
                }
                scratchDirectories += root
                return mapOf("path" to root.absolutePath, "directories" to directories)
            }
            "producedFile" -> {
                val directory = File(params["directory"].toString())
                if (!withinScratch(directory)) throw StepError("\"$directory\" is not inside a directory this test created")
                val target = File(directory, params["file"].toString())
                return mapOf("exists" to target.exists(), "path" to target.absolutePath)
            }
            else -> {
                val target = params["path"]?.toString()?.let(::File)
                if (target == null || target !in scratchDirectories) return mapOf("discarded" to false)
                scratchDirectories -= target
                target.deleteRecursively()
                return mapOf("discarded" to true)
            }
        }
    }

    // --- the tables ---------------------------------------------------------------

    val calls: Map<String, Call> = mapOf(
        "embed" to { p -> wire.send(p.withRequestId() + ("type" to "embed")).let { r -> buildMap<String, Any?> { put("embedding", r["embedding"]); r["stats"]?.let { put("stats", it) } } } },
        "classify" to ::classify,
        "transcribe" to ::transcribe,
        "loadModel" to ::loadModel,
        "unloadModel" to { p ->
            val response = wire.send(mapOf("type" to "unloadModel", "modelId" to p.require("modelId"), "clearStorage" to (p["clearStorage"] ?: false)))
            if (response["success"] != true) throw Wire.refusal("MODEL_UNLOAD_FAILED", "Failed to unload model ${p["modelId"]}")
            null
        },
        "getModelInfo" to { p -> wire.send(mapOf("type" to "getModelInfo", "name" to p["name"]))["modelInfo"] },
        "getLoadedModelInfo" to { p -> wire.send(mapOf("type" to "getLoadedModelInfo", "modelId" to p["modelId"]))["info"] },
        "modelRegistryList" to { _ -> registry("modelRegistryList", emptyMap(), "models") },
        "modelRegistrySearch" to { p ->
            val rest = p - "modelType"
            registry("modelRegistrySearch", rest + ("addon" to (p["modelType"] ?: p["addon"])), "models")
        },
        "modelRegistryGetModel" to { p ->
            registry(
                "modelRegistryGetModel",
                mapOf("registryPath" to p["registryPath"], "registrySource" to p["registrySource"]),
                "model",
                "Model not found: ${p["registrySource"]}/${p["registryPath"]}",
            )
        },
        "cancel" to { p ->
            val response = wire.send(mapOf("type" to "cancel") + cancelParams(p))
            if (response["success"] != true) throw Wire.refusal("CANCEL_FAILED", response["error"] as? String)
            null
        },
        "deleteCache" to ::deleteCache,
        "downloadAsset" to ::downloadAsset,
        "getSystemResources" to { p ->
            val response = wire.send(buildMap<String, Any?> { put("type", "getSystemResources"); p["sample"]?.let { put("sample", it) } })
            buildMap<String, Any?> { put("capabilities", response["capabilities"]); response["sample"]?.let { put("sample", it) } }
        },
        "heartbeat" to { _ -> wire.send(mapOf("type" to "heartbeat")) },
        "suspend" to { _ -> wire.send(mapOf("type" to "suspend")); mapOf("suspended" to true) },
        "resume" to { _ -> wire.send(mapOf("type" to "resume")); mapOf("resumed" to true) },
        "state" to { _ -> mapOf("state" to wire.send(mapOf("type" to "state"))["state"]) },
        "ragIngest" to { p ->
            val response = rag("ingest", p + ("chunk" to (p["chunk"] ?: true)) + ("requestId" to (p["requestId"] ?: Wire.requestId())), "RAG_SAVE_FAILED")
            mapOf("processed" to response["processed"], "droppedIndices" to response["droppedIndices"])
        },
        "ragCloseWorkspace" to { p -> rag("closeWorkspace", p, "RAG_WORKSPACE_CLOSE_FAILED"); mapOf("closed" to true) },
        "ragDeleteWorkspace" to { p -> rag("deleteWorkspace", p, "RAG_DELETE_FAILED"); mapOf("deleted" to true) },
        "createVectorIndex" to { p ->
            describeIndex(vectorIndex("create", mapOf("dim" to p["dim"], "storage" to (p["storage"] ?: "turbovec-q4"))))
        },
        "loadVectorIndex" to { p -> describeIndex(vectorIndex("load", mapOf("path" to p["path"]))) },
        "vectorIndexAdd" to { p ->
            val open = index(p["indexId"])
            val response = vectorIndex("add", mapOf("indexId" to p["indexId"], "ids" to p["ids"], "vectors" to p["vectors"]))
            open.length = response["length"]
            mapOf("length" to open.length)
        },
        "vectorIndexSearch" to { p ->
            index(p["indexId"])
            val response = vectorIndex("search", mapOf("indexId" to p["indexId"], "queries" to listOf(p["query"]), "k" to p["k"]))
            mapOf("results" to (asList(response["results"]).firstOrNull() ?: emptyList<Any?>()))
        },
        "vectorIndexRemove" to { p ->
            val open = index(p["indexId"])
            val response = vectorIndex("remove", mapOf("indexId" to p["indexId"], "ids" to p["ids"]))
            open.length = response["length"]
            mapOf("removed" to response["removed"], "length" to open.length)
        },
        "vectorIndexContains" to { p ->
            index(p["indexId"])
            mapOf("present" to vectorIndex("contains", mapOf("indexId" to p["indexId"], "ids" to p["ids"]))["present"])
        },
        "vectorIndexWrite" to { p ->
            index(p["indexId"])
            mapOf("path" to vectorIndex("write", mapOf("indexId" to p["indexId"], "path" to p["path"]))["path"])
        },
        "vectorIndexDispose" to { p ->
            val id = p["indexId"]?.toString()
            if (id == null || id !in indexes) {
                mapOf("disposed" to false)
            } else {
                vectorIndex("dispose", mapOf("indexId" to id))
                indexes.remove(id)
                mapOf("disposed" to true)
            }
        },
        "vectorIndexLength" to { p -> mapOf("length" to index(p["indexId"]).length) },
        "invokePlugin" to { p ->
            val response = wire.send(mapOf("type" to "pluginInvoke", "modelId" to p["modelId"], "handler" to p["handler"], "params" to p["params"]))
            mapOf("result" to response["result"])
        },
        "transcribeStreamOpen" to ::transcribeStreamOpen,
        "transcribeStreamWrite" to ::transcribeStreamWrite,
        "transcribeStreamWriteChunks" to ::transcribeStreamWriteChunks,
        "transcribeStreamWriteBytes" to ::transcribeStreamWriteBytes,
        "transcribeStreamEnd" to { p -> session(p["sessionId"]).input.close(); mapOf("ended" to true) },
        "transcribeStreamDestroy" to ::transcribeStreamDestroy,
        "loggingStreamOpen" to ::loggingStreamOpen,
        "loggingStreamMark" to { p ->
            val state = logStream(p["streamId"])
            state.cutoffMs = System.currentTimeMillis()
            mapOf("markedAt" to state.cutoffMs)
        },
        "loggingStreamCollect" to ::loggingStreamCollect,
        "loggingStreamClose" to ::loggingStreamClose,
    )

    val streams: Map<String, Fold> = mapOf(
        "completion" to ::completion,
        "translate" to ::translate,
        "ocr" to ::ocr,
        "transcribeStream" to ::transcribeStream,
        "textToSpeech" to ::textToSpeech,
        "batchCompletion" to ::batchCompletion,
        "transcribeStreamDrain" to ::transcribeStreamDrain,
        "invokePluginStream" to ::pluginStream,
    )

    private companion object {
        /** The SDK server's own log stream, as the JS client names it. */
        const val SDK_LOG_ID = "__engine__"
    }
}
