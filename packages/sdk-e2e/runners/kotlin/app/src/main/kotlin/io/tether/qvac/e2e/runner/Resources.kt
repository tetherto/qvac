package io.tether.qvac.e2e.runner

import io.tether.qvac.sdk.QvacClient
import io.tether.qvac.sdk.generated.ModelConstant
import io.tether.qvac.sdk.generated.ModelTypeMaps
import io.tether.qvac.sdk.generated.Models
import io.tether.qvac.sdk.models
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

class UnknownResourceError(message: String) : Exception(message)

/** Where the shared table's placeholders point on this host. */
interface HostResolvers {
    /** A bundled fixture, as a path the worker can open. */
    fun asset(kind: String, file: String): String

    /** A data file shipped inside an npm package, as a path the worker can open. */
    fun packageAsset(pkg: String, file: String): String
}

/**
 * Resource key -> model, loaded and evicted around each test. Table: catalog/resources/resource-table.json;
 * `on` / `configOn` platform matching: catalog/resource-table-types.ts.
 */
class Resources(
    private val client: QvacClient,
    table: Map<String, Any?>,
    private val platform: String,
    private val host: HostResolvers,
    private val log: (String) -> Unit,
    /** Pause after an unload before the next load (`unloadSettleMs` in catalog/platform-policy.ts). */
    private val unloadSettleMs: Long,
) {
    private val platformSegments = platform.split("-")
    private val definitions: Map<String, Map<String, Any?>> =
        table.mapValues { asMap(it.value) }.filterValues { entry ->
            val on = entry["on"] as? List<*>
            on == null || on.any { appliesHere(it.toString()) }
        }
    private val loaded = LinkedHashMap<String, String>()

    private fun appliesHere(entry: String): Boolean {
        if (entry == platform) return true
        val segments = entry.split("-")
        if (segments.size >= platformSegments.size) return false
        return segments.indices.all { segments[it] == platformSegments[it] }
    }

    private fun definition(dep: String): Map<String, Any?> =
        definitions[dep] ?: throw UnknownResourceError("resource \"$dep\" is not defined for platform \"$platform\"")

    /** The entry's config with this platform's overrides merged over it. */
    private fun configFor(entry: Map<String, Any?>): Map<String, Any?>? {
        val config = entry["config"] as? Map<*, *>
        val overrides = asMap(entry["configOn"]).filterKeys(::appliesHere).values.map(::asMap)
        if (config == null && overrides.isEmpty()) return null
        val merged = LinkedHashMap<String, Any?>(asMap(config))
        overrides.forEach(merged::putAll)
        return merged
    }

    /** Replace `$const`, `$asset` and `$packageAsset` placeholders, recursively. */
    fun resolve(value: Any?): Any? = when (value) {
        is List<*> -> value.map(::resolve)
        is Map<*, *> -> {
            val name = value["\$const"]
            val asset = value["\$asset"] as? Map<*, *>
            val packageAsset = value["\$packageAsset"] as? Map<*, *>
            when {
                name is String -> descriptor(constant(name))
                asset != null -> host.asset(asset["kind"].toString(), asset["file"].toString())
                packageAsset != null -> host.packageAsset(packageAsset["package"].toString(), packageAsset["file"].toString())
                else -> value.entries.associateTo(LinkedHashMap()) { (key, item) -> key.toString() to resolve(item) }
            }
        }
        else -> value
    }

    /** What `loadModel` would be called with for this key, without calling it. */
    fun sourceOf(dep: String): Map<String, Any?> {
        val entry = definition(dep)
        val out = LinkedHashMap<String, Any?>()
        resolve(entry["constant"])?.let { out["modelSrc"] = it }
        entry["modelSrc"]?.let { out["modelSrc"] = it }
        entry["type"]?.let { out["modelType"] = it }
        configFor(entry)?.let { out["modelConfig"] = resolve(it) }
        return out
    }

    suspend fun ensureLoaded(dep: String): String {
        loaded[dep]?.let { return it }
        val source = sourceOf(dep)
        log("loading $dep")
        val modelId = loadModel(source)
        loaded[dep] = modelId
        return modelId
    }

    /** What a `loadModel` step asks for, resolved the way the JS client resolves it. */
    class LoadArgs(val src: String, val type: String, val name: String?, val requestId: String?, val config: JsonObject?)

    fun loadArgs(params: Map<String, Any?>): LoadArgs {
        val source = params["modelSrc"]
        val descriptor = source as? Map<*, *>
        // A bundled model (classification) is named by its config; the JS client sends an empty modelSrc.
        val src = (descriptor?.get("src") ?: source)?.toString() ?: ""
        val declaredType = params["modelType"]?.toString() ?: descriptor?.get("engine")?.toString()
            ?: throw Wire.refusal("MODEL_TYPE_REQUIRED", MODEL_TYPE_REQUIRED)
        return LoadArgs(
            src = src,
            type = canonicalModelType(declaredType),
            name = params["modelName"]?.toString() ?: descriptor?.get("name")?.toString(),
            requestId = params["requestId"]?.toString(),
            config = wireConfig(asMap(params["modelConfig"]).takeIf { params["modelConfig"] != null }),
        )
    }

    /** The `loadModel` contract method: a descriptor or a plain source, a type, a config. */
    suspend fun loadModel(params: Map<String, Any?>): String {
        val args = loadArgs(params)
        val response = client.models.load(
            source = args.src,
            modelType = args.type,
            modelName = args.name,
            requestId = args.requestId,
            modelConfig = args.config,
        )
        val modelId = response.modelId
        if (!response.success || modelId == null) {
            throw Wire.refusal("MODEL_LOAD_FAILED", response.error ?: "loading ${args.src} failed")
        }
        return modelId
    }

    suspend fun evict(dep: String) {
        val modelId = loaded.remove(dep) ?: return
        unload(dep, modelId)
    }

    suspend fun evictAllExcept(keep: Set<String>) {
        for (dep in loaded.keys.filter { it !in keep }) {
            unload(dep, loaded.remove(dep)!!)
        }
    }

    suspend fun close() = evictAllExcept(emptySet())

    /**
     * Runs to the end, within a bound, even when the test is cancelled: a model left in the worker
     * but dropped from [loaded] would be loaded twice.
     */
    private suspend fun unload(dep: String, modelId: String) = withContext(NonCancellable) {
        log("evicting $dep")
        val done = withTimeoutOrNull(UNLOAD_TIMEOUT_MS) {
            // Cancel in-flight decoding first, as the JS resource manager does: a timed-out test leaves it running.
            try {
                client.call(
                    buildJsonObject {
                        put("type", "cancel")
                        put("operation", "broad")
                        put("modelId", modelId)
                        put("kind", "completion")
                    },
                )
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                log("cancelling $dep before evicting it failed (continuing): ${error.message}")
            }
            try {
                client.models.unload(modelId)
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                log("evicting $dep failed (continuing): ${error.message}")
            }
            if (unloadSettleMs > 0) delay(unloadSettleMs)
        }
        if (done == null) log("evicting $dep did not finish within ${UNLOAD_TIMEOUT_MS}ms (continuing)")
    }

    /** Every model constant the table's entries for these keys reference, for the bootstrap download. */
    fun constantsFor(deps: Collection<String>): List<ModelConstant> {
        val found = LinkedHashMap<String, ModelConstant>()
        fun collect(value: Any?) {
            when (value) {
                is List<*> -> value.forEach(::collect)
                is Map<*, *> -> {
                    val name = value["\$const"]
                    if (name is String) {
                        // A missing constant fails only its own test (incomplete), not the whole download.
                        val constant = constants[name]
                        if (constant != null) found.putIfAbsent(constant.src, constant)
                    } else {
                        value.values.forEach(::collect)
                    }
                }
            }
        }
        for (dep in deps) {
            val entry = definitions[dep] ?: continue
            if (entry["skipPreDownload"] == true) continue
            val skipOn = entry["skipPreDownloadOn"] as? List<*>
            if (skipOn != null && skipOn.any { appliesHere(it.toString()) }) continue
            collect(entry["constant"])
            collect(configFor(entry))
        }
        return found.values.toList()
    }

    val keys: Set<String> get() = definitions.keys

    companion object {
        private val constants: Map<String, ModelConstant> by lazy { Models.all.associateBy { it.name } }

        fun constant(name: String): ModelConstant =
            constants[name] ?: throw UnknownResourceError("model constant \"$name\" is missing from the Kotlin registry")

        /** A model constant as the JS client passes it: the descriptor object, not just its source. */
        fun descriptor(constant: ModelConstant): Map<String, Any?> = linkedMapOf(
            "name" to constant.name,
            "src" to constant.src,
            "modelId" to constant.modelId,
            "registryPath" to constant.registryPath,
            "registrySource" to constant.registrySource,
            "blobCoreKey" to constant.blobCoreKey,
            "blobBlockOffset" to constant.blobBlockOffset,
            "blobBlockLength" to constant.blobBlockLength,
            "blobByteOffset" to constant.blobByteOffset,
            "engine" to constant.engine,
            "quantization" to constant.quantization,
            "params" to constant.params,
            "expectedSize" to constant.expectedSize,
            "sha256Checksum" to constant.sha256Checksum,
            "addon" to constant.addon,
        )

        private const val UNLOAD_TIMEOUT_MS = 60_000L

        /** The JS client's ModelTypeRequiredError message (sdk-errors-client.ts). */
        private const val MODEL_TYPE_REQUIRED =
            "modelType is required: modelSrc is a plain string or lacks an engine/addon descriptor that can be inferred."

        fun canonicalModelType(type: String): String = ModelTypeMaps.aliasToCanonical[type] ?: type

        /**
         * The config as the JS client puts it on the wire: a Bergamot pivot's own model source is
         * reduced to its `src`, the one place the JS load schema transforms a nested descriptor.
         */
        fun wireConfig(config: Map<String, Any?>?): JsonObject? {
            if (config == null) return null
            val pivot = config["pivotModel"] as? Map<*, *>
            val adjusted = if (config["engine"] == "Bergamot" && pivot != null) {
                val pivotSource = pivot["modelSrc"]
                val src = (pivotSource as? Map<*, *>)?.get("src") ?: pivotSource
                config + ("pivotModel" to (asMap(pivot) + ("modelSrc" to src)))
            } else {
                config
            }
            return toJson(adjusted) as JsonObject
        }
    }
}
