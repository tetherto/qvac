// Kotlin port of packages/sdk/examples/rag/rag-hyperdb/ingest.ts.
//
// Ingest documents into a built-in RAG workspace and query them with similarity
// search, without setting up an external vector DB.
//
// `client.retrieval.execute()` covers every RAG operation. `RagRequest` and
// `RagResponse` are sealed classes with one variant per operation, so each
// request names its operation in the type (`RagRequest.Ingest(...)`) and each
// response is read off the matching variant (`as RagResponse.Ingest`), where
// the JS SDK has flat `ragIngest()` / `ragSearch()` wrappers.
//
// RUN: ./gradlew run -Pexample=RagManaged --args="[query]"

import io.tether.qvac.sdk.JvmBareRpcTransport
import io.tether.qvac.sdk.QvacClient
import io.tether.qvac.sdk.QvacProgressEvent
import io.tether.qvac.sdk.generated.ModelConstant
import io.tether.qvac.sdk.generated.Models
import io.tether.qvac.sdk.generated.schema.LoadModelResponse
import io.tether.qvac.sdk.generated.schema.ModelProgressResponse
import io.tether.qvac.sdk.generated.schema.RagRequest
import io.tether.qvac.sdk.generated.schema.RagRequestCloseWorkspace
import io.tether.qvac.sdk.generated.schema.RagRequestIngest
import io.tether.qvac.sdk.generated.schema.RagRequestIngestDocuments
import io.tether.qvac.sdk.generated.schema.RagRequestSearch
import io.tether.qvac.sdk.generated.schema.RagResponse
import io.tether.qvac.sdk.models
import io.tether.qvac.sdk.retrieval
import kotlinx.coroutines.runBlocking

private val SAMPLES = listOf(
    "Machine learning is a subset of artificial intelligence that focuses on algorithms that can learn and " +
        "make predictions from data without being explicitly programmed for every task.",
    "Deep learning uses neural networks with multiple layers to process and learn from complex data patterns, " +
        "enabling breakthroughs in image recognition and natural language processing.",
    "Natural language processing combines computational linguistics with machine learning to help computers " +
        "understand, interpret, and generate human language in a meaningful way.",
    "Computer vision enables machines to interpret and understand visual information from the world, using " +
        "techniques like image classification, object detection, and facial recognition.",
    "Quantum computing leverages quantum mechanical phenomena to process information in fundamentally different " +
        "ways than classical computers, potentially solving certain problems exponentially faster.",
    "Blockchain technology creates decentralized, immutable ledgers that enable secure peer-to-peer transactions " +
        "without requiring a central authority or intermediary.",
    "Cloud computing delivers computing services over the internet, allowing users to access resources like " +
        "storage, processing power, and applications on-demand from anywhere.",
    "Cybersecurity protects digital systems, networks, and data from malicious attacks, unauthorized access, and " +
        "various forms of cyber threats through multiple layers of defense.",
)

fun main(args: Array<String>): Unit = runBlocking {
    // Get query from command line or use default
    val query = args.getOrNull(0) ?: "machine learning algorithms"
    val workspace = "ingest-example"

    val client = QvacClient(JvmBareRpcTransport.connectResolved(installWorkerIfMissing = true))
    try {
        println("▸ Query: \"$query\"")
        val modelId = client.loadWithProgress(Models.GTE_LARGE_FP16)

        println("▸ Ingesting documents...")
        val ingest = client.retrieval.execute(
            RagRequest.Ingest(
                RagRequestIngest(
                    modelId = modelId,
                    workspace = workspace,
                    documents = RagRequestIngestDocuments.Variant2(SAMPLES),
                    chunk = false,
                ),
            ),
        ) as RagResponse.Ingest
        if (!ingest.value.success) error(ingest.value.error ?: "RAG ingest failed")
        println("▸ Ingested ${ingest.value.processed.size} documents")

        println("▸ Searching for similar documents...")
        val search = client.retrieval.execute(
            RagRequest.Search(
                RagRequestSearch(
                    modelId = modelId,
                    workspace = workspace,
                    query = query,
                    topK = 3.0,
                ),
            ),
        ) as RagResponse.Search
        if (!search.value.success) error(search.value.error ?: "RAG search failed")

        println("▸ Top 3 most similar documents:")
        search.value.results.forEachIndexed { index, result ->
            println("${index + 1}. (Score: ${result.score})")
            println("   ${result.content}")
            println()
        }

        // Cleanup: close and delete workspace
        val close = client.retrieval.execute(
            RagRequest.CloseWorkspace(RagRequestCloseWorkspace(workspace = workspace, deleteOnClose = true)),
        ) as RagResponse.CloseWorkspace
        if (!close.value.success) error(close.value.error ?: "RAG closeWorkspace failed")
        println("▸ Deleted '$workspace' workspace")

        client.models.unload(modelId)
    } finally {
        client.close()
    }
}

/** Load [model], printing download progress, and return its model id. */
private suspend fun QvacClient.loadWithProgress(model: ModelConstant): String {
    var result: LoadModelResponse? = null
    models.loadWithProgress(model.src, model.engine, model.name).collect { event ->
        when (event) {
            is QvacProgressEvent.Progress -> printProgress(event.value)
            is QvacProgressEvent.Result -> result = event.value
        }
    }
    val loaded = checkNotNull(result) { "loadModel ended without a result" }
    return loaded.modelId ?: error(loaded.error ?: "loadModel failed")
}

private fun printProgress(p: ModelProgressResponse) {
    val line = "▸ Downloading %.0f%% (%.1f/%.1f MB)".format(p.percentage, p.downloaded / 1e6, p.total / 1e6)
    if (System.console() != null) System.err.print("\r$line") else System.err.println(line)
    if (p.percentage >= 100) System.err.println()
}
