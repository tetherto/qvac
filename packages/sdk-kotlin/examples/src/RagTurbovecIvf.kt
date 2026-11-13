// Kotlin port of packages/sdk/examples/rag/rag-turbovec-ivf.ts.
//
// IVF search over documents kept in your own store. setIvf() groups the
// vectors into lists, and each search scans only the lists nearest the query.
// On a large F32 index that can be many times faster than a full scan, while
// on TurboVec storage it can be slower. This example uses F32 storage with 16
// documents, so it shows the API rather than the speedup.
//
// `client.vectorIndex()` is the generated method covering every index
// operation; `create` returns an `indexId` that every later operation carries.
// There is no index object holding the IVF state, so read it off the `ivf` field
// of the `SetIvf` and `Add` responses. `search` is batched: it takes `queries`
// and returns one result list per query.
//
// RUN: ./gradlew -p examples run -Pexample=RagTurbovecIvf --args="[query]"

import io.tether.qvac.sdk.QvacClient
import io.tether.qvac.sdk.QvacProgressEvent
import io.tether.qvac.sdk.embeddings
import io.tether.qvac.sdk.generated.ModelConstant
import io.tether.qvac.sdk.generated.Models
import io.tether.qvac.sdk.generated.schema.LoadModelResponse
import io.tether.qvac.sdk.generated.schema.ModelProgressResponse
import io.tether.qvac.sdk.generated.schema.VectorId
import io.tether.qvac.sdk.generated.schema.VectorIndexIvfSettings
import io.tether.qvac.sdk.generated.schema.VectorIndexRequest
import io.tether.qvac.sdk.generated.schema.VectorIndexRequestAdd
import io.tether.qvac.sdk.generated.schema.VectorIndexRequestCreate
import io.tether.qvac.sdk.generated.schema.VectorIndexRequestCreateStorage
import io.tether.qvac.sdk.generated.schema.VectorIndexRequestDispose
import io.tether.qvac.sdk.generated.schema.VectorIndexRequestSearch
import io.tether.qvac.sdk.generated.schema.VectorIndexRequestSetIvf
import io.tether.qvac.sdk.generated.schema.VectorIndexResponse
import io.tether.qvac.sdk.jvm.JvmBareKitTransport
import io.tether.qvac.sdk.models
import io.tether.qvac.sdk.vectorIndex
import kotlinx.coroutines.runBlocking

fun main(args: Array<String>): Unit = runBlocking {
    val query = args.getOrNull(0) ?: "Which moon has methane rain and lakes?"
    println("▸ Query: \"$query\"")

    val documents = mutableMapOf(
        "1" to "Saturn moon Titan has lakes, clouds, and rain made of liquid methane.",
        "2" to "Jupiter moon Europa hides a salty ocean under a shell of ice.",
        "3" to "Mars has the tallest volcano in the solar system, Olympus Mons.",
        "4" to "Venus is the hottest planet because its thick air traps heat.",
        "5" to "Solar panels convert sunlight into electricity using photovoltaic cells.",
        "6" to "Wind turbines turn the motion of air into electrical power.",
        "7" to "Lithium-ion batteries store energy for phones and electric cars.",
        "8" to "Hydroelectric dams generate power from water flowing downhill.",
        "9" to "Honeybees communicate the location of flowers through a waggle dance.",
        "10" to "Octopuses can change the color and texture of their skin in an instant.",
        "11" to "Arctic terns migrate from pole to pole every year.",
        "12" to "Elephants recognize themselves in a mirror.",
        "13" to "The Pacific Ocean is the largest and deepest ocean on Earth.",
        "14" to "Coral reefs grow from colonies of tiny animals called polyps.",
        "15" to "Ocean tides rise and fall with the pull of the Moon.",
        "16" to "The Mariana Trench reaches nearly eleven kilometers below sea level.",
    )

    val client = QvacClient(JvmBareKitTransport.connect())
    try {
        val modelId = client.loadWithProgress(Models.GTE_LARGE_FP16)

        println("▸ Embedding documents...")
        val vectors = client.embeddings.embed(modelId, documents.values.toList())

        println("▸ Building the vector index...")
        val created = client.vectorIndex(
            VectorIndexRequest.Create(
                VectorIndexRequestCreate(
                    dim = vectors[0].size.toLong(),
                    storage = VectorIndexRequestCreateStorage.F32,
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

        val queryVector = client.embeddings.embed(modelId, query)
        // A full scan before IVF is on, to check the probed results against.
        val fullFound = client.vectorIndex(
            VectorIndexRequest.Search(
                VectorIndexRequestSearch(indexId = indexId, queries = listOf(queryVector), k = 1),
            ),
        ) as VectorIndexResponse.Search
        val fullBest = fullFound.value.results[0].firstOrNull()

        // Four lists, one probed per search: each query scans about a quarter of
        // the index. A higher nProbe finds more true neighbours and costs more.
        println("▸ Building IVF lists...")
        val ivfSet = client.vectorIndex(
            VectorIndexRequest.SetIvf(
                VectorIndexRequestSetIvf(indexId = indexId, ivf = VectorIndexIvfSettings(nLists = 4, nProbe = 1)),
            ),
        ) as VectorIndexResponse.SetIvf
        val ivf = ivfSet.value.ivf
        if (ivf == null || !ivf.built) error("setIvf did not build the IVF lists")
        println("▸ IVF on: ${ivf.nLists} lists, ${ivf.nProbe} probed per search")

        println("▸ Searching...")
        val found = client.vectorIndex(
            VectorIndexRequest.Search(
                VectorIndexRequestSearch(indexId = indexId, queries = listOf(queryVector), k = 2),
            ),
        ) as VectorIndexResponse.Search
        println("▸ Top matches:")
        for (hit in found.value.results[0]) {
            println("  score=%.4f id=%s: %s".format(hit.score, hit.id, documents[hit.id]))
        }

        // nProbe on one call overrides the setting for that call only. Probing
        // every list scans the whole index, so it agrees with the full scan.
        val widerFound = client.vectorIndex(
            VectorIndexRequest.Search(
                VectorIndexRequestSearch(indexId = indexId, queries = listOf(queryVector), k = 1, nProbe = ivf.nLists),
            ),
        ) as VectorIndexResponse.Search
        val widerBest = widerFound.value.results[0].firstOrNull()
        if (widerBest == null || fullBest == null || widerBest.id != fullBest.id) {
            error("Probing every list returned id=${widerBest?.id} but the full scan returned id=${fullBest?.id}")
        }
        println("▸ Probing all ${ivf.nLists} lists agrees with the full scan: id=${widerBest.id}")

        // An add makes the lists stale. Search scans every vector until setIvf()
        // builds them again.
        val extra = "Neptune has the fastest winds of any planet in the solar system."
        val extraVector = client.embeddings.embed(modelId, extra)
        val addedExtra = client.vectorIndex(
            VectorIndexRequest.Add(
                VectorIndexRequestAdd(indexId = indexId, ids = listOf(VectorId.Variant1("17")), vectors = listOf(extraVector)),
            ),
        ) as VectorIndexResponse.Add
        documents["17"] = extra
        println("▸ Added a document; IVF lists built: ${addedExtra.value.ivf?.built}")
        val rebuilt = client.vectorIndex(
            VectorIndexRequest.SetIvf(
                VectorIndexRequestSetIvf(indexId = indexId, ivf = VectorIndexIvfSettings(nLists = 4, nProbe = 1)),
            ),
        ) as VectorIndexResponse.SetIvf
        println("▸ Rebuilt the IVF lists; built: ${rebuilt.value.ivf?.built}")

        // Null turns IVF off, and search scans every vector again.
        val ivfOff = client.vectorIndex(
            VectorIndexRequest.SetIvf(VectorIndexRequestSetIvf(indexId = indexId, ivf = null)),
        ) as VectorIndexResponse.SetIvf
        println("▸ IVF off: ${ivfOff.value.ivf == null}")

        client.vectorIndex(VectorIndexRequest.Dispose(VectorIndexRequestDispose(indexId = indexId)))
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
