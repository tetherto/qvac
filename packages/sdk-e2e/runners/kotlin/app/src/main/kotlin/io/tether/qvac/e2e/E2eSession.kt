package io.tether.qvac.e2e

import android.content.Context
import android.os.Build
import android.util.Log
import io.tether.qvac.e2e.consumer.Consumer
import io.tether.qvac.e2e.consumer.ConsumerConfig
import io.tether.qvac.e2e.consumer.E2eRunner
import io.tether.qvac.e2e.consumer.MqttLink
import io.tether.qvac.e2e.consumer.Runtime
import io.tether.qvac.e2e.runner.Calls
import io.tether.qvac.e2e.runner.Interpreter
import io.tether.qvac.e2e.runner.Resources
import io.tether.qvac.e2e.runner.Wire
import io.tether.qvac.e2e.runner.asList
import io.tether.qvac.e2e.runner.asMap
import io.tether.qvac.e2e.runner.fromJson
import io.tether.qvac.sdk.QvacClient
import io.tether.qvac.sdk.barekit.AndroidBareKitTransport
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import java.io.File
import java.net.URI
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Process-scoped and holding only the application context, so a recreated activity neither restarts
 * the run nor is kept alive by it.
 */
object E2eSession {
    const val TAG = "QvacE2E"

    /** The resource table's name for this host; see catalog/resource-table-types.ts. */
    private const val RESOURCE_PLATFORM = "mobile-android"
    private const val LOGCAT_LINE_LIMIT = 3000

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val running = AtomicBoolean(false)

    /** The on-screen activity's log sink, if any. */
    @Volatile var display: ((String) -> Unit)? = null

    /** Starts a run unless one is already going; the overrides are the launch intent's extras. */
    fun start(app: Context, overrides: Map<String, String?>): Boolean {
        if (!running.compareAndSet(false, true)) return false
        scope.launch {
            try {
                run(app, overrides)
            } finally {
                running.set(false)
            }
        }
        return true
    }

    fun log(message: String) {
        // logcat truncates long entries, and the Device Farm spec reads results line by line.
        for (line in message.split("\n")) {
            line.chunked(LOGCAT_LINE_LIMIT).ifEmpty { listOf("") }.forEach { Log.i(TAG, it) }
        }
        display?.invoke(message)
    }

    private suspend fun run(app: Context, overrides: Map<String, String?>) {
        try {
            val config = ConsumerConfig.resolve(asMap(readAssetJson(app, "e2e/consumer-config.json")), overrides)
            val device = Build.MODEL.replace(Regex("[^A-Za-z0-9_-]"), "_")
            val consumerId = "consumer-${config.platform}-$device-${if (config.runId == "*") System.currentTimeMillis() else config.runId}"
            log("🔧 Initializing consumer...")
            log("📱 Device: ${Build.MANUFACTURER} ${Build.MODEL} | Run ID: ${config.runId} | Platform: ${config.platform}")
            // Scheme and port only: in CI the host is a secret, and Device Farm keeps the full logcat.
            val broker = URI(config.mqtt.url)
            log("📡 Connecting to ${broker.scheme}://…:${broker.port}")

            val definitions = asList(readAssetJson(app, "e2e/catalog/test-definitions.json")).map(::asMap)
            log("📚 ${definitions.size} test definitions bundled")
            val consumer = Consumer(
                scope = scope,
                link = MqttLink.create(config.mqtt, consumerId),
                consumerId = consumerId,
                platform = config.platform,
                runId = config.runId,
                runner = E2eRunner(start = { startRuntime(app) }, log = ::log),
                definitions = definitions,
                log = ::log,
            )
            consumer.start()
            consumer.finished.await()
        } catch (error: Throwable) {
            log("❌ Consumer failed to start: ${error.message}")
            Log.e(TAG, "consumer failed", error)
            // Device Farm waits for this line; without it a failed start would sit until the job times out.
            log("\n👋 Consumer shutting down...")
        }
    }

    private suspend fun startRuntime(app: Context): Runtime {
        log("🔧 Starting the QVAC worker...")
        val host = AndroidHost(app)
        withContext(Dispatchers.IO) { host.extractFixtures() }
        val table = asMap(readAssetJson(app, "e2e/resources/resource-table.json"))
        // Policy is keyed by app family, the first segment of the platform (policyFor in platform-policy.ts).
        val policy = asMap(asMap(readAssetJson(app, "e2e/resources/platform-policy.json"))[RESOURCE_PLATFORM.substringBefore('-')])
        val unloadSettleMs = (policy["unloadSettleMs"] as? Number)?.toLong()
            ?: error("no platform policy for \"$RESOURCE_PLATFORM\" in platform-policy.json")
        val workerConfig = Json.parseToJsonElement(readAsset(app, "e2e/worker-config.json")).jsonObject
        val transport = AndroidBareKitTransport.connect(app, config = workerConfig)
        val client = QvacClient(transport)
        val wire = Wire(client)
        val resources = Resources(client, table, RESOURCE_PLATFORM, host, ::log, unloadSettleMs)
        val calls = Calls(wire, resources, File(app.cacheDir, "e2e-scratch"))
        val interpreter = Interpreter(resources, calls, host.fixtureRoot, ::log)
        log("✅ Worker ready")
        return Runtime(client, wire, resources, calls, interpreter)
    }

    private fun readAsset(app: Context, path: String): String = app.assets.open(path).bufferedReader().use { it.readText() }

    private fun readAssetJson(app: Context, path: String): Any? = fromJson(Json.parseToJsonElement(readAsset(app, path)))
}
