package io.tether.qvac.sdk

import io.tether.qvac.sdk.generated.ModelConstant
import io.tether.qvac.sdk.generated.schema.AssessModelFitRequest
import io.tether.qvac.sdk.generated.schema.AssessModelFitResponse
import io.tether.qvac.sdk.generated.schema.BatchCompletionStreamRequest
import io.tether.qvac.sdk.generated.schema.BatchCompletionStreamResponse
import io.tether.qvac.sdk.generated.schema.CompletionStreamRequest
import io.tether.qvac.sdk.generated.schema.CompletionStreamResponse
import io.tether.qvac.sdk.generated.schema.CompletionStreamResponseEventsItem
import io.tether.qvac.sdk.generated.schema.DownloadAssetRequest
import io.tether.qvac.sdk.generated.schema.DownloadAssetResponse
import io.tether.qvac.sdk.generated.schema.GetLoadedModelInfoRequest
import io.tether.qvac.sdk.generated.schema.GetLoadedModelInfoResponse
import io.tether.qvac.sdk.generated.schema.GetModelInfoRequest
import io.tether.qvac.sdk.generated.schema.GetModelInfoResponse
import io.tether.qvac.sdk.generated.schema.GetSystemResourcesRequest
import io.tether.qvac.sdk.generated.schema.GetSystemResourcesResponse
import io.tether.qvac.sdk.generated.schema.LoadModelCustomPluginRequest
import io.tether.qvac.sdk.generated.schema.LoadModelRequest
import io.tether.qvac.sdk.generated.schema.LoadModelResponse
import io.tether.qvac.sdk.generated.schema.LoadModelSrcRequest
import io.tether.qvac.sdk.generated.schema.ModelProgressResponse
import io.tether.qvac.sdk.generated.schema.ResumeRequest
import io.tether.qvac.sdk.generated.schema.ResumeResponse
import io.tether.qvac.sdk.generated.schema.StateRequest
import io.tether.qvac.sdk.generated.schema.StateResponse
import io.tether.qvac.sdk.generated.schema.SuspendRequest
import io.tether.qvac.sdk.generated.schema.SuspendResponse
import io.tether.qvac.sdk.generated.schema.UnloadModelRequest
import io.tether.qvac.sdk.generated.schema.UnloadModelResponse
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import kotlinx.serialization.json.JsonObject

/**
 * Capability-oriented entry points over the generated wire API.
 *
 * The generated request/response types remain available for every operation.
 * These wrappers provide the common model, completion, system, and raw paths
 * without hiding the complete contract.
 */
val QvacClient.models: QvacModels
    get() = QvacModels(this)

val QvacClient.completion: QvacCompletion
    get() = QvacCompletion(this)

val QvacClient.system: QvacSystem
    get() = QvacSystem(this)

val QvacClient.raw: QvacRaw
    get() = QvacRaw(this)

class QvacModels internal constructor(
    private val client: QvacClient,
) {
    /** Fully typed load configuration, including engine-specific union arms. */
    suspend fun load(request: LoadModelRequest): LoadModelResponse = client.loadModel(request)

    suspend fun info(name: String): GetModelInfoResponse =
        client.getModelInfo(GetModelInfoRequest(name = name))

    suspend fun loadedInfo(modelId: String): GetLoadedModelInfoResponse =
        client.getLoadedModelInfo(GetLoadedModelInfoRequest(modelId = modelId))

    suspend fun assessFit(request: AssessModelFitRequest): AssessModelFitResponse =
        client.assessModelFit(request)

    suspend fun download(
        source: String,
        requestId: String? = null,
        seed: Boolean? = null,
    ): DownloadAssetResponse {
        return client.downloadAsset(
            DownloadAssetRequest(
                assetSrc = source,
                requestId = requestId,
                seed = seed,
            ),
        )
    }

    fun downloadWithProgress(
        source: String,
        requestId: String? = null,
        seed: Boolean? = null,
    ): Flow<QvacProgressEvent<ModelProgressResponse, DownloadAssetResponse>> {
        return client.downloadAssetWithProgress(
            DownloadAssetRequest(
                assetSrc = source,
                requestId = requestId,
                seed = seed,
                withProgress = true,
            ),
        )
    }

    /**
     * Loads [source] with an untyped [modelConfig]. Use the [LoadModelRequest] overload
     * for engine-specific typed configuration.
     */
    suspend fun load(
        source: String,
        modelType: String,
        modelName: String? = null,
        requestId: String? = null,
        modelConfig: JsonObject? = null,
    ): LoadModelResponse {
        return client.loadModel(sourceLoadRequest(source, modelType, modelName, requestId, modelConfig, null))
    }

    fun loadWithProgress(
        source: String,
        modelType: String,
        modelName: String? = null,
        requestId: String? = null,
        modelConfig: JsonObject? = null,
    ): Flow<QvacProgressEvent<ModelProgressResponse, LoadModelResponse>> {
        return client.loadModelWithProgress(
            sourceLoadRequest(source, modelType, modelName, requestId, modelConfig, withProgress = true),
        )
    }

    suspend fun load(
        model: ModelConstant,
        requestId: String? = null,
    ): LoadModelResponse {
        return load(
            source = model.src,
            modelType = model.engine,
            modelName = model.name,
            requestId = requestId,
        )
    }

    suspend fun unload(
        modelId: String,
        clearStorage: Boolean? = null,
    ): UnloadModelResponse {
        return client.unloadModel(
            UnloadModelRequest(
                clearStorage = clearStorage,
                modelId = modelId,
            ),
        )
    }
}

private fun sourceLoadRequest(
    source: String,
    modelType: String,
    modelName: String?,
    requestId: String?,
    modelConfig: JsonObject?,
    withProgress: Boolean?,
): LoadModelRequest = LoadModelRequest.LoadModelSrcRequest(
    LoadModelSrcRequest.LoadModelCustomPluginRequest(
        LoadModelCustomPluginRequest(
            modelSrc = source,
            modelName = modelName,
            withProgress = withProgress,
            requestId = requestId,
            modelType = modelType,
            modelConfig = modelConfig,
        ),
    ),
)

class QvacCompletion internal constructor(
    internal val client: QvacClient,
) {
    fun batch(request: BatchCompletionStreamRequest): Flow<BatchCompletionStreamResponse> =
        client.batchCompletionStream(request)

    fun stream(request: CompletionStreamRequest): Flow<CompletionStreamResponse> {
        return client.completionStream(request)
    }

    fun text(request: CompletionStreamRequest): Flow<String> {
        return stream(request).map { response ->
            // rawDelta and thinkingDelta events also carry text; only the
            // answer tokens live on contentDelta.
            response.events.filterIsInstance<CompletionStreamResponseEventsItem.ContentDelta>()
                .joinToString(separator = "") { it.value.text }
        }
    }
}

class QvacSystem internal constructor(
    private val client: QvacClient,
) {
    suspend fun pause(): SuspendResponse = client.`suspend`(SuspendRequest())

    suspend fun resume(): ResumeResponse = client.resume(ResumeRequest())

    suspend fun state(): StateResponse = client.state(StateRequest())

    suspend fun resources(includeUsageSnapshot: Boolean = false): GetSystemResourcesResponse {
        return client.getSystemResources(GetSystemResourcesRequest(sample = includeUsageSnapshot))
    }
}

class QvacRaw internal constructor(
    private val client: QvacClient,
) {
    suspend fun call(payload: JsonObject): JsonObject = client.call(payload)

    fun stream(payload: JsonObject): Flow<JsonObject> = client.stream(payload)

    fun duplex(payload: JsonObject, input: Flow<ByteArray>): Flow<JsonObject> {
        return client.duplex(payload, input)
    }
}
