// Kotlin port of packages/sdk/examples/rag/rag-turbovec.ts.
//
// Retrieval over documents kept in your own store. The SDK holds only the
// vectors, in a TurboVec index inside the worker; the documents stay in this
// map (or any database you choose) and result ids map back to them.
//
// `client.vectorIndex()` is the generated method covering every index
// operation. Where the JS SDK hands back an index object with `add`/`search`/
// `write`/`dispose` methods, `create` here returns an `indexId` that every later
// operation carries. `VectorIndexRequest` and `VectorIndexResponse` are sealed
// classes with one variant per operation, so each response is read off the
// matching variant. `search` is batched: it takes `queries` and returns one
// result list per query. `client.embeddings.embed()` has a single-text overload
// returning one vector and a list overload returning one vector per text.
//
// RUN: ./gradlew run -Pexample=RagTurbovec --args="[query]"

import io.tether.qvac.sdk.JvmBareRpcTransport
import io.tether.qvac.sdk.QvacClient
import io.tether.qvac.sdk.QvacProgressEvent
import io.tether.qvac.sdk.embeddings
import io.tether.qvac.sdk.generated.ModelConstant
import io.tether.qvac.sdk.generated.Models
import io.tether.qvac.sdk.generated.schema.LoadModelResponse
import io.tether.qvac.sdk.generated.schema.ModelProgressResponse
import io.tether.qvac.sdk.generated.schema.VectorId
import io.tether.qvac.sdk.generated.schema.VectorIndexRequest
import io.tether.qvac.sdk.generated.schema.VectorIndexRequestAdd
import io.tether.qvac.sdk.generated.schema.VectorIndexRequestCreate
import io.tether.qvac.sdk.generated.schema.VectorIndexRequestCreateStorage
import io.tether.qvac.sdk.generated.schema.VectorIndexRequestDispose
import io.tether.qvac.sdk.generated.schema.VectorIndexRequestLoad
import io.tether.qvac.sdk.generated.schema.VectorIndexRequestSearch
import io.tether.qvac.sdk.generated.schema.VectorIndexRequestWrite
import io.tether.qvac.sdk.generated.schema.VectorIndexResponse
import io.tether.qvac.sdk.models
import io.tether.qvac.sdk.vectorIndex
import kotlinx.coroutines.runBlocking

fun main(args: Array<String>): Unit = runBlocking {
    val query = args.getOrNull(0) ?: "Which moon has methane rain and lakes?"
    println("▸ Query: \"$query\"")

    // Ids are numeric by contract, so keep your own id as the key and let the
    // index hold only the numeric handle plus the vector.
    val documents = mapOf(
        "1" to "Saturn moon Titan has lakes, clouds, and rain made of liquid methane.",
        "2" to "Solar panels convert sunlight into electricity using photovoltaic cells.",
        "3" to "Honeybees communicate the location of flowers through a waggle dance.",
        "4" to "The Pacific Ocean is the largest and deepest ocean on Earth.",
    )

    val client = QvacClient(JvmBareRpcTransport.connectResolved(installWorkerIfMissing = true))
    try {
        val modelId = client.loadWithProgress(Models.GTE_LARGE_FP16)

        println("▸ Embedding documents...")
        val vectors = client.embeddings.embed(modelId, documents.values.toList())

        println("▸ Building the vector index...")
        val created = client.vectorIndex(
            VectorIndexRequest.Create(
                VectorIndexRequestCreate(
                    dim = vectors[0].size.toLong(),
                    storage = VectorIndexRequestCreateStorage.TURBOVECQ4,
                ),
            ),
        ) as VectorIndexResponse.Create
        val indexId = created.value.indexId
        val added = client.vectorIndex(
            VectorIndexRequest.Add(
                VectorIndexRequestAdd(
                    indexId = indexId,
                    ids = documents.keys.map { VectorId.Variant1(it) },
                    vectors = vectors,
                ),
            ),
        ) as VectorIndexResponse.Add
        println("▸ Indexed ${added.value.length} vectors of dimension ${created.value.dim}")

        println("▸ Searching...")
        val queryVector = client.embeddings.embed(modelId, query)
        val found = client.vectorIndex(
            VectorIndexRequest.Search(
                VectorIndexRequestSearch(indexId = indexId, queries = listOf(queryVector), k = 2),
            ),
        ) as VectorIndexResponse.Search
        val hits = found.value.results[0]
        println("▸ Top matches:")
        for (hit in hits) {
            println("  score=%.4f id=%s: %s".format(hit.score, hit.id, documents[hit.id]))
        }

        // Snapshots persist the vectors only. A relative path resolves under the
        // QVAC data directory; pass an absolute path to store it elsewhere.
        val snapshotPath = "examples/RagTurbovec.qvi"
        val written = client.vectorIndex(
            VectorIndexRequest.Write(VectorIndexRequestWrite(indexId = indexId, path = snapshotPath)),
        ) as VectorIndexResponse.Write
        client.vectorIndex(VectorIndexRequest.Dispose(VectorIndexRequestDispose(indexId = indexId)))
        println("▸ Snapshot written to ${written.value.path}")

        val reloaded = client.vectorIndex(
            VectorIndexRequest.Load(VectorIndexRequestLoad(path = snapshotPath)),
        ) as VectorIndexResponse.Load
        val reloadedId = reloaded.value.indexId
        val reloadedFound = client.vectorIndex(
            VectorIndexRequest.Search(
                VectorIndexRequestSearch(indexId = reloadedId, queries = listOf(queryVector), k = 1),
            ),
        ) as VectorIndexResponse.Search
        val reloadedBest = reloadedFound.value.results[0].firstOrNull()
        client.vectorIndex(VectorIndexRequest.Dispose(VectorIndexRequestDispose(indexId = reloadedId)))
        val best = hits.firstOrNull()
        if (reloadedBest == null || best == null || reloadedBest.id != best.id) {
            error("Reloaded index returned id=${reloadedBest?.id} but the original returned id=${best?.id}")
        }
        println("▸ Reloaded index agrees: best match id=${reloadedBest.id}")

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
