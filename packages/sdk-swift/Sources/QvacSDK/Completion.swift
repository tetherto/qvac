import Foundation

public struct QvacAttachment: Sendable, Hashable {
    public let path: String

    public init(path: String) {
        self.path = path
    }
}

/// One ordered piece of a user turn. A media part keeps its place next to the
/// text that refers to it; attachments are always sent before the text.
public enum QvacContentPart: Sendable, Hashable {
    case text(String)
    case media(path: String)
}

/// A history entry, made with the factory for its role.
public struct QvacMessage: Sendable {
    public let role: String
    public let content: String
    public let attachments: [QvacAttachment]
    public let toolCalls: [QvacToolCall]
    public let toolCallId: String?
    public let toolName: String?
    public let parts: [QvacContentPart]

    private init(
        role: String,
        content: String,
        attachments: [QvacAttachment] = [],
        toolCalls: [QvacToolCall] = [],
        toolCallId: String? = nil,
        toolName: String? = nil,
        parts: [QvacContentPart] = []
    ) {
        self.role = role
        self.content = content
        self.attachments = attachments
        self.toolCalls = toolCalls
        self.toolCallId = toolCallId
        self.toolName = toolName
        self.parts = parts
    }

    public static func system(_ content: String) -> QvacMessage {
        QvacMessage(role: "system", content: content)
    }

    public static func user(_ content: String, attachments: [QvacAttachment] = []) -> QvacMessage {
        QvacMessage(role: "user", content: content, attachments: attachments)
    }

    public static func user(parts: [QvacContentPart]) -> QvacMessage {
        QvacMessage(role: "user", content: "", parts: parts)
    }

    public static func assistant(_ content: String, toolCalls: [QvacToolCall] = []) -> QvacMessage {
        QvacMessage(role: "assistant", content: content, toolCalls: toolCalls)
    }

    public static func tool(_ content: String, toolCallId: String? = nil, toolName: String? = nil) -> QvacMessage {
        QvacMessage(role: "tool", content: content, toolCallId: toolCallId, toolName: toolName)
    }
}

public struct QvacGenerationOptions: Sendable, Hashable {
    public var temperature: Double?
    public var topP: Double?
    public var topK: Double?
    /// -1 runs until the model's stop token; -2 runs until the context is full.
    public var predict: Int?
    public var seed: Int?
    public var frequencyPenalty: Double?
    public var presencePenalty: Double?
    public var repeatPenalty: Double?
    public var reasoningBudget: Int?

    public init(
        temperature: Double? = nil,
        topP: Double? = nil,
        topK: Double? = nil,
        predict: Int? = nil,
        seed: Int? = nil,
        frequencyPenalty: Double? = nil,
        presencePenalty: Double? = nil,
        repeatPenalty: Double? = nil,
        reasoningBudget: Int? = nil
    ) {
        self.temperature = temperature
        self.topP = topP
        self.topK = topK
        self.predict = predict
        self.seed = seed
        self.frequencyPenalty = frequencyPenalty
        self.presencePenalty = presencePenalty
        self.repeatPenalty = repeatPenalty
        self.reasoningBudget = reasoningBudget
    }
}

public enum QvacResponseFormat: Sendable, Hashable {
    case text
    case jsonObject
    case jsonSchema(name: String, schema: [String: JSONValue], description: String? = nil, strict: Bool? = nil)
}

/// Per-request KV cache selection: on or off, or a named cache.
public enum QvacKvCache: Sendable, Hashable {
    case enabled(Bool)
    case key(String)
}

public struct QvacCompletionOptions: Sendable {
    public var generation: QvacGenerationOptions
    public var stream: Bool
    public var kvCache: QvacKvCache?
    public var captureThinking: Bool?
    public var emitRawDeltas: Bool?
    public var toolDialect: CompletionStreamRequestToolDialect?
    public var responseFormat: QvacResponseFormat?
    public var requestId: String
    /// Evaluates the prompt without generating an answer; needs an enabled KV cache.
    public var prefill: Bool?
    /// Another caller-managed cache to start this chat from; the model reuses
    /// the prefix it shares with the prompt.
    public var seedFrom: String?
    /// Limits for the built-in `tool_search`, used when a tool sets `deferLoading`.
    public var toolSearch: QvacToolSearchLimits?

    public init(
        generation: QvacGenerationOptions = QvacGenerationOptions(predict: -1),
        stream: Bool = true,
        kvCache: QvacKvCache? = nil,
        captureThinking: Bool? = nil,
        emitRawDeltas: Bool? = nil,
        toolDialect: CompletionStreamRequestToolDialect? = nil,
        responseFormat: QvacResponseFormat? = nil,
        requestId: String = qvacRequestId(),
        prefill: Bool? = nil,
        seedFrom: String? = nil,
        toolSearch: QvacToolSearchLimits? = nil
    ) {
        self.generation = generation
        self.stream = stream
        self.kvCache = kvCache
        self.captureThinking = captureThinking
        self.emitRawDeltas = emitRawDeltas
        self.toolDialect = toolDialect
        self.responseFormat = responseFormat
        self.requestId = requestId
        self.prefill = prefill
        self.seedFrom = seedFrom
        self.toolSearch = toolSearch
    }
}

public enum QvacCompletionEvent: Sendable {
    case contentDelta(sequence: Int, text: String)
    case rawDelta(sequence: Int, text: String)
    case thinkingDelta(sequence: Int, text: String)
    case toolCall(sequence: Int, call: QvacToolCall)
    case toolError(sequence: Int, code: String, message: String, raw: String?)
    case stats(sequence: Int, value: QvacCompletionStats)
    case done(sequence: Int, stopReason: String?, error: String?, rawFullText: String?)
    /// An event this client version does not know, as received.
    case unknown(sequence: Int, payload: [String: JSONValue])
}

public struct QvacCompletionStats: Sendable, Hashable {
    public let timeToFirstToken: Double?
    public let tokensPerSecond: Double?
    public let cacheTokens: Double?
    public let promptTokens: Double?
    public let generatedTokens: Double?
    public let emittedTokens: Double?
    public let averageConcurrentSequences: Double?
    public let backendDevice: String?
    public let raw: [String: JSONValue]
}

public typealias QvacToolHandler = @Sendable (_ arguments: [String: JSONValue]) async throws -> JSONValue

public struct QvacToolCall: Sendable {
    public let id: String
    public let name: String
    public let arguments: [String: JSONValue]
    public let raw: String?
    private let handler: QvacToolHandler?

    public init(id: String, name: String, arguments: [String: JSONValue], raw: String? = nil) {
        self.init(id: id, name: name, arguments: arguments, raw: raw, handler: nil)
    }

    private init(id: String, name: String, arguments: [String: JSONValue], raw: String?, handler: QvacToolHandler?) {
        self.id = id
        self.name = name
        self.arguments = arguments
        self.raw = raw
        self.handler = handler
    }

    /// Whether a tool with this name was given a handler.
    public var canInvoke: Bool { handler != nil }

    /// Runs the handler of the tool this call names with its arguments.
    public func invoke() async throws -> JSONValue {
        guard let handler else { throw QvacCompletionError(message: "No handler registered for tool '\(name)'") }
        return try await handler(arguments)
    }

    func withHandler(_ handler: QvacToolHandler?) -> QvacToolCall {
        QvacToolCall(id: id, name: name, arguments: arguments, raw: raw, handler: handler)
    }
}

public enum QvacToolParameterType: String, Sendable, Hashable {
    case string, number, integer, boolean, object, array
}

public struct QvacToolParameter: Sendable, Hashable {
    public let type: QvacToolParameterType
    public let description: String?
    public let enumValues: [JSONValue]?

    public init(_ type: QvacToolParameterType, description: String? = nil, enumValues: [JSONValue]? = nil) {
        self.type = type
        self.description = description
        self.enumValues = enumValues
    }
}

/// A tool the model may call.
///
/// With `deferLoading` only the name and description reach the prompt, listed
/// under `group` in the catalog of the built-in `tool_search`; the schema is
/// declared once the model has searched for it. Deferred tools need
/// `orchestrate`, where the worker runs the search.
public struct QvacTool: Sendable {
    public let name: String
    public let description: String
    public let parametersSchema: [String: JSONValue]
    public let deferLoading: Bool
    public let group: String?
    public let handler: QvacToolHandler?

    /// A tool with flat parameters.
    public init(
        name: String,
        description: String,
        parameters: [String: QvacToolParameter] = [:],
        required: [String] = [],
        deferLoading: Bool = false,
        group: String? = nil,
        handler: QvacToolHandler? = nil
    ) {
        var properties: [String: JSONValue] = [:]
        for (name, parameter) in parameters {
            var property: [String: JSONValue] = ["type": .string(parameter.type.rawValue)]
            if let description = parameter.description { property["description"] = .string(description) }
            if let values = parameter.enumValues { property["enum"] = .array(values) }
            properties[name] = .object(property)
        }
        var schema: [String: JSONValue] = ["type": .string("object"), "properties": .object(properties)]
        if !required.isEmpty { schema["required"] = .array(required.map(JSONValue.string)) }
        self.init(
            name: name, description: description, schema: schema, deferLoading: deferLoading, group: group,
            handler: handler)
    }

    /// A tool whose parameters are a full JSON Schema object, sent as written,
    /// for nested `properties`, `items`, `anyOf` or `$defs`.
    public init(
        name: String,
        description: String,
        schema: [String: JSONValue],
        deferLoading: Bool = false,
        group: String? = nil,
        handler: QvacToolHandler? = nil
    ) {
        self.name = name
        self.description = description
        self.parametersSchema = schema
        self.deferLoading = deferLoading
        self.group = group
        self.handler = handler
    }

    var wire: CompletionStreamRequestToolsItem {
        CompletionStreamRequestToolsItem(
            name: name, description: description, deferLoading: deferLoading ? true : nil, group: group,
            parameters: parametersSchema)
    }
}

/// How many tool definitions one `tool_search` call loads. `defaultLimit` is
/// used when the model does not ask for a number (3, or `maxLimit` when lower);
/// `maxLimit` is the most one call loads (8). Keep them the same for a whole
/// conversation, as the model is told them at the front of the prompt.
public struct QvacToolSearchLimits: Sendable, Hashable {
    static let defaultMaxLimit = 8

    public let defaultLimit: Int?
    public let maxLimit: Int?

    public init(defaultLimit: Int? = nil, maxLimit: Int? = nil) {
        self.defaultLimit = defaultLimit
        self.maxLimit = maxLimit
    }

    func validated() throws -> CompletionStreamRequestToolSearch {
        if let defaultLimit, defaultLimit < 1 {
            throw QvacCompletionError(message: "toolSearch.defaultLimit must be at least 1")
        }
        if let maxLimit, maxLimit < 1 { throw QvacCompletionError(message: "toolSearch.maxLimit must be at least 1") }
        let effectiveMaxLimit = maxLimit ?? Self.defaultMaxLimit
        if let defaultLimit, defaultLimit > effectiveMaxLimit {
            throw QvacCompletionError(
                message: "toolSearch.defaultLimit (\(defaultLimit)) cannot exceed maxLimit (\(effectiveMaxLimit))")
        }
        return CompletionStreamRequestToolSearch(defaultLimit: defaultLimit, maxLimit: maxLimit)
    }
}

public struct QvacCompletionFinal: Sendable {
    public let text: String
    public let thinking: String?
    public let toolCalls: [QvacToolCall]
    public let stats: QvacCompletionStats?
    public let rawFullText: String
    /// The answer without thinking, to send back as the assistant turn of a
    /// cached chat. Nil when the turn made tool calls.
    public let cacheableAssistantContent: String?
    public let stopReason: String?
}

public struct QvacCompletionError: Error, Sendable, CustomStringConvertible {
    public let message: String

    public var description: String { message }
}

/// The completion was cancelled; `partial` holds what was generated before.
public struct QvacCompletionCancelledError: Error, Sendable, CustomStringConvertible {
    public let requestId: String
    public let partial: QvacCompletionFinal

    public var description: String { "Completion '\(requestId)' was cancelled" }
}

/// One running completion. Read `events`, `tokens` or `toolCallEvents` as it
/// generates, or wait for `final`. Each stream buffers what has not been read.
public final class QvacCompletionRun: Sendable {
    public let requestId: String
    public let events: AsyncThrowingStream<QvacCompletionEvent, Error>
    public let tokens: AsyncThrowingStream<String, Error>
    public let toolCallEvents: AsyncThrowingStream<QvacToolCall, Error>
    private let result: Task<QvacCompletionFinal, Error>
    private let client: QvacClient

    init(
        requestId: String,
        client: QvacClient,
        pump: @escaping @Sendable (_ emit: @escaping @Sendable (QvacCompletionEvent) -> Void) async throws
            -> QvacCompletionFinal
    ) {
        self.requestId = requestId
        self.client = client
        let (events, eventSink) = AsyncThrowingStream<QvacCompletionEvent, Error>.makeStream()
        let (tokens, tokenSink) = AsyncThrowingStream<String, Error>.makeStream()
        let (toolCalls, toolCallSink) = AsyncThrowingStream<QvacToolCall, Error>.makeStream()
        self.events = events
        self.tokens = tokens
        self.toolCallEvents = toolCalls
        result = Task {
            let final: QvacCompletionFinal
            do {
                final = try await pump { event in
                    eventSink.yield(event)
                    switch event {
                    case .contentDelta(_, let text): tokenSink.yield(text)
                    case .toolCall(_, let call): toolCallSink.yield(call)
                    default: break
                    }
                }
            } catch {
                eventSink.finish(throwing: error)
                tokenSink.finish(throwing: error)
                toolCallSink.finish(throwing: error)
                throw error
            }
            eventSink.finish()
            tokenSink.finish()
            toolCallSink.finish()
            if final.stopReason == "cancelled" {
                throw QvacCompletionCancelledError(requestId: requestId, partial: final)
            }
            return final
        }
    }

    public var final: QvacCompletionFinal {
        get async throws { try await result.value }
    }

    public func text() async throws -> String { try await final.text }

    public func stats() async throws -> QvacCompletionStats? { try await final.stats }

    public func toolCalls() async throws -> [QvacToolCall] { try await final.toolCalls }

    /// Asks the worker to stop this completion. True when it was still running.
    public func cancel(clearCache: Bool = false) async throws -> Bool {
        let reply = try await client.cancel(.request(CancelRequestRequest(requestId: requestId, clearCache: clearCache)))
        return reply.success && (reply.cancelled ?? 0) > 0
    }
}

public struct QvacCompletion: Sendable {
    let client: QvacClient

    public func stream(_ request: CompletionStreamRequest) -> AsyncThrowingStream<CompletionStreamResponse, Error> {
        client.completionStream(request)
    }

    /// The answer text of each frame. Raw and thinking deltas are left out.
    public func text(_ request: CompletionStreamRequest) -> AsyncThrowingStream<String, Error> {
        client.streamTyped(request, map: { (response: CompletionStreamResponse) in
            response.events.compactMap { event -> String? in
                if case .contentDelta(let delta) = event { return delta.text }
                return nil
            }.joined()
        })
    }

    public func batch(_ request: BatchCompletionStreamRequest)
        -> AsyncThrowingStream<BatchCompletionStreamResponse, Error>
    {
        client.batchCompletionStream(request)
    }

    /// Runs one completion turn. A tool call it returns can be run with
    /// `invoke()` when its tool has a handler. Deferred tools need `orchestrate`.
    public func run(
        modelId: String,
        history: [QvacMessage],
        tools: [QvacTool] = [],
        options: QvacCompletionOptions = QvacCompletionOptions()
    ) throws -> QvacCompletionRun {
        let toolSearch = try validate(options, tools: tools)
        let request = CompletionStreamRequest(
            history: history.map(\.wire),
            modelId: modelId,
            kvCache: options.kvCache?.wire,
            prefill: options.prefill,
            seedFrom: options.seedFrom,
            tools: tools.isEmpty ? nil : tools.map(\.wire),
            toolSearch: toolSearch,
            stream: options.stream,
            generationParams: options.generation.wire,
            captureThinking: options.captureThinking,
            emitRawDeltas: options.emitRawDeltas,
            toolDialect: options.toolDialect,
            responseFormat: options.responseFormat?.wire,
            requestId: options.requestId)
        let handlers = toolHandlers(tools)
        let client = client
        let requestId = options.requestId
        return QvacCompletionRun(requestId: requestId, client: client) { emit in
            var events: [QvacCompletionEvent] = []
            var terminal: QvacCompletionFinal?
            let frames: AsyncThrowingStream<[String: JSONValue], Error> = client.streamTyped(request, map: { $0 })
            for try await frame in frames {
                for event in try completionEvents(frame, handlers) {
                    events.append(event)
                    emit(event)
                }
                if frame["done"] == .bool(true) {
                    terminal = try finishCompletion(requestId, events)
                }
            }
            return try terminal ?? finishCompletion(requestId, events)
        }
    }

    /// Runs the multi-turn tool loop on the worker. Each tool needs a handler;
    /// the worker calls it for each tool call and goes on generating with its
    /// result. The events, tokens and final result are those of the last turn.
    public func orchestrate(
        modelId: String,
        history: [QvacMessage],
        tools: [QvacTool],
        maxToolTurns: Int = 8,
        options: QvacCompletionOptions = QvacCompletionOptions()
    ) throws -> QvacCompletionRun {
        guard !tools.isEmpty else { throw QvacCompletionError(message: "At least one tool is required for orchestration") }
        guard (1...32).contains(maxToolTurns) else {
            throw QvacCompletionError(message: "maxToolTurns must be between 1 and 32")
        }
        if let tool = tools.first(where: { $0.handler == nil }) {
            throw QvacCompletionError(message: "Tool '\(tool.name)' requires a handler")
        }
        let toolSearch = try validate(options, tools: tools)
        let request = CompletionOrchestrateRequest(
            history: history.map(\.wire),
            modelId: modelId,
            kvCache: options.kvCache?.wire,
            prefill: options.prefill,
            seedFrom: options.seedFrom,
            tools: tools.map(\.wire),
            toolSearch: toolSearch,
            stream: options.stream,
            generationParams: options.generation.wire,
            captureThinking: options.captureThinking,
            emitRawDeltas: options.emitRawDeltas,
            toolDialect: options.toolDialect,
            responseFormat: options.responseFormat?.wire,
            requestId: options.requestId,
            maxToolTurns: maxToolTurns)
        let handlers = toolHandlers(tools)
        let client = client
        let requestId = options.requestId
        return QvacCompletionRun(requestId: requestId, client: client) { emit in
            let (replies, upstream) = AsyncStream<Data>.makeStream()
            defer { upstream.finish() }
            var turn: JSONValue?
            var turnEvents: [QvacCompletionEvent] = []
            var stopReason: String?
            let frames: AsyncThrowingStream<[String: JSONValue], Error> =
                client.duplexTyped(request, input: replies, map: { $0 })
            for try await frame in frames {
                if let frameTurn = frame["turn"], frameTurn != turn {
                    turn = frameTurn
                    turnEvents = []
                }
                for event in try completionEvents(frame, handlers) {
                    turnEvents.append(event)
                    emit(event)
                }
                if let callback = frame["toolCallback"] {
                    upstream.yield(try await toolReply(callback, handlers))
                }
                if frame["done"] == .bool(true) {
                    stopReason = frame["stopReason"]?.stringValue
                }
            }
            return try finishCompletion(requestId, turnEvents, terminalStopReason: stopReason)
        }
    }
}

private func validate(_ options: QvacCompletionOptions, tools: [QvacTool]) throws
    -> CompletionStreamRequestToolSearch?
{
    if !tools.isEmpty, let format = options.responseFormat, format != .text {
        throw QvacCompletionError(message: "Tools and a structured responseFormat cannot be used together")
    }
    if case .key(let key) = options.kvCache, key.isEmpty {
        throw QvacCompletionError(message: "KV cache key cannot be empty")
    }
    return try options.toolSearch?.validated()
}

private func toolHandlers(_ tools: [QvacTool]) -> [String: QvacToolHandler] {
    var handlers: [String: QvacToolHandler] = [:]
    for tool in tools {
        if let handler = tool.handler { handlers[tool.name] = handler }
    }
    return handlers
}

/// The JSON line answering a tool callback of the worker: the handler's result,
/// or its error.
private func toolReply(_ callback: JSONValue, _ handlers: [String: QvacToolHandler]) async throws -> Data {
    let request: CompletionOrchestrateResponseToolCallback
    do {
        request = try callback.decoded(as: CompletionOrchestrateResponseToolCallback.self)
    } catch {
        throw QvacCompletionError(message: "Worker sent a malformed tool callback: \(error)")
    }
    var reply: [String: JSONValue] = ["callId": .string(request.callId)]
    do {
        guard let handler = handlers[request.name] else {
            throw QvacCompletionError(message: "No handler registered for tool '\(request.name)'")
        }
        reply["result"] = try await handler(request.arguments)
    } catch {
        reply["error"] = .string(String(describing: error))
    }
    return try encodeForWorker(reply) + Data("\n".utf8)
}

public func qvacRequestId() -> String {
    UUID().uuidString.lowercased()
}

private let knownCompletionEventTypes: Set<String> = [
    "contentDelta", "rawDelta", "thinkingDelta", "toolCall", "toolError", "completionStats", "completionDone",
]

/// The events of a frame, with each tool call given the handler of its tool.
func completionEvents(_ frame: [String: JSONValue], _ handlers: [String: QvacToolHandler]) throws
    -> [QvacCompletionEvent]
{
    guard case .array(let items) = frame["events"] else { return [] }
    return try items.map { item in
        let event = try completionEvent(item)
        if case .toolCall(let sequence, let call) = event {
            return .toolCall(sequence: sequence, call: call.withHandler(handlers[call.name]))
        }
        return event
    }
}

private func completionEvent(_ value: JSONValue) throws -> QvacCompletionEvent {
    guard case .object(let payload) = value else {
        throw QvacCompletionError(message: "Worker sent a completion event that is not an object")
    }
    let type = payload["type"]?.stringValue
    let sequence = payload["seq"]?.numberValue.map { Int($0) } ?? 0
    guard let type, knownCompletionEventTypes.contains(type) else {
        return .unknown(sequence: sequence, payload: payload)
    }
    let event: CompletionStreamResponseEventsItem
    do {
        event = try value.decoded(as: CompletionStreamResponseEventsItem.self)
    } catch {
        throw QvacCompletionError(message: "Worker sent a malformed '\(type)' event: \(error)")
    }
    switch event {
    case .contentDelta(let delta):
        return .contentDelta(sequence: delta.seq, text: delta.text)
    case .rawDelta(let delta):
        return .rawDelta(sequence: delta.seq, text: delta.text)
    case .thinkingDelta(let delta):
        return .thinkingDelta(sequence: delta.seq, text: delta.text)
    case .toolCall(let call):
        return .toolCall(
            sequence: call.seq,
            call: QvacToolCall(id: call.call.id, name: call.call.name, arguments: call.call.arguments, raw: call.call.raw))
    case .toolError(let failure):
        return .toolError(
            sequence: failure.seq, code: failure.error.code.rawValue, message: failure.error.message,
            raw: failure.error.raw)
    case .completionStats(let stats):
        guard case .object(let raw) = payload["stats"] else {
            throw QvacCompletionError(message: "Worker sent completion stats that are not an object")
        }
        let value = stats.stats
        return .stats(
            sequence: stats.seq,
            value: QvacCompletionStats(
                timeToFirstToken: value.timeToFirstToken,
                tokensPerSecond: value.tokensPerSecond,
                cacheTokens: value.cacheTokens,
                promptTokens: value.promptTokens,
                generatedTokens: value.generatedTokens,
                emittedTokens: value.emittedTokens,
                averageConcurrentSequences: value.avgConcurrentSeq,
                backendDevice: value.backendDevice?.rawValue,
                raw: raw))
    case .completionDoneError(let done):
        return .done(
            sequence: done.seq, stopReason: done.stopReason, error: done.error.message, rawFullText: done.raw?.fullText)
    case .completionDone(let done):
        return .done(
            sequence: done.seq, stopReason: done.stopReason?.rawValue, error: nil, rawFullText: done.raw?.fullText)
    }
}

func finishCompletion(
    _ requestId: String,
    _ events: [QvacCompletionEvent],
    terminalStopReason: String? = nil
) throws -> QvacCompletionFinal {
    var text = ""
    var thinking = ""
    var calls: [QvacToolCall] = []
    var stats: QvacCompletionStats?
    var done: (stopReason: String?, error: String?, rawFullText: String?)?
    for event in events {
        switch event {
        case .contentDelta(_, let delta): text += delta
        case .thinkingDelta(_, let delta): thinking += delta
        case .toolCall(_, let call): calls.append(call)
        case .stats(_, let value): stats = value
        case .done(_, let stopReason, let error, let rawFullText): done = (stopReason, error, rawFullText)
        default: break
        }
    }
    if let error = done?.error { throw QvacCompletionError(message: error) }
    let raw = done?.rawFullText ?? text
    let stopReason = terminalStopReason ?? done?.stopReason
    let final = QvacCompletionFinal(
        text: text,
        thinking: thinking.isEmpty ? nil : thinking,
        toolCalls: calls,
        stats: stats,
        rawFullText: raw,
        cacheableAssistantContent: calls.isEmpty ? withoutThinking(raw) : nil,
        stopReason: stopReason)
    if stopReason != "cancelled", events.isEmpty {
        throw QvacCompletionError(message: "Completion '\(requestId)' ended without events")
    }
    return final
}

private func withoutThinking(_ text: String) -> String {
    text.replacingOccurrences(of: "<think>[\\s\\S]*?</think>", with: "", options: [.regularExpression, .caseInsensitive])
        .replacingOccurrences(of: "<think>[\\s\\S]*$", with: "", options: [.regularExpression, .caseInsensitive])
        .trimmingCharacters(in: .whitespacesAndNewlines)
}

extension QvacMessage {
    var wire: CompletionStreamRequestHistoryItem {
        CompletionStreamRequestHistoryItem(
            role: role,
            content: parts.isEmpty ? .variant1(content) : .variant2(parts.map(\.wire)),
            attachments: attachments.isEmpty ? nil : attachments.map { .init(path: $0.path) },
            toolCalls: toolCalls.isEmpty
                ? nil : toolCalls.map { .init(id: $0.id, name: $0.name, arguments: $0.arguments) },
            toolCallId: toolCallId,
            toolName: toolName)
    }
}

extension QvacContentPart {
    var wire: CompletionStreamRequestHistoryItemContentVariant2Item {
        switch self {
        case .text(let text):
            .completionStreamRequestHistoryItemContentItemText(.init(text: text))
        case .media(let path):
            .completionStreamRequestHistoryItemContentItemMedia(.init(path: path))
        }
    }
}

extension QvacGenerationOptions {
    var wire: CompletionStreamRequestGenerationParams {
        CompletionStreamRequestGenerationParams(
            temp: temperature,
            top_p: topP,
            top_k: topK,
            predict: predict.map(Double.init),
            seed: seed.map(Double.init),
            frequency_penalty: frequencyPenalty,
            presence_penalty: presencePenalty,
            repeat_penalty: repeatPenalty,
            reasoning_budget: reasoningBudget)
    }
}

extension QvacKvCache {
    var wire: CompletionStreamRequestKvCache {
        switch self {
        case .enabled(let enabled): .variant1(enabled)
        case .key(let key): .variant2(key)
        }
    }
}

extension QvacResponseFormat {
    var wire: CompletionStreamRequestResponseFormat {
        switch self {
        case .text:
            .text(.init())
        case .jsonObject:
            .jsonObject(.init())
        case .jsonSchema(let name, let schema, let description, let strict):
            .jsonSchema(.init(json_schema: .init(name: name, description: description, schema: schema, strict: strict)))
        }
    }
}

extension JSONValue {
    func decoded<T: Decodable>(as type: T.Type) throws -> T {
        try JSONDecoder().decode(type, from: JSONEncoder().encode(self))
    }
}
