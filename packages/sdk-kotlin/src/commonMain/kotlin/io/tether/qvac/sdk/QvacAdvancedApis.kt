package io.tether.qvac.sdk

import io.tether.qvac.sdk.generated.schema.*
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch

/** Cold log stream: collection opens it; cancellation unsubscribes at the RPC layer. */
fun QvacClient.serverLogs(id: String = "__all__"): Flow<LoggingStreamResponse> =
    loggingStream(LoggingStreamRequest(id = id))

/** The caller owns the subscription lifetime and handles failures through its scope. */
fun QvacClient.subscribeServerLogs(scope: CoroutineScope, handler: suspend (LoggingStreamResponse) -> Unit): Job =
    scope.launch { serverLogs().collect(handler) }

val QvacClient.registry: QvacRegistry get() = QvacRegistry(this)
val QvacClient.plugins: QvacPlugins get() = QvacPlugins(this)
val QvacClient.retrieval: QvacRetrieval get() = QvacRetrieval(this)
val QvacClient.training: QvacTraining get() = QvacTraining(this)

class QvacRegistry internal constructor(private val client: QvacClient) {
    suspend fun list(): ModelRegistryListResponse = client.modelRegistryList(ModelRegistryListRequest())
    suspend fun search(request: ModelRegistrySearchRequest): ModelRegistrySearchResponse = client.modelRegistrySearch(request)
    suspend fun get(source: String, path: String): ModelRegistryGetModelResponse =
        client.modelRegistryGetModel(ModelRegistryGetModelRequest(registrySource = source, registryPath = path))
}

/** Plugin-defined payloads stay JsonElement because the core contract deliberately leaves them open. */
class QvacPlugins internal constructor(private val client: QvacClient) {
    suspend fun invoke(request: PluginInvokeRequest): PluginInvokeResponse = client.pluginInvoke(request)
    fun stream(request: PluginInvokeStreamRequest): Flow<PluginInvokeStreamResponse> = client.pluginInvokeStream(request)
}

class QvacRetrieval internal constructor(private val client: QvacClient) {
    suspend fun execute(request: RagRequest): RagResponse = client.rag(request)
    fun progress(request: RagRequest): Flow<QvacProgressEvent<RagProgressResponse, RagResponse>> = client.ragWithProgress(request)
}

class QvacTraining internal constructor(private val client: QvacClient) {
    suspend fun execute(request: FinetuneRequest): FinetuneResponse = client.finetune(request)
    fun progress(request: FinetuneRequest): Flow<QvacProgressEvent<FinetuneProgressResponse, FinetuneResponse>> = client.finetuneWithProgress(request)
}
