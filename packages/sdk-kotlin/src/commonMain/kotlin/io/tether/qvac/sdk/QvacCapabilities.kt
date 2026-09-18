package io.tether.qvac.sdk

import io.tether.qvac.sdk.generated.CompletionStreamRequest
import io.tether.qvac.sdk.generated.CompletionStreamResponse
import io.tether.qvac.sdk.generated.DownloadAssetRequest
import io.tether.qvac.sdk.generated.DownloadAssetResponse
import io.tether.qvac.sdk.generated.GetSystemResourcesRequest
import io.tether.qvac.sdk.generated.GetSystemResourcesResponse
import io.tether.qvac.sdk.generated.LoadModelRequest
import io.tether.qvac.sdk.generated.LoadModelResponse
import io.tether.qvac.sdk.generated.ModelConstant
import io.tether.qvac.sdk.generated.ModelProgressResponse
import io.tether.qvac.sdk.generated.UnloadModelRequest
import io.tether.qvac.sdk.generated.UnloadModelResponse
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive

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
    suspend fun load(request: io.tether.qvac.sdk.generated.schema.LoadModelRequest): io.tether.qvac.sdk.generated.schema.LoadModelResponse =
        client.loadModel(request)

    suspend fun info(name: String): io.tether.qvac.sdk.generated.schema.GetModelInfoResponse =
        client.getModelInfo(io.tether.qvac.sdk.generated.schema.GetModelInfoRequest(name = name))

    suspend fun loadedInfo(modelId: String): io.tether.qvac.sdk.generated.schema.GetLoadedModelInfoResponse =
        client.getLoadedModelInfo(io.tether.qvac.sdk.generated.schema.GetLoadedModelInfoRequest(modelId = modelId))

    suspend fun assessFit(request: io.tether.qvac.sdk.generated.schema.AssessModelFitRequest): io.tether.qvac.sdk.generated.schema.AssessModelFitResponse =
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
                type = "downloadAsset",
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
                type = "downloadAsset",
                withProgress = true,
            ),
        )
    }

    suspend fun load(
        source: String,
        modelType: String? = null,
        modelName: String? = null,
        requestId: String? = null,
        modelConfig: JsonObject? = null,
    ): LoadModelResponse {
        return client.loadModel(
            LoadModelRequest(
                modelName = modelName,
                modelSrc = JsonPrimitive(source),
                modelType = modelType,
                modelConfig = modelConfig,
                requestId = requestId,
                type = "loadModel",
            ),
        )
    }

    fun loadWithProgress(
        source: String,
        modelType: String? = null,
        modelName: String? = null,
        requestId: String? = null,
        modelConfig: JsonObject? = null,
    ): Flow<QvacProgressEvent<ModelProgressResponse, LoadModelResponse>> {
        return client.loadModelWithProgress(
            LoadModelRequest(
                modelName = modelName,
                modelSrc = JsonPrimitive(source),
                modelType = modelType,
                modelConfig = modelConfig,
                requestId = requestId,
                type = "loadModel",
                withProgress = JsonPrimitive(true),
            ),
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
                type = "unloadModel",
            ),
        )
    }
}

class QvacCompletion internal constructor(
    internal val client: QvacClient,
) {
    fun batch(request: io.tether.qvac.sdk.generated.schema.BatchCompletionStreamRequest): Flow<io.tether.qvac.sdk.generated.schema.BatchCompletionStreamResponse> =
        client.batchCompletionStream(request)

    fun stream(request: CompletionStreamRequest): Flow<CompletionStreamResponse> {
        return client.completionStream(request)
    }

    fun text(request: CompletionStreamRequest): Flow<String> {
        return stream(request).map { response ->
            response.events.mapNotNull(JsonElement::textValue).joinToString(separator = "")
        }
    }
}

class QvacSystem internal constructor(
    private val client: QvacClient,
) {
    suspend fun pause(): io.tether.qvac.sdk.generated.schema.SuspendResponse =
        client.`suspend`(io.tether.qvac.sdk.generated.schema.SuspendRequest())

    suspend fun resume(): io.tether.qvac.sdk.generated.schema.ResumeResponse =
        client.resume(io.tether.qvac.sdk.generated.schema.ResumeRequest())

    suspend fun state(): io.tether.qvac.sdk.generated.schema.StateResponse =
        client.state(io.tether.qvac.sdk.generated.schema.StateRequest())

    suspend fun resources(includeUsageSnapshot: Boolean = false): GetSystemResourcesResponse {
        return client.getSystemResources(
            GetSystemResourcesRequest(
                sample = includeUsageSnapshot,
                type = "getSystemResources",
            ),
        )
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

private fun JsonElement.textValue(): String? {
    val objectValue = this as? JsonObject
    val text = objectValue?.get("text")?.jsonPrimitive?.contentOrNull
    if (text != null) {
        return text
    }
    return objectValue?.get("content")?.jsonPrimitive?.contentOrNull
}
