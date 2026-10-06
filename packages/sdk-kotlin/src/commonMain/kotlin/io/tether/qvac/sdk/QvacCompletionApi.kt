package io.tether.qvac.sdk

import io.tether.qvac.sdk.generated.schema.CancelRequest
import io.tether.qvac.sdk.generated.schema.CancelRequestRequest
import io.tether.qvac.sdk.generated.schema.CompletionOrchestrateRequest
import io.tether.qvac.sdk.generated.schema.CompletionOrchestrateRequestGenerationParams
import io.tether.qvac.sdk.generated.schema.CompletionOrchestrateRequestHistoryItem
import io.tether.qvac.sdk.generated.schema.CompletionOrchestrateRequestHistoryItemAttachmentsItem
import io.tether.qvac.sdk.generated.schema.CompletionOrchestrateRequestKvCache
import io.tether.qvac.sdk.generated.schema.CompletionOrchestrateRequestResponseFormat
import io.tether.qvac.sdk.generated.schema.CompletionOrchestrateRequestResponseFormatJsonObject
import io.tether.qvac.sdk.generated.schema.CompletionOrchestrateRequestResponseFormatJsonSchema
import io.tether.qvac.sdk.generated.schema.CompletionOrchestrateRequestResponseFormatJsonSchemaJsonSchema
import io.tether.qvac.sdk.generated.schema.CompletionOrchestrateRequestResponseFormatText
import io.tether.qvac.sdk.generated.schema.CompletionOrchestrateRequestToolDialect
import io.tether.qvac.sdk.generated.schema.CompletionOrchestrateRequestToolsItem
import io.tether.qvac.sdk.generated.schema.CompletionOrchestrateRequestToolsItemParameters
import io.tether.qvac.sdk.generated.schema.CompletionOrchestrateRequestToolsItemParametersPropertiesValue
import io.tether.qvac.sdk.generated.schema.CompletionOrchestrateRequestToolsItemParametersPropertiesValueType
import io.tether.qvac.sdk.generated.schema.CompletionOrchestrateResponseToolCallback
import io.tether.qvac.sdk.generated.schema.CompletionStreamRequest
import io.tether.qvac.sdk.generated.schema.CompletionStreamRequestGenerationParams
import io.tether.qvac.sdk.generated.schema.CompletionStreamRequestHistoryItem
import io.tether.qvac.sdk.generated.schema.CompletionStreamRequestHistoryItemAttachmentsItem
import io.tether.qvac.sdk.generated.schema.CompletionStreamRequestResponseFormat
import io.tether.qvac.sdk.generated.schema.CompletionStreamRequestResponseFormatJsonObject
import io.tether.qvac.sdk.generated.schema.CompletionStreamRequestResponseFormatJsonSchema
import io.tether.qvac.sdk.generated.schema.CompletionStreamRequestResponseFormatJsonSchemaJsonSchema
import io.tether.qvac.sdk.generated.schema.CompletionStreamRequestResponseFormatText
import io.tether.qvac.sdk.generated.schema.CompletionStreamRequestToolDialect
import io.tether.qvac.sdk.generated.schema.CompletionStreamRequestToolsItem
import io.tether.qvac.sdk.generated.schema.CompletionStreamRequestToolsItemParameters
import io.tether.qvac.sdk.generated.schema.CompletionStreamRequestToolsItemParametersPropertiesValue
import io.tether.qvac.sdk.generated.schema.CompletionStreamRequestToolsItemParametersPropertiesValueType
import io.tether.qvac.sdk.generated.schema.CompletionStreamResponseEventsItem
import io.tether.qvac.sdk.generated.schema.CompletionStreamResponseEventsItemCompletionStatsStats
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import kotlin.random.Random

data class QvacAttachment(val path: String)

data class QvacMessage(
    val role: String,
    val content: String,
    val attachments: List<QvacAttachment> = emptyList(),
) {
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
)

sealed interface QvacResponseFormat {
    data object Text : QvacResponseFormat

    data object JsonValue : QvacResponseFormat

    data class JsonSchema(
        val name: String,
        val schema: JsonObject,
        val description: String? = null,
        val strict: Boolean? = null,
    ) : QvacResponseFormat
}

/** Per-request KV cache selection: on/off, or a named cache. */
sealed interface QvacKvCache {
    data class Enabled(val enabled: Boolean) : QvacKvCache

    data class Key(val key: String) : QvacKvCache {
        init {
            require(key.isNotEmpty()) { "KV cache key cannot be empty" }
        }
    }
}

enum class QvacToolParameterType {
    STRING, NUMBER, INTEGER, BOOLEAN, OBJECT, ARRAY,
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
)

data class QvacCompletionOptions(
    val generation: QvacGenerationOptions = QvacGenerationOptions(predict = -1),
    val stream: Boolean = true,
    val kvCache: QvacKvCache? = null,
    val captureThinking: Boolean? = null,
    val emitRawDeltas: Boolean? = null,
    /** Worker tool-call dialect name, e.g. "hermes" or "qwen35". */
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
    /** An event this client version does not know; [payload] is the event as received. */
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
            CancelRequest.Request(CancelRequestRequest(clearCache = clearCache, requestId = requestId)),
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
        generationParams = options.generation.toStreamParams(),
        history = history.map { it.toStreamItem() },
        kvCache = options.kvCache?.toWire(),
        modelId = modelId,
        requestId = options.requestId,
        responseFormat = options.responseFormat?.toStreamFormat(),
        stream = options.stream,
        toolDialect = options.toolDialect?.let { wireEnum<CompletionStreamRequestToolDialect>("toolDialect", it) },
        tools = tools.takeIf { it.isNotEmpty() }?.map { it.toStreamTool() },
    )
    return startRun(options.requestId, handlers) { emit ->
        val events = mutableListOf<QvacCompletionEvent>()
        var terminal: QvacCompletionFinal? = null
        client.streamEncoded(request).collect { frame ->
            frame.events().map { client.parseCompletionEvent(it) }.forEach { event ->
                events += event
                emit(event)
            }
            if (frame["done"]?.jsonPrimitive?.booleanOrNull == true) {
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
        generationParams = options.generation.toOrchestrateParams(),
        history = history.map { it.toOrchestrateItem() },
        kvCache = options.kvCache?.toWire(),
        maxToolTurns = maxToolTurns.toLong(),
        modelId = modelId,
        requestId = options.requestId,
        responseFormat = options.responseFormat?.toOrchestrateFormat(),
        stream = options.stream,
        toolDialect = options.toolDialect?.let { wireEnum<CompletionOrchestrateRequestToolDialect>("toolDialect", it) },
        tools = tools.map { it.toOrchestrateTool() },
    )
    val upstream = Channel<ByteArray>(Channel.UNLIMITED)
    return startRun(options.requestId, handlers) { emit ->
        var currentTurn: Long? = null
        var turnEvents = mutableListOf<QvacCompletionEvent>()
        var terminalStopReason: String? = null
        try {
            client.duplexEncoded(request, upstream.receiveAsFlow()).collect { frame ->
                frame["turn"]?.jsonPrimitive?.longOrNull?.let { turn ->
                    if (currentTurn != turn) {
                        currentTurn = turn
                        turnEvents = mutableListOf()
                    }
                }
                frame.events().map { client.parseCompletionEvent(it) }.forEach { event ->
                    turnEvents += event
                    emit(event)
                }
                frame["toolCallback"]?.let { element ->
                    val callback = try {
                        client.json.decodeFromJsonElement<CompletionOrchestrateResponseToolCallback>(element)
                    } catch (error: SerializationException) {
                        throw QvacCompletionException("Worker sent a malformed tool callback", error)
                    }
                    val reply = try {
                        buildJsonObject {
                            put("callId", callback.callId)
                            put("result", handlers.getValue(callback.name)(JsonObject(callback.arguments)))
                        }
                    } catch (error: Throwable) {
                        buildJsonObject {
                            put("callId", callback.callId)
                            put("error", error.message ?: error::class.simpleName ?: "Tool failed")
                        }
                    }
                    upstream.send((reply.toString() + "\n").encodeToByteArray())
                }
                if (frame["done"]?.jsonPrimitive?.booleanOrNull == true) {
                    terminalStopReason = frame["stopReason"]?.jsonPrimitive?.content
                }
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

private fun JsonObject.events(): List<JsonElement> = (get("events") as? JsonArray).orEmpty()

// completionOrchestrate events use the completionStream event schema; the
// contract types differ only in their generated names.
private fun QvacClient.parseCompletionEvent(element: JsonElement): QvacCompletionEvent {
    val payload = element.jsonObject
    val event = try {
        json.decodeFromJsonElement<CompletionStreamResponseEventsItem>(payload)
    } catch (_: SerializationException) {
        return QvacCompletionEvent.Unknown(payload["seq"]?.jsonPrimitive?.longOrNull ?: 0L, payload)
    }
    return when (event) {
        is CompletionStreamResponseEventsItem.ContentDelta ->
            QvacCompletionEvent.ContentDelta(event.value.seq, event.value.text)
        is CompletionStreamResponseEventsItem.RawDelta ->
            QvacCompletionEvent.RawDelta(event.value.seq, event.value.text)
        is CompletionStreamResponseEventsItem.ThinkingDelta ->
            QvacCompletionEvent.ThinkingDelta(event.value.seq, event.value.text)
        is CompletionStreamResponseEventsItem.ToolCall -> QvacCompletionEvent.ToolCallEvent(
            event.value.seq,
            QvacToolCall(
                id = event.value.call.id,
                name = event.value.call.name,
                arguments = JsonObject(event.value.call.arguments),
                raw = event.value.call.raw,
            ),
        )
        is CompletionStreamResponseEventsItem.ToolError -> QvacCompletionEvent.ToolError(
            sequence = event.value.seq,
            code = json.wireName(event.value.error.code),
            message = event.value.error.message,
            raw = event.value.error.raw,
        )
        is CompletionStreamResponseEventsItem.CompletionStats -> QvacCompletionEvent.Stats(
            event.value.seq,
            event.value.stats.toCompletionStats(json, payload.getValue("stats").jsonObject),
        )
        is CompletionStreamResponseEventsItem.CompletionDoneError -> QvacCompletionEvent.Done(
            sequence = event.value.seq,
            stopReason = event.value.stopReason,
            error = event.value.error.message,
            rawFullText = event.value.raw?.fullText,
        )
        is CompletionStreamResponseEventsItem.CompletionDone -> QvacCompletionEvent.Done(
            sequence = event.value.seq,
            stopReason = event.value.stopReason?.let { json.wireName(it) },
            rawFullText = event.value.raw?.fullText,
        )
    }
}

private fun CompletionStreamResponseEventsItemCompletionStatsStats.toCompletionStats(json: Json, raw: JsonObject) =
    QvacCompletionStats(
        timeToFirstToken = timeToFirstToken,
        tokensPerSecond = tokensPerSecond,
        cacheTokens = cacheTokens,
        promptTokens = promptTokens,
        generatedTokens = generatedTokens,
        emittedTokens = emittedTokens,
        averageConcurrentSequences = avgConcurrentSeq,
        backendDevice = backendDevice?.let { json.wireName(it) },
        raw = raw,
    )

private fun QvacMessage.toStreamItem() = CompletionStreamRequestHistoryItem(
    role = role,
    content = content,
    attachments = attachments.takeIf { it.isNotEmpty() }
        ?.map { CompletionStreamRequestHistoryItemAttachmentsItem(path = it.path) },
)

private fun QvacMessage.toOrchestrateItem() = CompletionOrchestrateRequestHistoryItem(
    role = role,
    content = content,
    attachments = attachments.takeIf { it.isNotEmpty() }
        ?.map { CompletionOrchestrateRequestHistoryItemAttachmentsItem(path = it.path) },
)

private fun QvacGenerationOptions.toStreamParams() = CompletionStreamRequestGenerationParams(
    temp = temperature,
    top_p = topP,
    top_k = topK,
    predict = predict?.toDouble(),
    seed = seed?.toDouble(),
    frequency_penalty = frequencyPenalty,
    presence_penalty = presencePenalty,
    repeat_penalty = repeatPenalty,
    reasoning_budget = reasoningBudget,
    remove_thinking_from_context = removeThinkingFromContext,
)

private fun QvacGenerationOptions.toOrchestrateParams() = CompletionOrchestrateRequestGenerationParams(
    temp = temperature,
    top_p = topP,
    top_k = topK,
    predict = predict?.toDouble(),
    seed = seed?.toDouble(),
    frequency_penalty = frequencyPenalty,
    presence_penalty = presencePenalty,
    repeat_penalty = repeatPenalty,
    reasoning_budget = reasoningBudget,
    remove_thinking_from_context = removeThinkingFromContext,
)

private fun QvacKvCache.toWire(): CompletionOrchestrateRequestKvCache = when (this) {
    is QvacKvCache.Enabled -> CompletionOrchestrateRequestKvCache.Variant1(enabled)
    is QvacKvCache.Key -> CompletionOrchestrateRequestKvCache.Variant2(key)
}

private fun QvacResponseFormat.toStreamFormat(): CompletionStreamRequestResponseFormat = when (this) {
    QvacResponseFormat.Text -> CompletionStreamRequestResponseFormat.Text(CompletionStreamRequestResponseFormatText())
    QvacResponseFormat.JsonValue ->
        CompletionStreamRequestResponseFormat.JsonObject(CompletionStreamRequestResponseFormatJsonObject())
    is QvacResponseFormat.JsonSchema -> CompletionStreamRequestResponseFormat.JsonSchema(
        CompletionStreamRequestResponseFormatJsonSchema(
            json_schema = CompletionStreamRequestResponseFormatJsonSchemaJsonSchema(
                name = name,
                description = description,
                schema = schema,
                strict = strict,
            ),
        ),
    )
}

private fun QvacResponseFormat.toOrchestrateFormat(): CompletionOrchestrateRequestResponseFormat = when (this) {
    QvacResponseFormat.Text ->
        CompletionOrchestrateRequestResponseFormat.Text(CompletionOrchestrateRequestResponseFormatText())
    QvacResponseFormat.JsonValue ->
        CompletionOrchestrateRequestResponseFormat.JsonObject(CompletionOrchestrateRequestResponseFormatJsonObject())
    is QvacResponseFormat.JsonSchema -> CompletionOrchestrateRequestResponseFormat.JsonSchema(
        CompletionOrchestrateRequestResponseFormatJsonSchema(
            json_schema = CompletionOrchestrateRequestResponseFormatJsonSchemaJsonSchema(
                name = name,
                description = description,
                schema = schema,
                strict = strict,
            ),
        ),
    )
}

private fun QvacTool.toStreamTool() = CompletionStreamRequestToolsItem(
    name = name,
    description = description,
    parameters = CompletionStreamRequestToolsItemParameters(
        properties = parameters.mapValues { (_, parameter) ->
            CompletionStreamRequestToolsItemParametersPropertiesValue(
                type = when (parameter.type) {
                    QvacToolParameterType.STRING -> CompletionStreamRequestToolsItemParametersPropertiesValueType.STRING
                    QvacToolParameterType.NUMBER -> CompletionStreamRequestToolsItemParametersPropertiesValueType.NUMBER
                    QvacToolParameterType.INTEGER -> CompletionStreamRequestToolsItemParametersPropertiesValueType.INTEGER
                    QvacToolParameterType.BOOLEAN -> CompletionStreamRequestToolsItemParametersPropertiesValueType.BOOLEAN
                    QvacToolParameterType.OBJECT -> CompletionStreamRequestToolsItemParametersPropertiesValueType.OBJECT
                    QvacToolParameterType.ARRAY -> CompletionStreamRequestToolsItemParametersPropertiesValueType.ARRAY
                },
                description = parameter.description,
                enum = parameter.enumValues,
            )
        },
        required = required.takeIf { it.isNotEmpty() }?.toList(),
    ),
)

private fun QvacTool.toOrchestrateTool() = CompletionOrchestrateRequestToolsItem(
    name = name,
    description = description,
    parameters = CompletionOrchestrateRequestToolsItemParameters(
        properties = parameters.mapValues { (_, parameter) ->
            CompletionOrchestrateRequestToolsItemParametersPropertiesValue(
                type = when (parameter.type) {
                    QvacToolParameterType.STRING -> CompletionOrchestrateRequestToolsItemParametersPropertiesValueType.STRING
                    QvacToolParameterType.NUMBER -> CompletionOrchestrateRequestToolsItemParametersPropertiesValueType.NUMBER
                    QvacToolParameterType.INTEGER -> CompletionOrchestrateRequestToolsItemParametersPropertiesValueType.INTEGER
                    QvacToolParameterType.BOOLEAN -> CompletionOrchestrateRequestToolsItemParametersPropertiesValueType.BOOLEAN
                    QvacToolParameterType.OBJECT -> CompletionOrchestrateRequestToolsItemParametersPropertiesValueType.OBJECT
                    QvacToolParameterType.ARRAY -> CompletionOrchestrateRequestToolsItemParametersPropertiesValueType.ARRAY
                },
                description = parameter.description,
                enum = parameter.enumValues,
            )
        },
        required = required.takeIf { it.isNotEmpty() }?.toList(),
    ),
)

/** Maps a wire string onto a generated enum, rejecting values the contract does not list. */
internal inline fun <reified T> wireEnum(field: String, value: String): T = try {
    Json.decodeFromJsonElement<T>(JsonPrimitive(value))
} catch (error: SerializationException) {
    throw IllegalArgumentException("Unknown $field '$value'", error)
}

internal inline fun <reified T> Json.wireName(value: T): String = encodeToJsonElement(value).jsonPrimitive.content

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
