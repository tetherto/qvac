package io.tether.qvac.sdk

import io.tether.qvac.sdk.generated.schema.CancelRequest
import io.tether.qvac.sdk.generated.schema.CancelRequestRequest
import io.tether.qvac.sdk.generated.CompletionOrchestrateRequest
import io.tether.qvac.sdk.generated.CompletionStreamRequest
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
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import kotlin.random.Random

data class QvacAttachment(val path: String) {
    internal fun toJson() = buildJsonObject { put("path", path) }
}

data class QvacMessage(
    val role: String,
    val content: String,
    val attachments: List<QvacAttachment> = emptyList(),
) {
    internal fun toJson() = buildJsonObject {
        put("role", role)
        put("content", content)
        if (attachments.isNotEmpty()) {
            putJsonArray("attachments") { attachments.forEach { add(it.toJson()) } }
        }
    }

    companion object {
        fun system(content: String) = QvacMessage("system", content)
        fun user(content: String, attachments: List<QvacAttachment> = emptyList()) =
            QvacMessage("user", content, attachments)
        fun assistant(content: String) = QvacMessage("assistant", content)
        fun tool(content: String) = QvacMessage("tool", content)
    }
}

data class QvacGenerationOptions(
    val temperature: Double? = null,
    val topP: Double? = null,
    val topK: Double? = null,
    /** -1 runs until the model stop token; -2 runs until the context is full. */
    val predict: Long? = null,
    val seed: Long? = null,
    val frequencyPenalty: Double? = null,
    val presencePenalty: Double? = null,
    val repeatPenalty: Double? = null,
    val reasoningBudget: Long? = null,
    val removeThinkingFromContext: Boolean? = null,
) {
    internal fun toJson(): JsonObject = buildJsonObject {
        temperature?.let { put("temp", it) }
        topP?.let { put("top_p", it) }
        topK?.let { put("top_k", it) }
        predict?.let { put("predict", it) }
        seed?.let { put("seed", it) }
        frequencyPenalty?.let { put("frequency_penalty", it) }
        presencePenalty?.let { put("presence_penalty", it) }
        repeatPenalty?.let { put("repeat_penalty", it) }
        reasoningBudget?.let { put("reasoning_budget", it) }
        removeThinkingFromContext?.let { put("remove_thinking_from_context", it) }
    }
}

sealed interface QvacResponseFormat {
    fun toJson(): JsonObject

    data object Text : QvacResponseFormat {
        override fun toJson() = buildJsonObject { put("type", "text") }
    }

    data object JsonValue : QvacResponseFormat {
        override fun toJson() = buildJsonObject { put("type", "json_object") }
    }

    data class JsonSchema(
        val name: String,
        val schema: JsonObject,
        val description: String? = null,
        val strict: Boolean? = null,
    ) : QvacResponseFormat {
        override fun toJson() = buildJsonObject {
            put("type", "json_schema")
            putJsonObject("json_schema") {
                put("name", name)
                put("schema", schema)
                description?.let { put("description", it) }
                strict?.let { put("strict", it) }
            }
        }
    }
}

enum class QvacToolParameterType(val wireName: String) {
    STRING("string"), NUMBER("number"), INTEGER("integer"), BOOLEAN("boolean"),
    OBJECT("object"), ARRAY("array"),
}

data class QvacToolParameter(
    val type: QvacToolParameterType,
    val description: String? = null,
    val enumValues: List<JsonElement>? = null,
)

typealias QvacToolHandler = suspend (JsonObject) -> JsonElement

data class QvacTool(
    val name: String,
    val description: String,
    val parameters: Map<String, QvacToolParameter> = emptyMap(),
    val required: Set<String> = emptySet(),
    val handler: QvacToolHandler? = null,
) {
    internal fun toJson(): JsonObject = buildJsonObject {
        put("type", "function")
        put("name", name)
        put("description", description)
        putJsonObject("parameters") {
            put("type", "object")
            putJsonObject("properties") {
                parameters.forEach { (parameterName, parameter) ->
                    putJsonObject(parameterName) {
                        put("type", parameter.type.wireName)
                        parameter.description?.let { put("description", it) }
                        parameter.enumValues?.let { put("enum", JsonArray(it)) }
                    }
                }
            }
            if (required.isNotEmpty()) {
                putJsonArray("required") { required.forEach { add(JsonPrimitive(it)) } }
            }
        }
    }
}

data class QvacCompletionOptions(
    val generation: QvacGenerationOptions = QvacGenerationOptions(predict = -1),
    val stream: Boolean = true,
    val kvCache: JsonElement? = null,
    val captureThinking: Boolean? = null,
    val emitRawDeltas: Boolean? = null,
    val toolDialect: String? = null,
    val responseFormat: QvacResponseFormat? = null,
    val requestId: String = qvacRequestId(),
)

sealed interface QvacCompletionEvent {
    val sequence: Long

    data class ContentDelta(override val sequence: Long, val text: String) : QvacCompletionEvent
    data class RawDelta(override val sequence: Long, val text: String) : QvacCompletionEvent
    data class ThinkingDelta(override val sequence: Long, val text: String) : QvacCompletionEvent
    data class ToolCallEvent(override val sequence: Long, val call: QvacToolCall) : QvacCompletionEvent
    data class ToolError(
        override val sequence: Long,
        val code: String,
        val message: String,
        val raw: String? = null,
    ) : QvacCompletionEvent
    data class Stats(override val sequence: Long, val value: QvacCompletionStats) : QvacCompletionEvent
    data class Done(
        override val sequence: Long,
        val stopReason: String? = null,
        val error: String? = null,
        val rawFullText: String? = null,
    ) : QvacCompletionEvent
    data class Unknown(override val sequence: Long, val payload: JsonObject) : QvacCompletionEvent
}

data class QvacCompletionStats(
    val timeToFirstToken: Double? = null,
    val tokensPerSecond: Double? = null,
    val cacheTokens: Double? = null,
    val promptTokens: Double? = null,
    val generatedTokens: Double? = null,
    val emittedTokens: Double? = null,
    val averageConcurrentSequences: Double? = null,
    val backendDevice: String? = null,
    val raw: JsonObject,
)

data class QvacToolCall(
    val id: String,
    val name: String,
    val arguments: JsonObject,
    val raw: String? = null,
    private val handler: QvacToolHandler? = null,
) {
    val canInvoke: Boolean get() = handler != null

    suspend fun invoke(): JsonElement {
        return handler?.invoke(arguments)
            ?: throw QvacCompletionException("No handler registered for tool '$name'")
    }
}

data class QvacCompletionFinal(
    val text: String,
    val thinking: String? = null,
    val toolCalls: List<QvacToolCall> = emptyList(),
    val stats: QvacCompletionStats? = null,
    val rawFullText: String = text,
    val cacheableAssistantContent: String? = null,
    val stopReason: String? = null,
)

open class QvacCompletionException(message: String, cause: Throwable? = null) :
    Exception(message, cause)

class QvacCompletionCancelledException(
    val requestId: String,
    val partial: QvacCompletionFinal,
) : QvacCompletionException("Completion '$requestId' was cancelled")

class QvacCompletionRun internal constructor(
    val requestId: String,
    private val client: QvacClient,
    internal val eventChannel: Channel<QvacCompletionEvent>,
    internal val tokenChannel: Channel<String>,
    internal val toolCallChannel: Channel<QvacToolCall>,
    internal val result: CompletableDeferred<QvacCompletionFinal>,
) {
    val events: Flow<QvacCompletionEvent> = eventChannel.receiveAsFlow()
    val tokens: Flow<String> = tokenChannel.receiveAsFlow()
    val toolCallEvents: Flow<QvacToolCall> = toolCallChannel.receiveAsFlow()
    val final: Deferred<QvacCompletionFinal> = result

    suspend fun text(): String = final.await().text
    suspend fun stats(): QvacCompletionStats? = final.await().stats
    suspend fun toolCalls(): List<QvacToolCall> = final.await().toolCalls

    suspend fun cancel(clearCache: Boolean = false): Boolean {
        val response = client.cancel(
            CancelRequest.Request(CancelRequestRequest(
                clearCache = clearCache,
                requestId = requestId,
                type = "cancel",
            )),
        )
        return response.success && (response.cancelled ?: 0) > 0
    }
}

fun QvacCompletion.run(
    modelId: String,
    history: List<QvacMessage>,
    tools: List<QvacTool> = emptyList(),
    options: QvacCompletionOptions = QvacCompletionOptions(),
): QvacCompletionRun {
    require(tools.isEmpty() || options.responseFormat == null) {
        "Tools and structured responseFormat cannot be used together"
    }
    val handlers = tools.mapNotNull { tool -> tool.handler?.let { tool.name to it } }.toMap()
    val request = CompletionStreamRequest(
        captureThinking = options.captureThinking,
        emitRawDeltas = options.emitRawDeltas,
        generationParams = options.generation.toJson(),
        history = history.map(QvacMessage::toJson),
        kvCache = options.kvCache,
        modelId = modelId,
        requestId = options.requestId,
        responseFormat = options.responseFormat?.toJson(),
        stream = options.stream,
        toolDialect = options.toolDialect,
        tools = tools.takeIf { it.isNotEmpty() }?.map(QvacTool::toJson),
        type = "completionStream",
    )
    return startRun(options.requestId, handlers) { emit ->
        val events = mutableListOf<QvacCompletionEvent>()
        var terminal: QvacCompletionFinal? = null
        client.completionStream(request).collect { response ->
            response.events.map(::parseCompletionEvent).forEach { event ->
                events += event
                emit(event)
            }
            if (response.done == true) {
                terminal = finishCompletion(options.requestId, events, handlers)
            }
        }
        terminal ?: finishCompletion(options.requestId, events, handlers)
    }
}

/**
 * Runs the worker-owned multi-turn tool loop. Each tool must have a local handler;
 * callback results are sent through the duplex request stream and generation resumes.
 */
fun QvacCompletion.orchestrate(
    modelId: String,
    history: List<QvacMessage>,
    tools: List<QvacTool>,
    maxToolTurns: Int = 8,
    options: QvacCompletionOptions = QvacCompletionOptions(),
): QvacCompletionRun {
    require(tools.isNotEmpty()) { "At least one tool is required for orchestration" }
    require(maxToolTurns in 1..32) { "maxToolTurns must be between 1 and 32" }
    val handlers = tools.associate { tool ->
        tool.name to (tool.handler
            ?: throw IllegalArgumentException("Tool '${tool.name}' requires a handler"))
    }
    val request = CompletionOrchestrateRequest(
        captureThinking = options.captureThinking,
        emitRawDeltas = options.emitRawDeltas,
        generationParams = options.generation.toJson(),
        history = history.map(QvacMessage::toJson),
        kvCache = options.kvCache,
        maxToolTurns = maxToolTurns.toLong(),
        modelId = modelId,
        requestId = options.requestId,
        responseFormat = options.responseFormat?.toJson(),
        stream = options.stream,
        toolDialect = options.toolDialect,
        tools = tools.map(QvacTool::toJson),
        type = "completionOrchestrate",
    )
    val upstream = Channel<ByteArray>(Channel.UNLIMITED)
    return startRun(options.requestId, handlers) { emit ->
        var currentTurn: Long? = null
        var turnEvents = mutableListOf<QvacCompletionEvent>()
        var terminalStopReason: String? = null
        try {
            client.completionOrchestrate(request, upstream.receiveAsFlow()).collect { frame ->
                frame.turn?.let { turn ->
                    if (currentTurn != turn) {
                        currentTurn = turn
                        turnEvents = mutableListOf()
                    }
                }
                frame.events.orEmpty().map(::parseCompletionEvent).forEach { event ->
                    turnEvents += event
                    emit(event)
                }
                frame.toolCallback?.let { callback ->
                    val callId = callback["callId"]?.jsonPrimitive?.content
                        ?: throw QvacCompletionException("Worker tool callback omitted callId")
                    val name = callback["name"]?.jsonPrimitive?.content
                        ?: throw QvacCompletionException("Worker tool callback omitted name")
                    val arguments = callback["arguments"]?.jsonObject ?: JsonObject(emptyMap())
                    val reply = try {
                        buildJsonObject {
                            put("callId", callId)
                            put("result", handlers.getValue(name)(arguments))
                        }
                    } catch (error: Throwable) {
                        buildJsonObject {
                            put("callId", callId)
                            put("error", error.message ?: error::class.simpleName ?: "Tool failed")
                        }
                    }
                    upstream.send((reply.toString() + "\n").encodeToByteArray())
                }
                if (frame.done == true) terminalStopReason = frame.stopReason
            }
        } finally {
            upstream.close()
        }
        finishCompletion(options.requestId, turnEvents, handlers, terminalStopReason)
    }
}

private fun QvacCompletion.startRun(
    requestId: String,
    handlers: Map<String, QvacToolHandler>,
    pump: suspend (suspend (QvacCompletionEvent) -> Unit) -> QvacCompletionFinal,
): QvacCompletionRun {
    val eventChannel = Channel<QvacCompletionEvent>(Channel.UNLIMITED)
    val tokenChannel = Channel<String>(Channel.UNLIMITED)
    val toolChannel = Channel<QvacToolCall>(Channel.UNLIMITED)
    val result = CompletableDeferred<QvacCompletionFinal>()
    val run = QvacCompletionRun(requestId, client, eventChannel, tokenChannel, toolChannel, result)
    client.scope.launch {
        try {
            val final = pump { event ->
                eventChannel.send(event)
                when (event) {
                    is QvacCompletionEvent.ContentDelta -> tokenChannel.send(event.text)
                    is QvacCompletionEvent.ToolCallEvent -> toolChannel.send(
                        event.call.withHandler(handlers[event.call.name]),
                    )
                    else -> Unit
                }
            }
            if (final.stopReason == "cancelled") {
                result.completeExceptionally(QvacCompletionCancelledException(requestId, final))
            } else {
                result.complete(final)
            }
        } catch (error: Throwable) {
            result.completeExceptionally(error)
            eventChannel.close(error)
            tokenChannel.close(error)
            toolChannel.close(error)
            return@launch
        }
        eventChannel.close()
        tokenChannel.close()
        toolChannel.close()
    }
    return run
}

private fun QvacToolCall.withHandler(handler: QvacToolHandler?) =
    QvacToolCall(id, name, arguments, raw, handler)

private fun finishCompletion(
    requestId: String,
    events: List<QvacCompletionEvent>,
    handlers: Map<String, QvacToolHandler>,
    terminalStopReason: String? = null,
): QvacCompletionFinal {
    val text = events.filterIsInstance<QvacCompletionEvent.ContentDelta>().joinToString("") { it.text }
    val thinking = events.filterIsInstance<QvacCompletionEvent.ThinkingDelta>()
        .joinToString("") { it.text }.ifEmpty { null }
    val calls = events.filterIsInstance<QvacCompletionEvent.ToolCallEvent>()
        .map { it.call.withHandler(handlers[it.call.name]) }
    val stats = events.filterIsInstance<QvacCompletionEvent.Stats>().lastOrNull()?.value
    val done = events.filterIsInstance<QvacCompletionEvent.Done>().lastOrNull()
    if (done?.error != null) throw QvacCompletionException(done.error)
    val raw = done?.rawFullText ?: text
    val stopReason = terminalStopReason ?: done?.stopReason
    val final = QvacCompletionFinal(
        text = text,
        thinking = thinking,
        toolCalls = calls,
        stats = stats,
        rawFullText = raw,
        cacheableAssistantContent = raw.normalizeAssistantCacheContent().takeIf { calls.isEmpty() },
        stopReason = stopReason,
    )
    if (stopReason == "cancelled") return final
    if (events.isEmpty()) {
        throw QvacCompletionException("Completion '$requestId' ended without events")
    }
    return final
}

private fun parseCompletionEvent(element: JsonElement): QvacCompletionEvent {
    val payload = element.jsonObject
    val sequence = payload["seq"]?.jsonPrimitive?.longOrNull ?: 0L
    return when (payload["type"]?.jsonPrimitive?.contentOrNull) {
        "contentDelta" -> QvacCompletionEvent.ContentDelta(sequence, payload.text())
        "rawDelta" -> QvacCompletionEvent.RawDelta(sequence, payload.text())
        "thinkingDelta" -> QvacCompletionEvent.ThinkingDelta(sequence, payload.text())
        "toolCall" -> {
            val call = payload["call"]?.jsonObject ?: JsonObject(emptyMap())
            QvacCompletionEvent.ToolCallEvent(
                sequence,
                QvacToolCall(
                    id = call["id"]?.jsonPrimitive?.content.orEmpty(),
                    name = call["name"]?.jsonPrimitive?.content.orEmpty(),
                    arguments = call["arguments"]?.jsonObject ?: JsonObject(emptyMap()),
                    raw = call["raw"]?.jsonPrimitive?.contentOrNull,
                ),
            )
        }
        "toolError" -> {
            val error = payload["error"]?.jsonObject ?: JsonObject(emptyMap())
            QvacCompletionEvent.ToolError(
                sequence = sequence,
                code = error["code"]?.jsonPrimitive?.content.orEmpty(),
                message = error["message"]?.jsonPrimitive?.content.orEmpty(),
                raw = error["raw"]?.jsonPrimitive?.contentOrNull,
            )
        }
        "completionStats" -> {
            val stats = payload["stats"]?.jsonObject ?: JsonObject(emptyMap())
            QvacCompletionEvent.Stats(sequence, stats.toCompletionStats())
        }
        "completionDone" -> QvacCompletionEvent.Done(
            sequence = sequence,
            stopReason = payload["stopReason"]?.jsonPrimitive?.contentOrNull,
            error = payload["error"]?.jsonObject?.get("message")?.jsonPrimitive?.contentOrNull,
            rawFullText = payload["raw"]?.jsonObject?.get("fullText")?.jsonPrimitive?.contentOrNull,
        )
        else -> QvacCompletionEvent.Unknown(sequence, payload)
    }
}

private fun JsonObject.text() = get("text")?.jsonPrimitive?.content.orEmpty()

private fun JsonObject.toCompletionStats() = QvacCompletionStats(
    timeToFirstToken = get("timeToFirstToken")?.jsonPrimitive?.doubleOrNull,
    tokensPerSecond = get("tokensPerSecond")?.jsonPrimitive?.doubleOrNull,
    cacheTokens = get("cacheTokens")?.jsonPrimitive?.doubleOrNull,
    promptTokens = get("promptTokens")?.jsonPrimitive?.doubleOrNull,
    generatedTokens = get("generatedTokens")?.jsonPrimitive?.doubleOrNull,
    emittedTokens = get("emittedTokens")?.jsonPrimitive?.doubleOrNull,
    averageConcurrentSequences = get("avgConcurrentSeq")?.jsonPrimitive?.doubleOrNull,
    backendDevice = get("backendDevice")?.jsonPrimitive?.contentOrNull,
    raw = this,
)

private fun String.normalizeAssistantCacheContent(): String {
    return replace(Regex("<think>[\\s\\S]*?</think>", RegexOption.IGNORE_CASE), "")
        .replace(Regex("<think>[\\s\\S]*$", RegexOption.IGNORE_CASE), "")
        .trim()
}

fun qvacRequestId(): String {
    val bytes = Random.Default.nextBytes(16)
    bytes[6] = ((bytes[6].toInt() and 0x0f) or 0x40).toByte()
    bytes[8] = ((bytes[8].toInt() and 0x3f) or 0x80).toByte()
    val hex = bytes.joinToString("") { (it.toInt() and 0xff).toString(16).padStart(2, '0') }
    return "${hex.substring(0, 8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}-" +
        "${hex.substring(16, 20)}-${hex.substring(20)}"
}
