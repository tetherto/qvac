import Foundation

extension QvacClient {
    public var speech: QvacSpeech { QvacSpeech(client: self) }
    public var bci: QvacBci { QvacBci(client: self) }
    public var vision: QvacVision { QvacVision(client: self) }
    public var translation: QvacTranslation { QvacTranslation(client: self) }
    public var embeddings: QvacEmbeddings { QvacEmbeddings(client: self) }
    public var media: QvacMedia { QvacMedia(client: self) }
}

public struct QvacFeatureError: Error, Sendable, CustomStringConvertible {
    public let message: String

    public var description: String { message }
}

public enum QvacDataInput: Sendable, Hashable {
    case filePath(String)
    case base64(String)
}

public struct QvacTranscriptionSegment: Sendable, Hashable {
    public let text: String
    public let startMs: Double
    public let endMs: Double
    public let append: Bool
    public let id: Double
}

public struct QvacTranscriptionResult: Sendable {
    /// Empty when the request asked for `metadata`: the worker then sends the transcript as `segments` only.
    public let text: String
    public let segments: [QvacTranscriptionSegment]
    public let stats: [String: JSONValue]?
}

public struct QvacVoiceOptions: Sendable, Hashable {
    public var voice: String?
    public var description: String?
    public var emotion: TextToSpeechRequestEmotion?
    public var pitch: String?
    public var pace: TextToSpeechRequestPace?
    public var expressivity: String?
    public var noise: String?
    public var reverb: String?
    public var quality: String?

    public init(
        voice: String? = nil,
        description: String? = nil,
        emotion: TextToSpeechRequestEmotion? = nil,
        pitch: String? = nil,
        pace: TextToSpeechRequestPace? = nil,
        expressivity: String? = nil,
        noise: String? = nil,
        reverb: String? = nil,
        quality: String? = nil
    ) {
        self.voice = voice
        self.description = description
        self.emotion = emotion
        self.pitch = pitch
        self.pace = pace
        self.expressivity = expressivity
        self.noise = noise
        self.reverb = reverb
        self.quality = quality
    }
}

public struct QvacSpeechResult: Sendable {
    public let samples: [Double]
    public let sentenceChunks: [String]
    public let stats: [String: JSONValue]?
}

public struct QvacSpeech: Sendable {
    let client: QvacClient

    /// Audio bytes follow the worker's format. Finishing `audio` ends the input.
    public func transcribeStream(_ request: TranscribeStreamRequest, audio: AsyncStream<Data>)
        -> AsyncThrowingStream<TranscribeStreamResponse, Error>
    {
        client.transcribeStream(request, input: audio)
    }

    /// Text chunks are UTF-8 bytes. Frames carry their samples in `buffer`.
    public func synthesizeStream(_ request: TextToSpeechStreamRequest, text: AsyncStream<Data>)
        -> AsyncThrowingStream<TextToSpeechStreamResponse, Error>
    {
        client.textToSpeechStream(request, input: text)
    }

    public func transcribe(
        modelId: String,
        audio: QvacDataInput,
        prompt: String? = nil,
        metadata: Bool = false,
        requestId: String = qvacRequestId()
    ) async throws -> QvacTranscriptionResult {
        let request = TranscribeRequest(
            modelId: modelId, prompt: prompt, metadata: metadata, audioChunk: audio.audioChunk, requestId: requestId)
        var transcript = Transcript()
        let frames: AsyncThrowingStream<(TranscribeResponse, [String: JSONValue]), Error> = client.streamWithRaw(request)
        for try await (response, frame) in frames {
            if let error = response.error { throw QvacFeatureError(message: "Transcription failed: \(error)") }
            transcript.add(response.text, response.segment, frame)
        }
        return transcript.result
    }

    public func synthesize(modelId: String, text: String, voice: QvacVoiceOptions = QvacVoiceOptions()) async throws
        -> QvacSpeechResult
    {
        let request = TextToSpeechRequest(
            modelId: modelId,
            text: text,
            stream: true,
            description: voice.description,
            voice: voice.voice,
            emotion: voice.emotion,
            pitch: voice.pitch,
            pace: voice.pace,
            expressivity: voice.expressivity,
            noise: voice.noise,
            reverb: voice.reverb,
            quality: voice.quality)
        var samples: [Double] = []
        var sentences: [String] = []
        var stats: [String: JSONValue]?
        let frames: AsyncThrowingStream<(TextToSpeechResponse, [String: JSONValue]), Error> =
            client.streamWithRaw(request)
        for try await (response, frame) in frames {
            samples += response.withDecodedPcm().buffer
            if let sentence = response.sentenceChunk { sentences.append(sentence) }
            if case .object(let value) = frame["stats"] { stats = value }
        }
        return QvacSpeechResult(samples: samples, sentenceChunks: sentences, stats: stats)
    }
}

public struct QvacBciStreamOptions: Sendable, Hashable {
    public var windowTimesteps: Int?
    public var hopTimesteps: Int?
    public var emit: BciTranscribeStreamRequestStreamOptsEmit?

    public init(
        windowTimesteps: Int? = nil,
        hopTimesteps: Int? = nil,
        emit: BciTranscribeStreamRequestStreamOptsEmit? = nil
    ) {
        self.windowTimesteps = windowTimesteps
        self.hopTimesteps = hopTimesteps
        self.emit = emit
    }

    func wire() throws -> BciTranscribeStreamRequestStreamOpts? {
        if let windowTimesteps, windowTimesteps <= 0 {
            throw QvacFeatureError(message: "windowTimesteps must be positive")
        }
        if let hopTimesteps, hopTimesteps <= 0 { throw QvacFeatureError(message: "hopTimesteps must be positive") }
        if let windowTimesteps, let hopTimesteps, hopTimesteps >= windowTimesteps {
            throw QvacFeatureError(message: "hopTimesteps must be less than windowTimesteps")
        }
        if windowTimesteps == nil, hopTimesteps == nil, emit == nil { return nil }
        return BciTranscribeStreamRequestStreamOpts(
            windowTimesteps: windowTimesteps, hopTimesteps: hopTimesteps, emit: emit)
    }
}

public struct QvacBci: Sendable {
    let client: QvacClient

    public func transcribe(
        modelId: String,
        neuralData: QvacDataInput,
        metadata: Bool = false,
        requestId: String = qvacRequestId()
    ) async throws -> QvacTranscriptionResult {
        let request = BciTranscribeRequest(
            modelId: modelId, metadata: metadata, neuralData: neuralData.neuralData, requestId: requestId)
        var transcript = Transcript()
        let frames: AsyncThrowingStream<(BciTranscribeResponse, [String: JSONValue]), Error> =
            client.streamWithRaw(request)
        for try await (response, frame) in frames {
            if let error = response.error { throw QvacFeatureError(message: "BCI transcription failed: \(error)") }
            transcript.add(response.text, response.segment, frame)
        }
        return transcript.result
    }

    public func transcribeStream(
        modelId: String,
        neuralChunks: AsyncStream<Data>,
        metadata: Bool = false,
        options: QvacBciStreamOptions = QvacBciStreamOptions(),
        requestId: String = qvacRequestId()
    ) async throws -> QvacTranscriptionResult {
        let request = BciTranscribeStreamRequest(
            modelId: modelId, metadata: metadata, streamOpts: try options.wire(), requestId: requestId)
        var transcript = Transcript()
        let frames: AsyncThrowingStream<(BciTranscribeStreamResponse, [String: JSONValue]), Error> =
            client.duplexWithRaw(request, input: neuralChunks)
        for try await (response, frame) in frames {
            if let error = response.error {
                throw QvacFeatureError(message: "BCI streaming transcription failed: \(error)")
            }
            transcript.add(response.text, response.segment, frame)
        }
        return transcript.result
    }
}

protocol TranscriptSegment {
    var text: String { get }
    var startMs: Double { get }
    var endMs: Double { get }
    var append: Bool { get }
    var id: Double { get }
}

extension TranscribeResponseSegment: TranscriptSegment {}

extension BciTranscribeStreamResponseSegment: TranscriptSegment {}

private struct Transcript {
    var text = ""
    var segments: [QvacTranscriptionSegment] = []
    var stats: [String: JSONValue]?

    mutating func add(_ piece: String?, _ segment: (any TranscriptSegment)?, _ frame: [String: JSONValue]) {
        if let piece { text += piece }
        if let segment {
            segments.append(
                QvacTranscriptionSegment(
                    text: segment.text, startMs: segment.startMs, endMs: segment.endMs, append: segment.append,
                    id: segment.id))
        }
        if case .object(let value) = frame["stats"] { stats = value }
    }

    var result: QvacTranscriptionResult {
        QvacTranscriptionResult(text: text, segments: segments, stats: stats)
    }
}

public struct QvacOcrBlock: Sendable, Hashable {
    public let text: String
    public let boundingBox: [Double]
    public let confidence: Double?
}

public struct QvacOcrResult: Sendable {
    public let blocks: [QvacOcrBlock]
    public let stats: [String: JSONValue]?

    public var text: String { blocks.map(\.text).joined(separator: "\n") }
}

public struct QvacClassification: Sendable, Hashable {
    public let label: String
    public let confidence: Double
}

public struct QvacVision: Sendable {
    let client: QvacClient

    public func ocr(
        modelId: String,
        image: QvacDataInput,
        paragraph: Bool = true,
        requestId: String = qvacRequestId()
    ) async throws -> QvacOcrResult {
        let request = OcrStreamRequest(
            modelId: modelId, image: image.ocrImage, options: OcrStreamRequestOptions(paragraph: paragraph),
            requestId: requestId)
        var blocks: [QvacOcrBlock] = []
        var stats: [String: JSONValue]?
        let frames: AsyncThrowingStream<(OcrStreamResponse, [String: JSONValue]), Error> = client.streamWithRaw(request)
        for try await (response, frame) in frames {
            if let error = response.error { throw QvacFeatureError(message: "OCR failed: \(error)") }
            for block in response.blocks ?? [] {
                blocks.append(
                    QvacOcrBlock(
                        text: block.text, boundingBox: (block.bbox ?? []).compactMap(\.numberValue),
                        confidence: block.confidence))
            }
            if case .object(let value) = frame["stats"] { stats = value }
        }
        return QvacOcrResult(blocks: blocks, stats: stats)
    }

    public func classify(
        modelId: String,
        imageBase64: String,
        width: Int? = nil,
        height: Int? = nil,
        channels: Int? = nil,
        topK: Int? = nil,
        requestId: String = qvacRequestId()
    ) async throws -> [QvacClassification] {
        let request = ClassifyRequest(
            modelId: modelId, image: imageBase64, topK: topK, width: width, height: height,
            channels: channels.map(Double.init), requestId: requestId)
        var results: [QvacClassification] = []
        for try await response in client.classify(request) {
            results += response.results.map { QvacClassification(label: $0.label, confidence: $0.confidence) }
        }
        return results
    }
}

public struct QvacTranslationFinal: Sendable {
    public let text: String
    public let stats: [String: JSONValue]?
}

/// One running translation. Read `tokens` as it translates, or wait for `final`.
public final class QvacTranslationRun: Sendable {
    public let requestId: String
    public let tokens: AsyncThrowingStream<String, Error>
    private let result: Task<QvacTranslationFinal, Error>
    private let client: QvacClient

    init(requestId: String, client: QvacClient, request: TranslateRequest) {
        self.requestId = requestId
        self.client = client
        let (tokens, sink) = AsyncThrowingStream<String, Error>.makeStream()
        self.tokens = tokens
        result = Task {
            var text = ""
            var stats: [String: JSONValue]?
            do {
                let frames: AsyncThrowingStream<(TranslateResponse, [String: JSONValue]), Error> =
                    client.streamWithRaw(request)
                for try await (response, frame) in frames {
                    if let error = response.error { throw QvacFeatureError(message: "Translation failed: \(error)") }
                    text += response.token
                    if !response.token.isEmpty { sink.yield(response.token) }
                    if case .object(let value) = frame["stats"] { stats = value }
                }
            } catch {
                sink.finish(throwing: error)
                throw error
            }
            sink.finish()
            return QvacTranslationFinal(text: text, stats: stats)
        }
    }

    public var final: QvacTranslationFinal {
        get async throws { try await result.value }
    }

    public func text() async throws -> String { try await final.text }

    public func cancel() async throws -> Bool {
        let reply = try await client.cancel(.request(CancelRequestRequest(requestId: requestId)))
        return reply.success && (reply.cancelled ?? 0) > 0
    }
}

public struct QvacTranslation: Sendable {
    let client: QvacClient

    /// `modelType` selects the engine: "nmt" or "nmtcpp-translation" models
    /// translate in the direction fixed at load time, while "llm" or
    /// "llamacpp-completion" models need `to`.
    public func run(
        modelId: String,
        text: String,
        modelType: String,
        to: String? = nil,
        from: String? = nil,
        context: String? = nil,
        stream: Bool = true,
        requestId: String = qvacRequestId()
    ) throws -> QvacTranslationRun {
        let request: TranslateRequest
        if let nmt = TranslateNmtRequestModelType(rawValue: modelType) {
            guard to == nil, from == nil, context == nil else {
                throw QvacFeatureError(
                    message: "from, to and context apply to LLM translation only; NMT direction is fixed when the model loads")
            }
            request = .translateNmtRequest(
                TranslateNmtRequest(
                    modelId: modelId, text: .variant1(text), stream: stream, modelType: nmt, requestId: requestId))
        } else if let llm = TranslateLlmRequestModelType(rawValue: modelType) {
            guard let to else { throw QvacFeatureError(message: "LLM translation requires a target language") }
            request = .translateLlmRequest(
                TranslateLlmRequest(
                    modelId: modelId, text: text, stream: stream, modelType: llm, from: from, to: to,
                    context: context, requestId: requestId))
        } else {
            throw QvacFeatureError(message: "Unknown translation modelType '\(modelType)'")
        }
        return QvacTranslationRun(requestId: requestId, client: client, request: request)
    }
}

public struct QvacEmbeddings: Sendable {
    let client: QvacClient

    public func embed(modelId: String, text: String, requestId: String = qvacRequestId()) async throws -> [Double] {
        let vectors = try await embed(modelId: modelId, input: .variant1(text), requestId: requestId)
        guard vectors.count == 1 else { throw QvacFeatureError(message: "Expected one embedding, got \(vectors.count)") }
        return vectors[0]
    }

    public func embed(modelId: String, texts: [String], requestId: String = qvacRequestId()) async throws -> [[Double]] {
        try await embed(modelId: modelId, input: .variant2(texts), requestId: requestId)
    }

    private func embed(modelId: String, input: EmbedTextRequestText, requestId: String) async throws -> [[Double]] {
        let response = try await client.embed(
            .embedTextRequest(EmbedTextRequest(modelId: modelId, text: input, requestId: requestId)))
        guard response.success else { throw QvacFeatureError(message: response.error ?? "Embedding failed") }
        switch response.embedding {
        case .variant1(let vector): return [vector]
        case .variant2(let vectors): return vectors
        }
    }
}

public struct QvacMediaResult: Sendable {
    /// The base64 data of each output frame, in order.
    public let data: [String]
    public let stats: [String: JSONValue]?
    public let stopReason: String?
}

/// One running media generation. Read `events` as it generates, or wait for
/// `final`.
public final class QvacMediaRun<Event: Sendable>: Sendable {
    public let requestId: String
    public let events: AsyncThrowingStream<Event, Error>
    private let result: Task<QvacMediaResult, Error>
    private let client: QvacClient

    init(
        requestId: String,
        client: QvacClient,
        source: AsyncThrowingStream<(Event, [String: JSONValue]), Error>,
        frame: @escaping @Sendable (Event) -> (data: String?, stopReason: String?)
    ) {
        self.requestId = requestId
        self.client = client
        let (events, sink) = AsyncThrowingStream<Event, Error>.makeStream()
        self.events = events
        result = Task {
            var data: [String] = []
            var stats: [String: JSONValue]?
            var stopReason: String?
            do {
                for try await (event, raw) in source {
                    sink.yield(event)
                    let value = frame(event)
                    if let piece = value.data { data.append(piece) }
                    if case .object(let object) = raw["stats"] { stats = object }
                    if let reason = value.stopReason { stopReason = reason }
                }
            } catch {
                sink.finish(throwing: error)
                throw error
            }
            sink.finish()
            return QvacMediaResult(data: data, stats: stats, stopReason: stopReason)
        }
    }

    public var final: QvacMediaResult {
        get async throws { try await result.value }
    }

    /// Asks the worker to stop this generation. True when it was still running.
    public func cancel() async throws -> Bool {
        let reply = try await client.cancel(.request(CancelRequestRequest(requestId: requestId)))
        return reply.success && (reply.cancelled ?? 0) > 0
    }
}

/// A request without `requestId` gets one here, so every run can be cancelled.
public struct QvacMedia: Sendable {
    let client: QvacClient

    public func audio(
        modelId: String,
        caption: String,
        durationSeconds: Double? = nil,
        seed: Int? = nil,
        requestId: String = qvacRequestId()
    ) -> QvacMediaRun<AudioGenStreamResponse> {
        audio(
            AudioGenStreamRequest(
                modelId: modelId, caption: caption, seed: seed, duration: durationSeconds, requestId: requestId))
    }

    public func audio(_ request: AudioGenStreamRequest) -> QvacMediaRun<AudioGenStreamResponse> {
        var tracked = request
        let requestId = tracked.requestId ?? qvacRequestId()
        tracked.requestId = requestId
        return QvacMediaRun(requestId: requestId, client: client, source:client.streamWithRaw(tracked)) {
            ($0.data, $0.stopReason?.rawValue)
        }
    }

    public func diffusion(
        modelId: String,
        prompt: String,
        width: Int? = nil,
        height: Int? = nil,
        steps: Int? = nil,
        seed: Int? = nil,
        requestId: String = qvacRequestId()
    ) -> QvacMediaRun<DiffusionStreamResponse> {
        diffusion(
            DiffusionStreamRequest(
                modelId: modelId, prompt: prompt, width: width, height: height, steps: steps, seed: seed,
                requestId: requestId))
    }

    public func diffusion(_ request: DiffusionStreamRequest) -> QvacMediaRun<DiffusionStreamResponse> {
        var tracked = request
        let requestId = tracked.requestId ?? qvacRequestId()
        tracked.requestId = requestId
        return QvacMediaRun(requestId: requestId, client: client, source:client.streamWithRaw(tracked)) { ($0.data, nil) }
    }

    public func video(
        modelId: String,
        prompt: String,
        mode: VideoStreamRequestMode = .txt2vid,
        width: Int? = nil,
        height: Int? = nil,
        frames: Int? = nil,
        requestId: String = qvacRequestId()
    ) -> QvacMediaRun<VideoStreamResponse> {
        video(
            VideoStreamRequest(
                modelId: modelId, requestId: requestId, prompt: prompt, width: width, height: height,
                video_frames: frames, mode: mode))
    }

    public func video(_ request: VideoStreamRequest) -> QvacMediaRun<VideoStreamResponse> {
        var tracked = request
        let requestId = tracked.requestId ?? qvacRequestId()
        tracked.requestId = requestId
        return QvacMediaRun(requestId: requestId, client: client, source:client.streamWithRaw(tracked)) { ($0.data, nil) }
    }

    public func upscale(
        modelId: String,
        imageBase64: String,
        repeats: Int? = nil,
        requestId: String = qvacRequestId()
    ) -> QvacMediaRun<UpscaleStreamResponse> {
        upscale(UpscaleStreamRequest(modelId: modelId, image: imageBase64, repeats: repeats, requestId: requestId))
    }

    public func upscale(_ request: UpscaleStreamRequest) -> QvacMediaRun<UpscaleStreamResponse> {
        var tracked = request
        let requestId = tracked.requestId ?? qvacRequestId()
        tracked.requestId = requestId
        return QvacMediaRun(requestId: requestId, client: client, source:client.streamWithRaw(tracked)) { ($0.data, nil) }
    }

    public func worldScene(
        modelId: String,
        imageBase64: String,
        prompt: String,
        width: Int? = nil,
        height: Int? = nil,
        returnPack: Bool? = nil,
        requestId: String = qvacRequestId()
    ) -> QvacMediaRun<WorldSceneStreamResponse> {
        worldScene(
            WorldSceneStreamRequest(
                modelId: modelId, requestId: requestId, prompt: prompt, image: imageBase64, width: width,
                height: height, returnPack: returnPack))
    }

    public func worldScene(_ request: WorldSceneStreamRequest) -> QvacMediaRun<WorldSceneStreamResponse> {
        var tracked = request
        let requestId = tracked.requestId ?? qvacRequestId()
        tracked.requestId = requestId
        return QvacMediaRun(requestId: requestId, client: client, source:client.streamWithRaw(tracked)) { ($0.data, nil) }
    }

    /// `keys` are the held movement keys.
    public func worldStep(
        modelId: String,
        keys: [WorldStepStreamRequestKeysItem]? = nil,
        requestId: String = qvacRequestId()
    ) -> QvacMediaRun<WorldStepStreamResponse> {
        worldStep(WorldStepStreamRequest(modelId: modelId, requestId: requestId, keys: keys))
    }

    public func worldStep(_ request: WorldStepStreamRequest) -> QvacMediaRun<WorldStepStreamResponse> {
        var tracked = request
        let requestId = tracked.requestId ?? qvacRequestId()
        tracked.requestId = requestId
        return QvacMediaRun(requestId: requestId, client: client, source:client.streamWithRaw(tracked)) { ($0.data, nil) }
    }
}

extension QvacDataInput {
    var audioChunk: TranscribeRequestAudioChunk {
        switch self {
        case .filePath(let path): .filePath(.init(value: path))
        case .base64(let value): .base64(.init(value: value))
        }
    }

    var neuralData: BciTranscribeRequestNeuralData {
        switch self {
        case .filePath(let path): .filePath(.init(value: path))
        case .base64(let value): .base64(.init(value: value))
        }
    }

    var ocrImage: OcrStreamRequestImage {
        switch self {
        case .filePath(let path): .filePath(.init(value: path))
        case .base64(let value): .base64(.init(value: value))
        }
    }
}
