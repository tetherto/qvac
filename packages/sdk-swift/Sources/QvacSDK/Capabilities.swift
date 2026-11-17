import Foundation

extension QvacClient {
    public var models: QvacModels { QvacModels(client: self) }
    public var completion: QvacCompletion { QvacCompletion(client: self) }
    public var system: QvacSystem { QvacSystem(client: self) }
    public var raw: QvacRaw { QvacRaw(client: self) }
}

public struct QvacModels: Sendable {
    let client: QvacClient

    /// Loads with the fully typed request, including engine-specific configuration.
    public func load(_ request: LoadModelRequest) async throws -> LoadModelResponse {
        try await client.loadModel(request)
    }

    /// Loads `source` with an untyped `modelConfig`. Use the `LoadModelRequest`
    /// overload for typed engine configuration.
    public func load(
        source: String,
        modelType: String,
        modelName: String? = nil,
        requestId: String? = nil,
        modelConfig: [String: JSONValue]? = nil
    ) async throws -> LoadModelResponse {
        try await client.loadModel(
            sourceLoadRequest(source, modelType, modelName, requestId, modelConfig, withProgress: nil))
    }

    public func loadWithProgress(
        source: String,
        modelType: String,
        modelName: String? = nil,
        requestId: String? = nil,
        modelConfig: [String: JSONValue]? = nil
    ) -> AsyncThrowingStream<QvacProgressEvent<ModelProgressResponse, LoadModelResponse>, Error> {
        client.loadModelWithProgress(
            sourceLoadRequest(source, modelType, modelName, requestId, modelConfig, withProgress: true))
    }

    public func load(
        _ model: ModelConstant,
        requestId: String? = nil,
        modelConfig: [String: JSONValue]? = nil
    ) async throws -> LoadModelResponse {
        try await load(
            source: model.src, modelType: model.engine, modelName: model.name, requestId: requestId,
            modelConfig: modelConfig)
    }

    public func loadWithProgress(
        _ model: ModelConstant,
        requestId: String? = nil,
        modelConfig: [String: JSONValue]? = nil
    ) -> AsyncThrowingStream<QvacProgressEvent<ModelProgressResponse, LoadModelResponse>, Error> {
        loadWithProgress(
            source: model.src, modelType: model.engine, modelName: model.name, requestId: requestId,
            modelConfig: modelConfig)
    }

    public func unload(_ modelId: String, clearStorage: Bool? = nil) async throws -> UnloadModelResponse {
        try await client.unloadModel(UnloadModelRequest(modelId: modelId, clearStorage: clearStorage))
    }

    public func info(name: String) async throws -> GetModelInfoResponse {
        try await client.getModelInfo(GetModelInfoRequest(name: name))
    }

    public func loadedInfo(modelId: String) async throws -> GetLoadedModelInfoResponse {
        try await client.getLoadedModelInfo(GetLoadedModelInfoRequest(modelId: modelId))
    }

    public func assessFit(_ request: AssessModelFitRequest) async throws -> AssessModelFitResponse {
        try await client.assessModelFit(request)
    }

    public func download(source: String, requestId: String? = nil, seed: Bool? = nil) async throws
        -> DownloadAssetResponse
    {
        try await client.downloadAsset(DownloadAssetRequest(assetSrc: source, seed: seed, requestId: requestId))
    }

    public func downloadWithProgress(source: String, requestId: String? = nil, seed: Bool? = nil)
        -> AsyncThrowingStream<QvacProgressEvent<ModelProgressResponse, DownloadAssetResponse>, Error>
    {
        client.downloadAssetWithProgress(
            DownloadAssetRequest(assetSrc: source, withProgress: true, seed: seed, requestId: requestId))
    }
}

// The custom-plugin variant takes any modelType with an untyped modelConfig. A
// built-in engine gets the same JSON through it as through its own variant.
private func sourceLoadRequest(
    _ source: String,
    _ modelType: String,
    _ modelName: String?,
    _ requestId: String?,
    _ modelConfig: [String: JSONValue]?,
    withProgress: Bool?
) -> LoadModelRequest {
    .loadModelSrcRequest(
        .loadModelCustomPluginRequest(
            LoadModelCustomPluginRequest(
                modelSrc: source,
                modelName: modelName,
                withProgress: withProgress,
                requestId: requestId,
                modelType: modelType,
                modelConfig: modelConfig)))
}

/// Pausing and resuming change the runtime for every caller.
public struct QvacSystem: Sendable {
    let client: QvacClient

    public func pause() async throws -> SuspendResponse {
        try await client.suspend(SuspendRequest())
    }

    public func resume() async throws -> ResumeResponse {
        try await client.resume(ResumeRequest())
    }

    public func state() async throws -> StateResponse {
        try await client.state(StateRequest())
    }

    public func resources(includeUsageSnapshot: Bool = false) async throws -> GetSystemResourcesResponse {
        try await client.getSystemResources(GetSystemResourcesRequest(sample: includeUsageSnapshot))
    }
}

/// Untyped JSON calls, for requests outside the generated types.
public struct QvacRaw: Sendable {
    let client: QvacClient

    public func call(_ payload: [String: JSONValue]) async throws -> [String: JSONValue] {
        try await client.callTyped(payload)
    }

    public func stream(_ payload: [String: JSONValue]) -> AsyncThrowingStream<[String: JSONValue], Error> {
        client.streamTyped(payload, map: { $0 })
    }

    public func duplex(_ payload: [String: JSONValue], input: AsyncStream<Data>)
        -> AsyncThrowingStream<[String: JSONValue], Error>
    {
        client.duplexTyped(payload, input: input, map: { $0 })
    }
}
