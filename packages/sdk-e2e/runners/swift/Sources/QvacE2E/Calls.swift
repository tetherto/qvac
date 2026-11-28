import Foundation
import QvacSDK

typealias Call = (_ params: Value) async throws -> Value
typealias Fold = (_ params: Value, _ collect: String) async throws -> Value

/// Contract method name -> how this client serves it. Mirrors runners/js/shared/step-bindings.ts so
/// every client returns the same shape; a method missing here makes its test incomplete.
final class Calls: @unchecked Sendable {
    private let wire: Wire
    private let resources: Resources
    private let scratchRoot: URL
    /// Built once in init and never changed, so concurrent started calls read them safely.
    private(set) var calls: [String: Call] = [:]
    private(set) var streams: [String: Fold] = [:]

    init(wire: Wire, resources: Resources, scratchRoot: URL) {
        self.wire = wire
        self.resources = resources
        self.scratchRoot = scratchRoot
        calls = callTable()
        streams = streamTable()
    }

    func close() {
        for session in sessions.withLock({ $0.values }) { session.task?.cancel() }
        for stream in logStreams.withLock({ $0.values }) { stream.task?.cancel() }
    }

    private func incomplete(_ method: String, _ collect: String) -> StepError {
        StepError("collect: \"\(collect)\" is not defined for \(method)", incomplete: true)
    }

    private func require(_ params: Value, _ key: String) throws -> Value {
        let value = params[key]
        if value.isNil { throw StepError("\(key) is required") }
        return value
    }

    private func withRequestId(_ params: Value) -> Value {
        params.merging(["requestId": params["requestId"].or(.string(Wire.requestId()))])
    }

    /// A stream up to and including the frame that says it is done.
    private func frames(_ payload: Value, _ type: String) async throws -> [Value] {
        var collected: [Value] = []
        for try await frame in wire.stream(payload) {
            let ofType = frame["type"].string == type
            if ofType { collected.append(frame) }
            if ofType && frame["done"].isTrue { break }
        }
        return collected
    }

    /// A fold this client does not have is a gap, found before anything is sent.
    private func requireCollect(_ method: String, _ collect: String, _ supported: Set<String>) throws {
        if !supported.contains(collect) { throw incomplete(method, collect) }
    }

    // MARK: completion

    /// `buildFinalFromEvents` from @qvac/inference, field for field.
    private struct Aggregate {
        let final: Value
        let error: Value?
        let cancelled: Bool
    }

    private static let thinkClosed = try! NSRegularExpression(pattern: #"<think>[\s\S]*?</think>"#, options: .caseInsensitive)
    private static let thinkOpen = try! NSRegularExpression(pattern: #"<think>[\s\S]*$"#, options: .caseInsensitive)

    private func aggregate(_ events: [Value]) -> Aggregate {
        var content = ""
        var thinking = ""
        var stats: Value = .null
        var rawFullText: String?
        var error: Value?
        var stopReason: Value = .null
        var cancelled = false
        var toolCalls: [Value] = []
        var toolErrors: [Value] = []
        for event in events {
            switch event["type"].string {
            case "contentDelta": content += event["text"].string ?? ""
            case "thinkingDelta": thinking += event["text"].string ?? ""
            case "completionStats": stats = event["stats"]
            case "toolCall": toolCalls.append(event["call"])
            case "toolError": toolErrors.append(event["error"])
            case "completionDone":
                if event["raw"].object != nil { rawFullText = event["raw"]["fullText"].string }
                if event["stopReason"].string == "error" && event.has("error") {
                    error = event["error"]
                } else {
                    if !event["stopReason"].isNil { stopReason = event["stopReason"] }
                    if event["stopReason"].string == "cancelled" { cancelled = true }
                }
            default: break
            }
        }
        let fullText = rawFullText ?? content
        var final: [String: Value] = ["contentText": .string(content), "toolCalls": .array(toolCalls)]
        if !thinking.isEmpty { final["thinkingText"] = .string(thinking) }
        if !toolErrors.isEmpty { final["toolErrors"] = .array(toolErrors) }
        if !stats.isNil { final["stats"] = stats }
        final["raw"] = ["fullText": .string(fullText)]
        if toolCalls.isEmpty {
            var stripped = fullText
            for expression in [Self.thinkClosed, Self.thinkOpen] {
                stripped = expression.stringByReplacingMatches(
                    in: stripped, range: NSRange(stripped.startIndex..., in: stripped), withTemplate: "")
            }
            final["cacheableAssistantContent"] = .string(stripped.trimmingCharacters(in: .whitespacesAndNewlines))
        }
        if !stopReason.isNil { final["stopReason"] = stopReason }
        return Aggregate(final: .object(final), error: error, cancelled: cancelled)
    }

    /// The final a run resolves to, or the rejection it raises instead.
    private func settled(_ run: Aggregate, _ requestId: String) throws -> Value {
        if let error = run.error {
            var payload = error.json.objectFields
            payload["name"] = .string("COMPLETION_FAILED")
            payload["message"] = .string(error["message"].isNil ? "completion failed" : jsString(error["message"]))
            payload["cause"] = error.json
            if let code = Wire.code("COMPLETION_FAILED") { payload["code"] = .number(code) }
            throw QvacError(payload: payload)
        }
        if run.cancelled {
            var payload: [String: JSONValue] = [
                "name": .string("INFERENCE_CANCELLED"), "message": .string("Inference cancelled: \(requestId)"),
                "requestId": .string(requestId),
            ]
            if let code = Wire.code("INFERENCE_CANCELLED") { payload["code"] = .number(code) }
            throw QvacError(payload: payload)
        }
        return run.final
    }

    private func withContent(_ history: Value) -> Value {
        .array(history.list.map { $0.merging(["content": $0["content"].or("")]) })
    }

    private func completion(_ params: Value, _ collect: String) async throws -> Value {
        try requireCollect("completion", collect, ["text", "events", "all"])
        let requestId = params["requestId"].string ?? Wire.requestId()
        let tools = params["tools"].list
        let request: Value = [
            "type": "completionStream",
            "modelId": try require(params, "modelId"),
            "history": withContent(params["history"]),
            "kvCache": params["kvCache"],
            "prefill": params["prefill"],
            "seedFrom": params["seedFrom"],
            "tools": tools.isEmpty ? .null : .array(tools),
            "stream": params["stream"].or(true),
            "generationParams": params["generationParams"],
            "captureThinking": params["captureThinking"],
            "emitRawDeltas": params["emitRawDeltas"],
            "toolDialect": params["toolDialect"],
            "responseFormat": params["responseFormat"],
            "requestId": .string(requestId),
        ]
        let events = try await frames(request, "completionStream").flatMap { $0["events"].list }
        let tokens = events.filter { $0["type"].string == "contentDelta" }.map { Value.string($0["text"].string ?? "") }
        switch collect {
        case "text":
            let final = try settled(aggregate(events), requestId)
            return [
                "text": params["stream"].isTrue ? .string(tokens.map(jsString).joined()) : final["contentText"],
                "toolCalls": final["toolCalls"],
                "stats": final["stats"],
                "stopReason": final["stopReason"],
                "fullText": final["raw"]["fullText"],
            ]
        case "events": return ["events": .array(events)]
        // A run that does not stream has an empty token stream in the JS client.
        default: return ["all": params["stream"].isTrue ? .array(tokens) : []]
        }
    }

    private func batchCompletion(_ params: Value, _ collect: String) async throws -> Value {
        try requireCollect("batchCompletion", collect, ["all", "events"])
        let prompts = params["prompts"].list
        let requestId = params["requestId"].string ?? Wire.requestId()
        let request: Value = [
            "type": "batchCompletionStream",
            "modelId": try require(params, "modelId"),
            "prompts": .array(prompts.map { prompt in
                Value.object([
                    "id": prompt["id"],
                    "history": withContent(prompt["history"]),
                    "generationParams": prompt["generationParams"],
                    "responseFormat": prompt["responseFormat"],
                    "tools": prompt["tools"].list.isEmpty ? .null : prompt["tools"],
                ]).compacted()
            }),
            "stream": params["stream"].or(true),
            "captureThinking": params["captureThinking"],
            "emitRawDeltas": params["emitRawDeltas"],
            "toolDialect": params["toolDialect"],
            "requestId": .string(requestId),
        ]
        var ids: [String] = []
        var batchEvents: [Value] = []
        var perId: [String: [Value]] = [:]
        for frame in try await frames(request, "batchCompletionStream") {
            if let list = frame["ids"].array { ids = list.map(jsString) }
            for item in frame["events"].list {
                batchEvents.append(item)
                perId[jsString(item["id"]), default: []].append(item["event"])
            }
        }
        if collect == "events" { return ["events": .array(batchEvents)] }
        if ids.isEmpty { ids = prompts.enumerated().map { $1["id"].isNil ? String($0) : jsString($1["id"]) } }
        let results = try ids.map { id -> Value in
            ["id": .string(id), "final": try settled(aggregate(perId[id] ?? []), requestId)]
        }
        return ["all": .array(results), "events": .array(batchEvents)]
    }

    // MARK: translation, ocr, speech

    private func translate(_ params: Value, _ collect: String) async throws -> Value {
        try requireCollect("translate", collect, ["text", "all"])
        let request = params.merging(["type": "translate", "requestId": params["requestId"].or(.string(Wire.requestId()))])
        var tokens: [String] = []
        var stats: Value = .null
        for frame in try await frames(request, "translate") {
            if frame["done"].isTrue { stats = frame["stats"] } else { tokens.append(frame["token"].string ?? "") }
        }
        let streamed = params["stream"].isTrue
        if collect == "all" {
            // `text` is the drained token stream, which a run that does not stream leaves empty.
            let drained = streamed ? tokens : []
            return ["all": Value(drained), "text": .string(drained.joined()), "stats": stats]
        }
        if streamed { return ["text": .string(tokens.joined()), "stats": stats] }
        let translations = params["text"].array != nil ? tokens : [tokens.joined()]
        return ["text": .string(translations.joined(separator: "\n")), "translations": Value(translations), "stats": stats]
    }

    private func ocr(_ params: Value, _ collect: String) async throws -> Value {
        try requireCollect("ocr", collect, ["blocks", "all", "events", "text"])
        let request = Value.object([
            "type": "ocrStream",
            "modelId": try require(params, "modelId"),
            "image": Wire.fileOrBase64(params["image"]),
            "options": params["options"],
        ]).compacted()
        var blocks: [Value] = []
        var stats: Value = .null
        for frame in try await frames(request, "ocrStream") {
            blocks.append(contentsOf: frame["blocks"].list)
            if frame["done"].isTrue { stats = frame["stats"] }
        }
        switch collect {
        case "blocks": return ["blocks": .array(blocks), "stats": stats]
        case "all", "events": return ["all": .array(blocks), "events": .array(blocks), "stats": stats]
        default:
            return [
                "text": .string(blocks.map { $0["text"].isNil ? "" : jsString($0["text"]) }.joined(separator: " ")),
                "stats": stats,
            ]
        }
    }

    private func transcribeRequest(_ params: Value) throws -> Value {
        Value.object([
            "type": "transcribe",
            "modelId": try require(params, "modelId"),
            "audioChunk": Wire.fileOrBase64(params["audioChunk"]),
            "prompt": params["prompt"],
            "hotwords": params["hotwords"],
            "maxNewTokens": params["maxNewTokens"],
            "metadata": params["metadata"].isTrue ? true : .null,
            "requestId": params["requestId"].or(.string(Wire.requestId())),
        ]).compacted()
    }

    private func transcribe(_ params: Value) async throws -> Value {
        let responses = try await frames(try transcribeRequest(params), "transcribe")
        let stats = responses.last { $0["done"].isTrue }?["stats"] ?? .null
        if params["metadata"].isTrue {
            return ["segments": .array(responses.map { $0["segment"] }.filter { !$0.isNil }), "stats": stats]
        }
        return ["text": .string(responses.map { $0["text"].string ?? "" }.joined()), "stats": stats]
    }

    /// `transcribeStream()` with upfront audio: the pieces as they arrive.
    private func transcribeStream(_ params: Value, _ collect: String) async throws -> Value {
        try requireCollect("transcribeStream", collect, ["blocks", "all", "last", "text"])
        let responses = try await frames(try transcribeRequest(params), "transcribe")
        let pieces: [Value] =
            params["metadata"].isTrue
            ? responses.map { $0["segment"] }.filter { !$0.isNil }
            : responses.compactMap { $0["text"].string.flatMap { $0.isEmpty ? nil : Value.string($0) } }
        switch collect {
        case "blocks": return ["blocks": .array(pieces)]
        case "all": return ["all": .array(pieces)]
        case "last": return ["last": pieces.last ?? .null]
        default: return ["text": .string(pieces.map(jsString).joined())]
        }
    }

    /// `bciTranscribe()`: the neural signal as a path or inline bytes. `text` holds what the SDK call
    /// resolves to, as the JS binding binds it: the joined transcript, or the segments with `metadata`.
    private func bciTranscribe(_ params: Value) async throws -> Value {
        let request = params.merging([
            "type": "bciTranscribe",
            "modelId": try require(params, "modelId"),
            "neuralData": Wire.fileOrBase64(params["neuralData"]),
        ])
        let responses = try await frames(request, "bciTranscribe")
        if params["metadata"].isTrue { return ["text": .array(responses.map { $0["segment"] }.filter { !$0.isNil })] }
        return ["text": .string(responses.map { $0["text"].string ?? "" }.joined())]
    }

    /// `diffusion()` and `upscale()`: the images as bytes, the progress ticks, the terminal stats.
    private func images(_ request: Value, _ type: String, _ method: String, _ collect: String) async throws -> Value {
        try requireCollect(method, collect, ["events", "all", "last"])
        var outputs: [Value] = []
        var events: [Value] = []
        var stats: Value = .null
        for frame in try await frames(request, type) {
            if let step = frame["step"].number, let total = frame["totalSteps"].number, let elapsed = frame["elapsedMs"].number {
                events.append(["step": .number(step), "totalSteps": .number(total), "elapsedMs": .number(elapsed)])
            }
            if let data = frame["data"].string, !data.isEmpty, let bytes = Data(base64Encoded: data) {
                outputs.append(.bytes(bytes))
            }
            if frame["done"].isTrue { stats = frame["stats"] }
        }
        switch collect {
        case "events": return ["events": .array(events), "all": .array(outputs), "stats": stats]
        case "last": return ["last": outputs.last ?? .null, "events": .array(events), "stats": stats]
        default: return ["all": .array(outputs), "events": .array(events), "stats": stats]
        }
    }

    /// Image bytes as the base64 the worker takes; a string is refused.
    private func base64(_ value: Value, _ field: String) throws -> Value {
        if value.string != nil { throw StepError("\(field) must be image bytes, got a string") }
        return .string(value.data.base64EncodedString())
    }

    private func diffusion(_ params: Value, _ collect: String) async throws -> Value {
        var request = params.fields
        if !params["init_image"].isNil { request["init_image"] = try base64(params["init_image"], "init_image") }
        if let images = params["init_images"].array {
            request["init_images"] = .array(try images.map { try base64($0, "init_images") })
        }
        request["type"] = "diffusionStream"
        request["requestId"] = params["requestId"].or(.string(Wire.requestId()))
        return try await images(.object(request), "diffusionStream", "diffusion", collect)
    }

    private func upscale(_ params: Value, _ collect: String) async throws -> Value {
        let request = Value.object([
            "type": "upscaleStream",
            "modelId": try require(params, "modelId"),
            "image": try base64(params["image"], "image"),
            "repeats": params["repeats"],
            "requestId": params["requestId"].or(.string(Wire.requestId())),
        ]).compacted()
        return try await images(request, "upscaleStream", "upscale", collect)
    }

    private static let finetuneProgressFields = [
        "is_train", "loss", "loss_uncertainty", "accuracy", "accuracy_uncertainty", "global_steps", "current_epoch",
        "current_batch", "total_batches", "elapsed_ms", "eta_ms",
    ]

    /// `finetune()`: a control operation answers once; a run streams progress up to its result.
    private func finetune(_ params: Value, _ collect: String) async throws -> Value {
        // The fields createFinetuneReplyRequest in the JS client sends.
        if let operation = params["operation"].string, ["pause", "cancel", "getState"].contains(operation) {
            var request: Value = ["type": "finetune", "modelId": params["modelId"], "operation": .string(operation)]
            if operation == "getState" { request = request.merging(["options": params["options"]]) }
            return ["last": try await wire.send(request)]
        }
        try requireCollect("finetune", collect, ["events", "last"])
        let request = params.merging([
            "type": "finetune", "requestId": params["requestId"].or(.string(Wire.requestId())), "withProgress": true,
        ])
        var events: [Value] = []
        var result: Value?
        for try await frame in wire.stream(request) {
            switch frame["type"].string {
            case "finetune:progress":
                events.append(.object(frame.fields.filter { Self.finetuneProgressFields.contains($0.key) }))
            case "finetune":
                result = frame
            default:
                throw Wire.refusal("INVALID_RESPONSE", "finetune")
            }
        }
        guard let result else { throw StepError("finetune stream ended without a result") }
        return collect == "events" ? ["events": .array(events), "last": result] : ["last": result]
    }

    private func textToSpeech(_ params: Value, _ collect: String) async throws -> Value {
        try requireCollect("textToSpeech", collect, ["pcm", "all", "events"])
        let stream = params["stream"].or(true)
        let sentenceStream = params["sentenceStream"].or(false)
        if collect == "events" && sentenceStream.isTrue { throw incomplete("textToSpeech", "events (sentence stream)") }
        if sentenceStream.isTrue && !stream.isTrue {
            throw Wire.refusal("TEXT_TO_SPEECH_STREAM_FAILED", "textToSpeech: `sentenceStream: true` requires `stream: true`")
        }
        let request = params.merging([
            "inputType": params["inputType"].or("text"),
            "stream": stream,
            "sentenceStream": sentenceStream,
            "type": "textToSpeech",
            "requestId": params["requestId"].or(.string(Wire.requestId())),
        ])
        var pcm: [Value] = []
        var done = false
        var sampleRate: Value = .null
        var text: Value = .null
        for frame in try await frames(request, "textToSpeech") {
            pcm.append(contentsOf: Wire.ttsSamples(frame))
            if !frame["text"].isNil { text = frame["text"] }
            if sampleRate.isNil && !frame["sampleRate"].isNil { sampleRate = frame["sampleRate"] }
            if frame["done"].isTrue { done = true }
        }
        switch collect {
        case "pcm": return ["pcm": .array(pcm), "sampleRate": sampleRate, "done": .bool(done), "text": text]
        case "all": return ["all": stream.isTrue ? .array(pcm) : []]
        default: return ["events": []]
        }
    }

    private func classify(_ params: Value) async throws -> Value {
        let image = params["image"]
        let bytes = try image.string.map { try Data(contentsOf: URL(fileURLWithPath: $0)) } ?? image.data
        var request: [String: Value] = [
            "type": "classify", "modelId": try require(params, "modelId"), "image": .string(bytes.base64EncodedString()),
        ]
        for key in ["topK", "width", "height", "channels"] where !params[key].isNil { request[key] = params[key] }
        let done = try await frames(.object(request), "classify").last { $0["done"].isTrue }
        return ["results": done?["results"].or([]) ?? []]
    }

    private func pluginStream(_ params: Value, _ collect: String) async throws -> Value {
        try requireCollect("invokePluginStream", collect, ["all", "last", "text"])
        let request: Value = [
            "type": "pluginInvokeStream",
            "modelId": try require(params, "modelId"),
            "handler": try require(params, "handler"),
            "params": params["params"],
        ]
        let chunks = try await frames(request, "pluginInvokeStream").filter { !$0["done"].isTrue }.map { $0["result"] }
        switch collect {
        case "all": return ["all": .array(chunks)]
        case "last": return ["last": chunks.last ?? .null]
        default: return ["text": .string(chunks.map(jsString).joined())]
        }
    }

    // MARK: models and registry

    private func loadModel(_ params: Value) async throws -> Value {
        // `{ modelId, modelConfig }` without a source is a config reload of a loaded model.
        if params["modelSrc"].isNil && !params["modelId"].isNil {
            let response = try await wire.send([
                "type": "loadModel",
                "modelId": params["modelId"],
                "modelType": params["modelType"].isNil ? .null : .string(Resources.canonicalModelType(jsString(params["modelType"]))),
                "modelConfig": params["modelConfig"],
            ])
            try Wire.requireSuccess(response, "MODEL_LOAD_FAILED")
            return ["modelId": response["modelId"].or(params["modelId"])]
        }
        if !params["withProgress"].isTrue { return ["modelId": .string(try await resources.loadModel(params))] }

        let args = try Resources.loadArgs(params)
        let request: Value = [
            "type": "loadModel",
            "modelSrc": .string(args.src),
            "modelName": Value(args.name),
            "modelType": .string(args.type),
            "modelConfig": args.config ?? .null,
            "withProgress": true,
            "requestId": .string(args.requestId ?? Wire.requestId()),
        ]
        var progress: [Value] = []
        var modelId: Value = .null
        for try await frame in wire.stream(request) {
            switch frame["type"].string {
            case "modelProgress": progress.append(frame)
            case "loadModel":
                try Wire.requireSuccess(frame, "MODEL_LOAD_FAILED")
                modelId = frame["modelId"]
            default: break
            }
        }
        if modelId.isNil { throw StepError("loadModel stream ended without a result") }
        return ["modelId": modelId, "progress": .array(progress)]
    }

    private func registry(_ type: String, _ extra: Value, _ field: String, _ fallback: String? = nil) async throws -> Value {
        let response = try await wire.send(extra.merging(["type": .string(type)]))
        if !response["success"].isTrue {
            throw Wire.refusal("QVAC_MODEL_REGISTRY_QUERY_FAILED", response["error"].string ?? fallback ?? "Unknown registry error")
        }
        return response[field]
    }

    // MARK: runtime

    private func cancelParams(_ params: Value) -> Value {
        let operation = params["operation"]
        if !operation.isNil {
            switch operation.string {
            case "request", "broad": return params
            case "inference": return ["operation": "broad", "modelId": params["modelId"], "kind": "completion"]
            default: return ["operation": "broad", "modelId": params["modelId"], "kind": "embeddings"]
            }
        }
        if params.has("requestId") {
            return Value.object(["operation": "request", "requestId": params["requestId"], "clearCache": params["clearCache"]]).compacted()
        }
        return Value.object(["operation": "broad", "modelId": params["modelId"], "kind": params["kind"]]).compacted()
    }

    private func deleteCache(_ params: Value) async throws -> Value {
        let request: Value
        if params["all"].isTrue {
            request = ["type": "deleteCache", "all": true]
        } else if params["auto"].isTrue {
            request = ["type": "deleteCache", "auto": true]
        } else if params.has("kvCacheKey") {
            request = ["type": "deleteCache", "kvCacheKey": params["kvCacheKey"], "modelId": params["modelId"]]
        } else {
            throw Wire.refusal("INVALID_DELETE_CACHE_PARAMS", "deleteCache needs all, auto or kvCacheKey")
        }
        let response = try await wire.send(request)
        if !response["success"].isTrue && !response["error"].isNil {
            throw Wire.refusal("DELETE_CACHE_FAILED", response["error"].string)
        }
        return ["success": response["success"]]
    }

    private func downloadAsset(_ params: Value) async throws -> Value {
        let source = params["assetSrc"]
        let request = Value.object([
            "type": "downloadAsset",
            "assetSrc": source.object != nil ? source["src"] : source,
            "withProgress": false,
            "seed": params["seed"].or(false),
            "requestId": params["requestId"].or(.string(Wire.requestId())),
            "requireHttpChecksum": params["requireHttpChecksum"],
            "requireSecureTransport": params["requireSecureTransport"],
        ]).compacted()
        let response = try Wire.requireSuccess(try await wire.send(request), "DOWNLOAD_ASSET_FAILED")
        return ["path": response["assetId"]]
    }

    // MARK: rag and vector index

    @discardableResult
    private func rag(_ operation: String, _ params: Value, _ failure: String) async throws -> Value {
        let response = try await wire.send(params.merging(["type": "rag", "operation": .string(operation)]))
        return try Wire.requireSuccess(response, failure)
    }

    private final class OpenIndex {
        var length: Value
        init(length: Value) { self.length = length }
    }

    private let indexes = Locked<[String: OpenIndex]>([:])

    private func index(_ indexId: Value) throws -> OpenIndex {
        guard let open = indexes.withLock({ $0[jsString(indexId)] }) else {
            throw StepError("vector index \"\(jsString(indexId))\" is not open in this client")
        }
        return open
    }

    @discardableResult
    private func vectorIndex(_ operation: String, _ fields: Value) async throws -> Value {
        let response = try await wire.send(fields.merging(["type": "vectorIndex", "operation": .string(operation)]))
        return try Wire.requireSuccess(response, "VECTOR_INDEX_FAILED")
    }

    private func describeIndex(_ response: Value) -> Value {
        let indexId = jsString(response["indexId"])
        indexes.withLock { $0[indexId] = OpenIndex(length: response["length"]) }
        return [
            "indexId": .string(indexId), "dim": response["dim"], "storage": response["storage"], "length": response["length"],
            "calibrated": response["calibrated"], "stagedSearch": response["stagedSearch"], "ivf": response["ivf"],
        ]
    }

    // MARK: sessions: transcription and logs

    private final class TranscribeSession: @unchecked Sendable {
        let input: AsyncStream<Data>
        let feed: AsyncStream<Data>.Continuation
        let events: AsyncThrowingStream<Value, Error>
        let emit: AsyncThrowingStream<Value, Error>.Continuation
        let stats = Promise<Value>()
        var task: Task<Void, Never>?

        init() {
            (input, feed) = AsyncStream<Data>.makeStream()
            (events, emit) = AsyncThrowingStream<Value, Error>.makeStream()
        }
    }

    private let sessions = Locked<[String: TranscribeSession]>([:])
    private let sessionSeq = Locked(0)

    private func session(_ id: Value) throws -> TranscribeSession {
        guard let session = sessions.withLock({ $0[jsString(id)] }) else {
            throw StepError("transcription session \"\(jsString(id))\" is not open")
        }
        return session
    }

    /// The event a session yields for one frame, by the session's mode, as the JS client maps it.
    private func sessionEvent(_ frame: Value, _ mode: String, _ wantsMetadata: Bool) -> Value? {
        if mode == "conversation" {
            let vad = frame["vad"]
            if !vad.isNil {
                var event: [String: Value] = ["type": "vad", "speaking": vad["speaking"], "probability": vad["probability"]]
                if !vad["source"].isNil { event["source"] = vad["source"] }
                if vad.has("speakerId") { event["speakerId"] = vad["speakerId"] }
                return .object(event)
            }
            let turn = frame["endOfTurn"]
            if !turn.isNil {
                return turn["source"].string == "whisper"
                    ? ["type": "endOfTurn", "source": "whisper", "silenceDurationMs": turn["silenceDurationMs"]]
                    : ["type": "endOfTurn", "source": "parakeet"]
            }
        }
        if mode == "metadata" { return frame["segment"].isNil ? nil : frame["segment"] }
        if mode == "conversation" && wantsMetadata {
            return frame["segment"].isNil ? nil : ["type": "segment", "segment": frame["segment"]]
        }
        guard let text = frame["text"].string, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return ["type": "text", "text": .string(text)]
    }

    private func openSession(_ request: Value, _ mode: String, _ wantsMetadata: Bool) -> Value {
        let session = TranscribeSession()
        let frames = wire.duplex(request, input: session.input)
        session.task = Task { [self] in
            do {
                for try await frame in frames {
                    if !frame["error"].isNil { throw Wire.refusal("TRANSCRIPTION_FAILED", jsString(frame["error"])) }
                    if frame["done"].isTrue {
                        session.stats.complete(.success(frame["stats"]))
                        session.emit.finish()
                        continue
                    }
                    if let event = sessionEvent(frame, mode, wantsMetadata) { session.emit.yield(event) }
                }
                session.stats.complete(.success(.null))
                session.emit.finish()
            } catch {
                session.stats.complete(.failure(error))
                session.emit.finish(throwing: error)
            }
        }
        let id = "session-\(sessionSeq.withLock { $0 += 1; return $0 })"
        sessions.withLock { $0[id] = session }
        return ["sessionId": .string(id)]
    }

    private func transcribeStreamOpen(_ params: Value) async throws -> Value {
        var request: [String: Value] = ["type": "transcribeStream", "modelId": try require(params, "modelId")]
        if let prompt = params["prompt"].string, !prompt.isEmpty { request["prompt"] = .string(prompt) }
        if params["metadata"].isTrue { request["metadata"] = true }
        if params["emitVadEvents"].isTrue { request["emitVadEvents"] = true }
        for key in ["endOfTurnSilenceMs", "vadRunIntervalMs", "parakeetStreamingConfig"] where !params[key].isNil {
            request[key] = params[key]
        }
        let mode: String
        if params["emitVadEvents"].isTrue || !params["parakeetStreamingConfig"].isNil {
            mode = "conversation"
        } else if params["metadata"].isTrue {
            mode = "metadata"
        } else {
            mode = "text"
        }
        return openSession(.object(request), mode, params["metadata"].isTrue)
    }

    /// A chunk that holds nothing would never advance through the audio.
    private func chunkLength(_ bytes: Int, _ param: String) throws -> Int {
        if bytes <= 0 { throw StepError("\(param) gives chunks of \(bytes) bytes; it must give at least one") }
        return bytes
    }

    private func transcribeStreamWrite(_ params: Value) async throws -> Value {
        let session = try session(params["sessionId"])
        let decoded = try Media.decodeWavToMonoF32(params["audio"].data)
        let expected = params["expectSampleRate"].int ?? 16000
        if decoded.sampleRate != expected { throw StepError("fixture sample rate \(decoded.sampleRate) != expected \(expected)") }
        let wide = params["sampleFormat"].string == "f32le"
        let bytesPerSample = wide ? 4 : 2
        let speech = wide ? Media.f32ToLeBytes(decoded.samplesMono) : Media.f32ToS16LeBytes(decoded.samplesMono)
        let silenceSamples = Int((params["trailingSilenceMs"].number ?? 0) / 1000 * Double(decoded.sampleRate))
        let silence = Data(count: silenceSamples * bytesPerSample)
        let chunkMs = try require(params, "chunkMs").number ?? 0
        let chunkSize = try chunkLength(Int(chunkMs / 1000 * Double(decoded.sampleRate)) * bytesPerSample, "chunkMs")
        let delayMs = params["pace"].bool == false ? 0 : chunkMs
        var chunks = 0
        for payload in [speech, silence] {
            var offset = 0
            while offset < payload.count {
                session.feed.yield(payload.subdata(in: offset..<min(offset + chunkSize, payload.count)))
                chunks += 1
                if delayMs > 0 && offset + chunkSize < payload.count { await sleep(milliseconds: delayMs) }
                offset += chunkSize
            }
        }
        return ["chunks": Value(chunks), "bytes": Value(speech.count + silence.count)]
    }

    private func transcribeStreamWriteChunks(_ params: Value) async throws -> Value {
        let session = try session(params["sessionId"])
        let decoded = try Media.decodeWavToMonoF32(params["audio"].data)
        let speech = Media.f32ToS16LeBytes(decoded.samplesMono)
        let chunkMs = try require(params, "chunkMs").number ?? 0
        let chunkSize = try chunkLength(Int(chunkMs / 1000 * Double(decoded.sampleRate)) * 2, "chunkMs")
        var written = 0
        for index in 0..<max(0, params["chunks"].int ?? 0) {
            let offset = index * chunkSize
            if offset >= speech.count { break }
            session.feed.yield(speech.subdata(in: offset..<min(offset + chunkSize, speech.count)))
            written += 1
        }
        return ["chunks": Value(written)]
    }

    private func transcribeStreamWriteBytes(_ params: Value) async throws -> Value {
        let session = try session(params["sessionId"])
        let data = params["data"].data
        let chunkBytes = try chunkLength(try require(params, "chunkBytes").int ?? 0, "chunkBytes")
        var chunks = 0
        var offset = 0
        while offset < data.count {
            session.feed.yield(data.subdata(in: offset..<min(offset + chunkBytes, data.count)))
            chunks += 1
            offset += chunkBytes
        }
        return ["chunks": Value(chunks), "bytes": Value(data.count)]
    }

    private func transcribeStreamDrain(_ params: Value, _ collect: String) async throws -> Value {
        try requireCollect("transcribeStreamDrain", collect, ["events"])
        let session = try session(params["sessionId"])
        let abortAfter = params["abortAfter"].int
        var events: [Value] = []
        for try await event in session.events {
            events.append(event)
            if let abortAfter, events.count >= abortAfter {
                // Stopping here unwinds the session, as the JS consumer erroring out does.
                session.task?.cancel()
                session.feed.finish()
                break
            }
        }
        let stats: Value
        if abortAfter != nil && !session.stats.isCompleted {
            stats = .null
        } else {
            do {
                stats = try await session.stats.value()
            } catch {
                if abortAfter == nil { throw error }
                stats = .null
            }
        }
        return ["events": .array(events), "stats": stats]
    }

    private func transcribeStreamDestroy(_ params: Value) async throws -> Value {
        guard !params["sessionId"].isNil,
            let session = sessions.withLock({ $0.removeValue(forKey: jsString(params["sessionId"])) })
        else {
            return ["destroyed": false]
        }
        session.feed.finish()
        session.stats.complete(.success(.null))
        session.task?.cancel()
        await session.task?.value
        return ["destroyed": true]
    }

    private final class LogStream: @unchecked Sendable {
        let collected = Locked<[Value]>([])
        let cutoffMs = Locked<Double>(0)
        var task: Task<Void, Never>?
    }

    private let logStreams = Locked<[String: LogStream]>([:])
    private let logStreamSeq = Locked(0)

    private func logStream(_ id: Value) throws -> LogStream {
        guard let stream = logStreams.withLock({ $0[jsString(id)] }) else {
            throw StepError("log stream \"\(jsString(id))\" is not open")
        }
        return stream
    }

    private func loggingStreamOpen(_ params: Value) async throws -> Value {
        let state = LogStream()
        let id = "logs-\(logStreamSeq.withLock { $0 += 1; return $0 })"
        logStreams.withLock { $0[id] = state }
        // Read in the background: the catalog triggers the logged operation before the collect step.
        let entries = wire.stream(["type": "loggingStream", "id": params["id"].or(.string(Self.sdkLogId))])
        state.task = Task {
            do {
                for try await entry in entries { state.collected.withLock { $0.append(entry) } }
            } catch {
                // An unknown id closes the stream; the collect step reports the count.
            }
        }
        return ["streamId": .string(id)]
    }

    private static func now() -> Double { Date().timeIntervalSince1970 * 1000 }

    private func loggingStreamCollect(_ params: Value) async throws -> Value {
        let state = try logStream(params["streamId"])
        let target = params["target"].int ?? 1
        let deadline = Self.now() + (params["timeoutMs"].number ?? 5000)
        func since() -> [Value] {
            let cutoff = state.cutoffMs.withLock { $0 }
            return state.collected.withLock { $0.filter { ($0["timestamp"].number ?? 0) >= cutoff } }
        }
        while since().count < target && Self.now() < deadline { await sleep(milliseconds: 50) }
        return ["entries": .array(since())]
    }

    private func loggingStreamClose(_ params: Value) async throws -> Value {
        guard !params["streamId"].isNil,
            let state = logStreams.withLock({ $0.removeValue(forKey: jsString(params["streamId"])) })
        else {
            return ["closed": false]
        }
        let task = state.task
        let closed = try await withTimeout(5) {
            task?.cancel()
            await task?.value
            return true
        }
        if closed == nil { throw StepError("log stream \"\(jsString(params["streamId"]))\" did not close within 5000ms") }
        return ["closed": true]
    }

    // MARK: scratch directories

    private let scratchDirectories = Locked<Set<String>>([])

    private func withinScratch(_ candidate: URL) -> Bool {
        let resolved = candidate.standardizedFileURL.resolvingSymlinksInPath().path
        return scratchDirectories.withLock { roots in
            roots.contains { root in
                let base = URL(fileURLWithPath: root).standardizedFileURL.resolvingSymlinksInPath().path
                return resolved == base || resolved.hasPrefix(base + "/")
            }
        }
    }

    func scratch(_ method: String, _ params: Value) throws -> Value {
        let files = FileManager.default
        switch method {
        case "scratchDirectory":
            try files.createDirectory(at: scratchRoot, withIntermediateDirectories: true)
            let root = scratchRoot.appendingPathComponent("qvac-e2e-\(UUID().uuidString.lowercased())")
            try files.createDirectory(at: root, withIntermediateDirectories: true)
            var directories: [String: Value] = [:]
            for name in params["subdirectories"].list.map(jsString) {
                let directory = root.appendingPathComponent(name)
                try files.createDirectory(at: directory, withIntermediateDirectories: true)
                directories[name] = .string(directory.path)
            }
            scratchDirectories.withLock { _ = $0.insert(root.path) }
            return ["path": .string(root.path), "directories": .object(directories)]
        case "producedFile":
            let directory = URL(fileURLWithPath: jsString(params["directory"]))
            if !withinScratch(directory) { throw StepError("\"\(directory.path)\" is not inside a directory this test created") }
            let target = directory.appendingPathComponent(jsString(params["file"]))
            return ["exists": .bool(files.fileExists(atPath: target.path)), "path": .string(target.path)]
        default:
            guard let path = params["path"].string, scratchDirectories.withLock({ $0.remove(path) }) != nil else {
                return ["discarded": false]
            }
            try? files.removeItem(atPath: path)
            return ["discarded": true]
        }
    }

    // MARK: the tables

    private func plain(_ type: String, _ fields: Value = [:]) async throws -> Value {
        try await wire.send(fields.merging(["type": .string(type)]))
    }

    private func callTable() -> [String: Call] { [
        "embed": { [unowned self] p in
            let response = try await plain("embed", withRequestId(p))
            var result: [String: Value] = ["embedding": response["embedding"]]
            if !response["stats"].isNil { result["stats"] = response["stats"] }
            return .object(result)
        },
        "classify": { [unowned self] in try await classify($0) },
        "rerank": { [unowned self] p in
            _ = try require(p, "modelId")
            return ["scores": try await plain("rerank", withRequestId(p))["scores"]]
        },
        "transcribe": { [unowned self] in try await transcribe($0) },
        "bciTranscribe": { [unowned self] in try await bciTranscribe($0) },
        "vlaHparams": { [unowned self] p in
            let modelId = try require(p, "modelId")
            let response = try await plain(
                "pluginInvoke", ["modelId": modelId, "handler": "vlaHparams", "params": ["type": "vlaHparams", "modelId": modelId]])
            return ["hparams": response["result"]["hparams"], "backendName": response["result"]["backendName"]]
        },
        "loadModel": { [unowned self] in try await loadModel($0) },
        "unloadModel": { [unowned self] p in
            let response = try await plain("unloadModel", ["modelId": try require(p, "modelId"), "clearStorage": p["clearStorage"].or(false)])
            if !response["success"].isTrue { throw Wire.refusal("MODEL_UNLOAD_FAILED", "Failed to unload model \(jsString(p["modelId"]))") }
            return .null
        },
        "getModelInfo": { [unowned self] p in try await plain("getModelInfo", ["name": p["name"]])["modelInfo"] },
        "getLoadedModelInfo": { [unowned self] p in try await plain("getLoadedModelInfo", ["modelId": p["modelId"]])["info"] },
        "calcTokens": { [unowned self] p in try await plain("calcTokens", p)["tokens"] },
        "modelRegistryList": { [unowned self] _ in try await registry("modelRegistryList", [:], "models") },
        "modelRegistrySearch": { [unowned self] p in
            try await registry("modelRegistrySearch", p.removing("modelType").merging(["addon": p["modelType"].or(p["addon"])]), "models")
        },
        "modelRegistryGetModel": { [unowned self] p in
            try await registry(
                "modelRegistryGetModel", ["registryPath": p["registryPath"], "registrySource": p["registrySource"]], "model",
                "Model not found: \(jsString(p["registrySource"]))/\(jsString(p["registryPath"]))")
        },
        "cancel": { [unowned self] p in
            let response = try await plain("cancel", cancelParams(p))
            if !response["success"].isTrue { throw Wire.refusal("CANCEL_FAILED", response["error"].string) }
            return .null
        },
        "deleteCache": { [unowned self] in try await deleteCache($0) },
        "downloadAsset": { [unowned self] in try await downloadAsset($0) },
        "getSystemResources": { [unowned self] p in
            let response = try await plain("getSystemResources", Value.object(["sample": p["sample"]]).compacted())
            var result: [String: Value] = ["capabilities": response["capabilities"]]
            if !response["sample"].isNil { result["sample"] = response["sample"] }
            return .object(result)
        },
        "heartbeat": { [unowned self] _ in try await plain("heartbeat") },
        "suspend": { [unowned self] _ in
            _ = try await plain("suspend")
            return ["suspended": true]
        },
        "resume": { [unowned self] _ in
            _ = try await plain("resume")
            return ["resumed": true]
        },
        "state": { [unowned self] _ in ["state": try await plain("state")["state"]] },
        "ragIngest": { [unowned self] p in
            let response = try await rag(
                "ingest", p.merging(["chunk": p["chunk"].or(true), "requestId": p["requestId"].or(.string(Wire.requestId()))]),
                "RAG_SAVE_FAILED")
            return ["processed": response["processed"], "droppedIndices": response["droppedIndices"]]
        },
        "ragCloseWorkspace": { [unowned self] p in
            try await rag("closeWorkspace", p, "RAG_WORKSPACE_CLOSE_FAILED")
            return ["closed": true]
        },
        "ragDeleteWorkspace": { [unowned self] p in
            try await rag("deleteWorkspace", p, "RAG_DELETE_FAILED")
            return ["deleted": true]
        },
        "createVectorIndex": { [unowned self] p in
            describeIndex(try await vectorIndex("create", ["dim": p["dim"], "storage": p["storage"].or("turbovec-q4")]))
        },
        "loadVectorIndex": { [unowned self] p in describeIndex(try await vectorIndex("load", ["path": p["path"]])) },
        "vectorIndexAdd": { [unowned self] p in
            let open = try index(p["indexId"])
            let response = try await vectorIndex("add", ["indexId": p["indexId"], "ids": p["ids"], "vectors": p["vectors"]])
            open.length = response["length"]
            return [
                "length": open.length, "calibrated": response["calibrated"], "stagedSearch": response["stagedSearch"],
                "ivf": response["ivf"],
            ]
        },
        "vectorIndexSearch": { [unowned self] p in
            _ = try index(p["indexId"])
            var fields: Value = ["indexId": p["indexId"], "queries": [p["query"]], "k": p["k"]]
            if !p["nProbe"].isNil { fields = fields.merging(["nProbe": p["nProbe"]]) }
            let response = try await vectorIndex("search", fields)
            return ["results": response["results"].list.first ?? []]
        },
        "vectorIndexSetIvf": { [unowned self] p in
            _ = try index(p["indexId"])
            return try await vectorIndex("setIvf", ["indexId": p["indexId"], "ivf": p["ivf"]])
        },
        "vectorIndexSetStagedSearch": { [unowned self] p in
            _ = try index(p["indexId"])
            return try await vectorIndex("setStagedSearch", ["indexId": p["indexId"], "enabled": p["enabled"]])
        },
        "vectorIndexRemove": { [unowned self] p in
            let open = try index(p["indexId"])
            let response = try await vectorIndex("remove", ["indexId": p["indexId"], "ids": p["ids"]])
            open.length = response["length"]
            return [
                "removed": response["removed"], "length": open.length, "calibrated": response["calibrated"],
                "stagedSearch": response["stagedSearch"], "ivf": response["ivf"],
            ]
        },
        "vectorIndexContains": { [unowned self] p in
            _ = try index(p["indexId"])
            return ["present": try await vectorIndex("contains", ["indexId": p["indexId"], "ids": p["ids"]])["present"]]
        },
        "vectorIndexWrite": { [unowned self] p in
            _ = try index(p["indexId"])
            return ["path": try await vectorIndex("write", ["indexId": p["indexId"], "path": p["path"]])["path"]]
        },
        "vectorIndexDispose": { [unowned self] p in
            let id = jsString(p["indexId"])
            guard !p["indexId"].isNil, indexes.withLock({ $0[id] }) != nil else { return ["disposed": false] }
            try await vectorIndex("dispose", ["indexId": .string(id)])
            indexes.withLock { $0[id] = nil }
            return ["disposed": true]
        },
        "vectorIndexLength": { [unowned self] p in
            let length = try index(p["indexId"]).length
            return ["length": length]
        },
        "invokePlugin": { [unowned self] p in
            let response = try await plain("pluginInvoke", ["modelId": p["modelId"], "handler": p["handler"], "params": p["params"]])
            return ["result": response["result"]]
        },
        "transcribeStreamOpen": { [unowned self] in try await transcribeStreamOpen($0) },
        "transcribeStreamWrite": { [unowned self] in try await transcribeStreamWrite($0) },
        "transcribeStreamWriteChunks": { [unowned self] in try await transcribeStreamWriteChunks($0) },
        "transcribeStreamWriteBytes": { [unowned self] in try await transcribeStreamWriteBytes($0) },
        "transcribeStreamEnd": { [unowned self] p in
            try session(p["sessionId"]).feed.finish()
            return ["ended": true]
        },
        "transcribeStreamDestroy": { [unowned self] in try await transcribeStreamDestroy($0) },
        "loggingStreamOpen": { [unowned self] in try await loggingStreamOpen($0) },
        "loggingStreamMark": { [unowned self] p in
            let state = try logStream(p["streamId"])
            let now = Self.now().rounded(.down)
            state.cutoffMs.withLock { $0 = now }
            return ["markedAt": .number(now)]
        },
        "loggingStreamCollect": { [unowned self] in try await loggingStreamCollect($0) },
        "loggingStreamClose": { [unowned self] in try await loggingStreamClose($0) },
    ] }

    private func streamTable() -> [String: Fold] { [
        "completion": { [unowned self] in try await completion($0, $1) },
        "translate": { [unowned self] in try await translate($0, $1) },
        "ocr": { [unowned self] in try await ocr($0, $1) },
        "transcribeStream": { [unowned self] in try await transcribeStream($0, $1) },
        "textToSpeech": { [unowned self] in try await textToSpeech($0, $1) },
        "batchCompletion": { [unowned self] in try await batchCompletion($0, $1) },
        "transcribeStreamDrain": { [unowned self] in try await transcribeStreamDrain($0, $1) },
        "invokePluginStream": { [unowned self] in try await pluginStream($0, $1) },
        "diffusion": { [unowned self] in try await diffusion($0, $1) },
        "upscale": { [unowned self] in try await upscale($0, $1) },
        "finetune": { [unowned self] in try await finetune($0, $1) },
    ] }

    /// The SDK server's own log stream, as the JS client names it.
    private static let sdkLogId = "__engine__"
}

extension JSONValue {
    var objectFields: [String: JSONValue] {
        if case .object(let object) = self { return object }
        return [:]
    }
}
