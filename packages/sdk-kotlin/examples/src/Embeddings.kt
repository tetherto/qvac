// Kotlin port of packages/sdk/examples/embed-p2p.ts.
//
// Single + batch text embeddings and a cosine-similarity comparison.
//
// `client.embeddings.embed()` has two overloads: a `String` returns one
// `List<Double>` vector, a `List<String>` returns one vector per text. The
// overload resolves at compile time, so neither call needs to unwrap the
// single-or-batch union the wire response carries.
//
// RUN: ./gradlew run -Pexample=Embeddings

import io.tether.qvac.sdk.JvmBareRpcTransport
import io.tether.qvac.sdk.QvacClient
import io.tether.qvac.sdk.QvacProgressEvent
import io.tether.qvac.sdk.embeddings
import io.tether.qvac.sdk.generated.ModelConstant
import io.tether.qvac.sdk.generated.Models
import io.tether.qvac.sdk.generated.schema.LoadModelResponse
import io.tether.qvac.sdk.generated.schema.ModelProgressResponse
import io.tether.qvac.sdk.models
import kotlin.math.sqrt
import kotlinx.coroutines.runBlocking

fun main(): Unit = runBlocking {
    val client = QvacClient(JvmBareRpcTransport.connectResolved(installWorkerIfMissing = true))
    try {
        val modelId = client.loadWithProgress(Models.EMBEDDINGGEMMA_300M_Q4_0)

        println("\n▸ Example 1: Single Text Embedding")
        println("=".repeat(50))
        val single = client.embeddings.embed(modelId, "Hello, world!")
        println("Input: 'Hello, world!'")
        println("Embedding dimensions: ${single.size}")
        println("First 10 values: ${single.take(10)}")

        println("\n▸ Example 2: Batch Text Embeddings")
        println("=".repeat(50))
        val texts = listOf(
            "The quick brown fox jumps over the lazy dog",
            "A fast auburn fox leaps over a sleepy canine",
            "Python is a programming language",
        )
        val batch = client.embeddings.embed(modelId, texts)
        println("Input: Array of ${texts.size} texts")
        println("Output: Array of ${batch.size} embeddings")
        val (emb1, emb2, emb3) = batch
        println("Each embedding dimensions: ${emb1.size}")

        println("\n▸ Similarity Analysis")
        println("=".repeat(50))
        println("Similarity between texts 1 and 2 (similar meaning): %.4f".format(cosineSimilarity(emb1, emb2)))
        println("Similarity between texts 1 and 3 (different topics): %.4f".format(cosineSimilarity(emb1, emb3)))
        println("\n▸ Higher values indicate more similar meanings")

        client.models.unload(modelId)
    } finally {
        client.close()
    }
}

private fun cosineSimilarity(a: List<Double>, b: List<Double>): Double {
    val dot = a.zip(b).sumOf { (x, y) -> x * y }
    val na = sqrt(a.sumOf { it * it })
    val nb = sqrt(b.sumOf { it * it })
    return dot / (na * nb)
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
