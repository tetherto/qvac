// Kotlin port of packages/sdk/examples/rag/rag-sqlite.ts.
//
// Keep each document in SQLite alongside its vector and retrieve matches with
// the SQLite-Vector extension's quantized scan. QVAC only produces the vectors
// through `client.embeddings.embed()`; the storage, quantization and search all
// happen in SQL.
//
// The extension and its SQL are the same ones the TypeScript example uses, but
// they arrive differently. There the npm `@sqliteai/sqlite-wasm` build has the
// extension compiled in; here the `org.xerial:sqlite-jdbc` driver (scoped to
// this example in build.gradle.kts) loads a prebuilt native binary that you
// download from https://github.com/sqliteai/sqlite-vector/releases and point
// SQLITE_VECTOR_EXTENSION at. sqlite-jdbc builds always support loadable
// extensions; `SQLiteConfig.enableLoadExtension(true)` turns them on for this
// connection, and they are turned off again once the vector extension loads.
//
// RUN: SQLITE_VECTOR_EXTENSION=/path/to/vector ./gradlew run -Pexample=RagSqlite --args="[query]"

import io.tether.qvac.sdk.JvmBareRpcTransport
import io.tether.qvac.sdk.QvacClient
import io.tether.qvac.sdk.QvacProgressEvent
import io.tether.qvac.sdk.embeddings
import io.tether.qvac.sdk.generated.ModelConstant
import io.tether.qvac.sdk.generated.Models
import io.tether.qvac.sdk.generated.schema.LoadModelResponse
import io.tether.qvac.sdk.generated.schema.ModelProgressResponse
import io.tether.qvac.sdk.models
import java.sql.Connection
import kotlin.system.exitProcess
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import org.sqlite.SQLiteConfig
import org.sqlite.SQLiteConnection

private data class Sample(val id: Int, val text: String)

private val SAMPLES = listOf(
    Sample(
        1,
        "Machine learning is a subset of artificial intelligence that focuses on algorithms that can learn and " +
            "make predictions from data without being explicitly programmed for every task.",
    ),
    Sample(
        2,
        "Deep learning uses neural networks with multiple layers to process and learn from complex data patterns, " +
            "enabling breakthroughs in image recognition and natural language processing.",
    ),
    Sample(
        3,
        "Natural language processing combines computational linguistics with machine learning to help computers " +
            "understand, interpret, and generate human language in a meaningful way.",
    ),
    Sample(
        4,
        "Computer vision enables machines to interpret and understand visual information from the world, using " +
            "techniques like image classification, object detection, and facial recognition.",
    ),
    Sample(
        5,
        "Quantum computing leverages quantum mechanical phenomena to process information in fundamentally " +
            "different ways than classical computers, potentially solving certain problems exponentially faster.",
    ),
    Sample(
        6,
        "Blockchain technology creates decentralized, immutable ledgers that enable secure peer-to-peer " +
            "transactions without requiring a central authority or intermediary.",
    ),
    Sample(
        7,
        "Cloud computing delivers computing services over the internet, allowing users to access resources like " +
            "storage, processing power, and applications on-demand from anywhere.",
    ),
    Sample(
        8,
        "Cybersecurity protects digital systems, networks, and data from malicious attacks, unauthorized access, " +
            "and various forms of cyber threats through multiple layers of defense.",
    ),
)

fun main(args: Array<String>): Unit = runBlocking {
    // Get query from command line or use default
    val query = args.getOrNull(0) ?: "machine learning algorithms"
    println("▸ Query: \"$query\"")

    val extension = System.getenv("SQLITE_VECTOR_EXTENSION")
    if (extension.isNullOrEmpty()) {
        System.err.println("✖ This example needs the SQLite vector extension: set SQLITE_VECTOR_EXTENSION")
        System.err.println(
            "▸ Download the prebuilt binary for your platform from " +
                "https://github.com/sqliteai/sqlite-vector/releases and point SQLITE_VECTOR_EXTENSION at it",
        )
        exitProcess(1)
    }

    // Initialize SQLite with vector extension
    val config = SQLiteConfig().apply { enableLoadExtension(true) }
    config.createConnection("jdbc:sqlite::memory:").use { db ->
        db.select("SELECT load_extension(?)", extension)
        db.unwrap(SQLiteConnection::class.java).database.enable_load_extension(false)

        val client = QvacClient(JvmBareRpcTransport.connectResolved(installWorkerIfMissing = true))
        try {
            val modelId = client.loadWithProgress(Models.GTE_LARGE_FP16)

            // Create table for documents with vector storage
            db.createStatement().use {
                it.execute(
                    """
                    CREATE TABLE IF NOT EXISTS documents (
                      id INTEGER PRIMARY KEY,
                      text TEXT NOT NULL,
                      embedding BLOB NOT NULL
                    )
                    """.trimIndent(),
                )
            }

            println("▸ Embedding documents...")
            db.prepareStatement("INSERT INTO documents VALUES (?, ?, vector_as_f32(?))").use { insert ->
                for (sample in SAMPLES) {
                    val embedding = client.embeddings.embed(modelId, sample.text)
                    insert.setInt(1, sample.id)
                    insert.setString(2, sample.text)
                    insert.setString(3, toJson(embedding))
                    insert.executeUpdate()
                }
            }

            // Initialize and optimize vector index
            db.select("SELECT vector_init('documents', 'embedding', ?)", "type=FLOAT32,dimension=1024")

            // Quantize vectors
            db.select("SELECT vector_quantize('documents', 'embedding')")

            // [Optional] Preload quantized vectors in memory for optimal performance
            db.select("SELECT vector_quantize_preload('documents', 'embedding')")

            // Search for similar documents
            println("▸ Searching for similar documents...")
            val queryEmbedding = client.embeddings.embed(modelId, query)

            // Perform vector search. The scan returns only rowid and distance, so
            // the table is self-joined to read the text back.
            val search = """
                SELECT d.id, d.text, v.distance
                FROM documents d
                JOIN vector_quantize_scan('documents', 'embedding', vector_as_f32(?), 3) v
                ON d.id = v.rowid
            """.trimIndent()
            println("\n▸ Top 3 most similar documents:")
            db.prepareStatement(search).use { statement ->
                statement.setString(1, toJson(queryEmbedding))
                statement.executeQuery().use { rows ->
                    var index = 1
                    while (rows.next()) {
                        println("=".repeat(50) + " Top result:")
                        println("\n$index. [ID: ${rows.getInt(1)}] (Score: %.4f)".format(rows.getDouble(3)))
                        println("   ${rows.getString(2)}")
                        println("=".repeat(100))
                        println()
                        index++
                    }
                }
            }

            client.models.unload(modelId)
        } finally {
            client.close()
        }
    }
}

/** Run a SELECT for its side effect, binding [params] in order. */
private fun Connection.select(sql: String, vararg params: String) {
    prepareStatement(sql).use { statement ->
        params.forEachIndexed { index, value -> statement.setString(index + 1, value) }
        statement.executeQuery().close()
    }
}

/** The JSON array text `vector_as_f32()` parses. */
private fun toJson(vector: List<Double>): String = JsonArray(vector.map(::JsonPrimitive)).toString()

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
