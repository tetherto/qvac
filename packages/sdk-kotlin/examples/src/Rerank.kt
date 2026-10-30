// Kotlin port of packages/sdk/examples/rerank.ts.
//
// Loads a small reranker, or a GGUF path or URL passed as the first argument,
// scores four support articles against a question, and prints them from most to
// least relevant.
//
// `client.rerank()` is the generated contract method: it takes a typed
// `RerankRequest` and returns a `RerankResponse` whose `scores` hold one score
// per document, in input order.
//
// RUN: ./gradlew run -Pexample=Rerank --args="[path-or-url-to-reranker.gguf]"

import io.tether.qvac.sdk.JvmBareRpcTransport
import io.tether.qvac.sdk.QvacClient
import io.tether.qvac.sdk.generated.schema.RerankRequest
import io.tether.qvac.sdk.models
import io.tether.qvac.sdk.rerank
import kotlinx.coroutines.runBlocking

// Any reranker (cross-encoder) GGUF, such as bge-reranker, jina-reranker or
// Qwen3-Reranker.
private const val DEFAULT_MODEL_SRC = "https://huggingface.co/ggml-org/models/resolve/" +
    "499bc8821c6b12b4e53c5bffcb21ec206f212d81/" +
    "jina-reranker-v1-tiny-en/ggml-model-f16.gguf"

private const val QUERY = "How do I get a refund for a duplicate charge?"
private val DOCUMENTS = listOf(
    "Refunds for duplicate or failed payments are issued within 5 business days.",
    "Our office is open Monday to Friday, 9am to 5pm.",
    "To change your password, open Settings and choose Security.",
    "If you were charged twice, contact billing with both transaction IDs.",
)

fun main(args: Array<String>): Unit = runBlocking {
    val modelSrc = args.getOrNull(0) ?: DEFAULT_MODEL_SRC

    val client = QvacClient(JvmBareRpcTransport.connectResolved(installWorkerIfMissing = true))
    try {
        System.err.println("▸ Loading reranker")
        val loaded = client.models.load(source = modelSrc, modelType = "llamacpp-rerank")
        val modelId = loaded.modelId ?: error(loaded.error ?: "loadModel failed")
        try {
            // One score per document, in input order. Higher is more relevant.
            val response = client.rerank(RerankRequest(modelId = modelId, query = QUERY, documents = DOCUMENTS))
            val ranked = response.scores.zip(DOCUMENTS).sortedByDescending { (score, _) -> score }
            println("Query: $QUERY\n")
            for ((score, document) in ranked) {
                println("%.3f  %s".format(score, document))
            }
        } finally {
            client.models.unload(modelId)
        }
    } finally {
        client.close()
    }
}
