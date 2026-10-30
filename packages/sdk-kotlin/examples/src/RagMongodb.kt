// Kotlin port of packages/sdk/examples/rag/rag-mongodb.ts.
//
// Store each document in MongoDB alongside its vector, build a vector search
// index over it, and retrieve matches with a `$vectorSearch` aggregation that
// pre-filters by category.
//
// Needs the MongoDB Kotlin coroutine driver
// (`org.mongodb:mongodb-driver-kotlin-coroutine`, scoped to this example in
// build.gradle.kts) and a deployment with Atlas Vector Search. QVAC only
// produces the vectors through `client.embeddings.embed()`; the storage,
// indexing and search all belong to MongoDB.
//
// The coroutine driver mirrors the JS one closely: every collection call
// suspends, and cursors are `Flow`s collected with `toList()`. `drop()` is
// idempotent (the driver allows "ns not found"), so dropping a collection that
// was never created needs no guard, and the index-build poll waits with
// `delay` instead of a hand-rolled timer.
//
// RUN: ./gradlew run -Pexample=RagMongodb --args="[query] [category]"

import com.mongodb.MongoException
import com.mongodb.client.model.SearchIndexModel
import com.mongodb.client.model.SearchIndexType
import com.mongodb.kotlin.client.coroutine.MongoClient
import io.tether.qvac.sdk.JvmBareRpcTransport
import io.tether.qvac.sdk.QvacClient
import io.tether.qvac.sdk.QvacProgressEvent
import io.tether.qvac.sdk.embeddings
import io.tether.qvac.sdk.generated.ModelConstant
import io.tether.qvac.sdk.generated.Models
import io.tether.qvac.sdk.generated.schema.LoadModelResponse
import io.tether.qvac.sdk.generated.schema.ModelProgressResponse
import io.tether.qvac.sdk.models
import kotlin.system.exitProcess
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import org.bson.Document

private const val INDEX_NAME = "documents_vector_index"

private val MONGODB_SETUP_INSTRUCTIONS = """
    |
    |▸ This example needs a MongoDB deployment with Atlas Vector Search.
    |
    |One way to get one is to run it in Docker:
    |
    |   docker run -p 27017:27017 --name atlas-local mongodb/mongodb-atlas-local
    |
    |For more details, visit: https://www.mongodb.com/docs/atlas/cli/current/atlas-cli-deploy-docker/
    |
""".trimMargin()

private data class Sample(val id: Int, val category: String, val text: String)

// Sample corpus, each document tagged with a category to filter on
private val SAMPLES = listOf(
    Sample(
        1, "ai",
        "Machine learning is a subset of artificial intelligence that focuses on algorithms that can learn and " +
            "make predictions from data without being explicitly programmed for every task.",
    ),
    Sample(
        2, "ai",
        "Deep learning uses neural networks with multiple layers to process and learn from complex data patterns, " +
            "enabling breakthroughs in image recognition and natural language processing.",
    ),
    Sample(
        3, "ai",
        "Natural language processing combines computational linguistics with machine learning to help computers " +
            "understand, interpret, and generate human language in a meaningful way.",
    ),
    Sample(
        4, "ai",
        "Computer vision enables machines to interpret and understand visual information from the world, using " +
            "techniques like image classification, object detection, and facial recognition.",
    ),
    Sample(
        5, "computing",
        "Quantum computing leverages quantum mechanical phenomena to process information in fundamentally " +
            "different ways than classical computers, potentially solving certain problems exponentially faster.",
    ),
    Sample(
        6, "security",
        "Blockchain technology creates decentralized, immutable ledgers that enable secure peer-to-peer " +
            "transactions without requiring a central authority or intermediary.",
    ),
    Sample(
        7, "computing",
        "Cloud computing delivers computing services over the internet, allowing users to access resources like " +
            "storage, processing power, and applications on-demand from anywhere.",
    ),
    Sample(
        8, "security",
        "Cybersecurity protects digital systems, networks, and data from malicious attacks, unauthorized access, " +
            "and various forms of cyber threats through multiple layers of defense.",
    ),
)

fun main(args: Array<String>): Unit = runBlocking {
    // Get query and category from command line or use defaults
    val query = args.getOrNull(0) ?: "machine learning algorithms"
    val category = args.getOrNull(1) ?: "ai"
    println("▸ Query: \"$query\" (category: \"$category\")")

    // Replace with your own deployment's connection string if it is not the Docker one
    // https://www.mongodb.com/docs/manual/reference/connection-string/
    val mongo = MongoClient.create("mongodb://localhost:27017/?directConnection=true")
    val connected = try {
        mongo.getDatabase("admin").runCommand(Document("ping", 1))
        true
    } catch (_: MongoException) {
        false
    }
    if (!connected) {
        System.err.println("✖ Failed to connect to MongoDB server")
        System.err.println("▸ Please ensure the server is running on localhost:27017")
        System.err.println(MONGODB_SETUP_INSTRUCTIONS)
        mongo.close()
        exitProcess(1)
    }
    println("▸ Connected to MongoDB server")

    val collection = mongo.getDatabase("qvac").getCollection<Document>("documents")

    try {
        val client = QvacClient(JvmBareRpcTransport.connectResolved(installWorkerIfMissing = true))
        try {
            val modelId = client.loadWithProgress(Models.GTE_LARGE_FP16)

            // (Re)create the collection. The driver allows "ns not found", so this
            // is a no-op the first time round.
            collection.drop()

            // Embed and store documents
            println("▸ Embedding documents...")
            val documents = SAMPLES.map { sample ->
                Document("id", sample.id)
                    .append("category", sample.category)
                    .append("text", sample.text)
                    .append("embedding", client.embeddings.embed(modelId, sample.text))
            }
            collection.insertMany(documents)

            // numDimensions is fixed at index creation and must match the model:
            // GTE Large is 1024
            println("▸ Creating vector search index...")
            collection.createSearchIndexes(
                listOf(
                    SearchIndexModel(
                        INDEX_NAME,
                        Document(
                            "fields",
                            listOf(
                                Document("type", "vector")
                                    .append("path", "embedding")
                                    .append("numDimensions", 1024)
                                    .append("similarity", "cosine"),
                                // A field must be indexed as a filter to be usable in a $vectorSearch filter
                                Document("type", "filter").append("path", "category"),
                            ),
                        ),
                        SearchIndexType.vectorSearch(),
                    ),
                ),
            )

            // Index builds are asynchronous; querying too early returns no matches
            for (attempt in 0 until 60) {
                val indexes = collection.listSearchIndexes<Document>().name(INDEX_NAME).toList()
                if (indexes.firstOrNull()?.getBoolean("queryable") == true) break
                if (attempt == 59) error("Index $INDEX_NAME did not become queryable")
                delay(1000)
            }

            println("▸ Searching for similar documents...")
            val queryVector = client.embeddings.embed(modelId, query)

            val results = collection.aggregate<Document>(
                listOf(
                    Document(
                        "\$vectorSearch",
                        Document("index", INDEX_NAME)
                            .append("path", "embedding")
                            .append("queryVector", queryVector)
                            .append("filter", Document("category", Document("\$eq", category)))
                            .append("numCandidates", 100)
                            .append("limit", 3),
                    ),
                    Document(
                        "\$project",
                        Document("_id", 0)
                            .append("id", 1)
                            .append("category", 1)
                            .append("text", 1)
                            .append("score", Document("\$meta", "vectorSearchScore")),
                    ),
                ),
            ).toList()

            println("▸ Top 3 most similar documents:")
            results.forEachIndexed { index, result ->
                println(
                    "%d. (Score: %.4f, Category: %s)".format(
                        index + 1,
                        result.getDouble("score"),
                        result.getString("category"),
                    ),
                )
                println("   ${result.getString("text")}")
                println()
            }

            client.models.unload(modelId)
        } finally {
            client.close()
        }
    } finally {
        mongo.close()
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
