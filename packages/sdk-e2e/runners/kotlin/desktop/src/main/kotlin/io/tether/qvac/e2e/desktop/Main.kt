package io.tether.qvac.e2e.desktop

import io.tether.qvac.e2e.consumer.Consumer
import io.tether.qvac.e2e.consumer.ConsumerConfig
import io.tether.qvac.e2e.consumer.E2eRunner
import io.tether.qvac.e2e.consumer.MqttLink
import io.tether.qvac.e2e.consumer.Runtime
import io.tether.qvac.e2e.runner.Calls
import io.tether.qvac.e2e.runner.HostResolvers
import io.tether.qvac.e2e.runner.Interpreter
import io.tether.qvac.e2e.runner.Resources
import io.tether.qvac.e2e.runner.RestartableTransport
import io.tether.qvac.e2e.runner.Wire
import io.tether.qvac.e2e.runner.asList
import io.tether.qvac.e2e.runner.asMap
import io.tether.qvac.e2e.runner.fromJson
import io.tether.qvac.sdk.QvacClient
import io.tether.qvac.sdk.jvm.JvmBareKitTransport
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import java.io.File
import java.net.InetAddress
import java.net.URI
import java.nio.file.Files
import kotlin.system.exitProcess

/**
 * The Kotlin client's e2e consumer on a desktop JVM. `scripts/desktop.mjs run` starts it with the
 * run the framework gives an mqtt-mode consumer (QVAC_RUN_ID, QVAC_MQTT_BROKER_URL, ...) and the
 * fixtures directory in QVAC_E2E_FIXTURES.
 */
fun main() {
    exitProcess(runBlocking { DesktopSession.run() })
}

private object DesktopSession {
    private const val PLATFORM = "desktop-kotlin"

    /** The resource table's name for this host; see catalog/resource-table-types.ts. */
    private const val RESOURCE_PLATFORM = "desktop-kotlin"
    private const val SHUTDOWN_TIMEOUT_MS = 100_000L

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    fun log(message: String) = println(message)

    suspend fun run(): Int {
        try {
            val config = ConsumerConfig.resolve(baked(), environmentOverrides())
            val host = InetAddress.getLocalHost().hostName.replace(Regex("[^A-Za-z0-9_-]"), "_")
            val consumerId = "consumer-${config.platform}-$host-${if (config.runId == "*") System.currentTimeMillis() else config.runId}"
            log("🔧 Initializing consumer...")
            log("💻 Host: ${System.getProperty("os.name")} ${System.getProperty("os.arch")} | Run ID: ${config.runId} | Platform: ${config.platform}")
            // Scheme and port only: in CI the host is a secret.
            val broker = URI(config.mqtt.url)
            log("📡 Connecting to ${broker.scheme}://…:${broker.port}")

            val definitions = asList(resourceJson("e2e/catalog/test-definitions.json")).map(::asMap)
            log("📚 ${definitions.size} test definitions bundled")
            val consumer = Consumer(
                scope = scope,
                link = MqttLink.create(config.mqtt, consumerId),
                consumerId = consumerId,
                platform = config.platform,
                runId = config.runId,
                runner = E2eRunner(start = ::startRuntime, log = ::log),
                definitions = definitions,
                log = ::log,
            )
            // A stopped run (Ctrl-C, the framework's SIGTERM) still leaves the broker and stops the worker.
            java.lang.Runtime.getRuntime().addShutdownHook(
                Thread { runBlocking { withTimeoutOrNull(SHUTDOWN_TIMEOUT_MS) { consumer.shutdown() } } },
            )
            consumer.start()
            consumer.finished.await()
            return 0
        } catch (error: Throwable) {
            log("❌ Consumer failed to start: ${error.message}")
            error.printStackTrace()
            log("\n👋 Consumer shutting down...")
            return 1
        }
    }

    private fun baked(): Map<String, Any?> = mapOf(
        "platform" to PLATFORM,
        "mqtt" to mapOf(
            "ca" to env("MQTT_CA_PATH")?.let { path ->
                val ca = File(path)
                require(ca.isFile) { "the MQTT CA file does not exist: $ca" }
                ca.readText()
            },
            "rejectUnauthorized" to true,
        ),
    )

    private fun environmentOverrides(): Map<String, String?> = mapOf(
        ConsumerConfig.EXTRA_RUN_ID to env("QVAC_RUN_ID"),
        ConsumerConfig.EXTRA_PLATFORM to env("QVAC_TEST_PLATFORM"),
        ConsumerConfig.EXTRA_BROKER_URL to (env("QVAC_MQTT_BROKER_URL") ?: error("QVAC_MQTT_BROKER_URL is not set; run this through qvac-test")),
        ConsumerConfig.EXTRA_MQTT_USERNAME to env("QVAC_MQTT_USERNAME"),
        ConsumerConfig.EXTRA_MQTT_PASSWORD to env("QVAC_MQTT_PASSWORD"),
        ConsumerConfig.EXTRA_SESSION_EXPIRY to env("QVAC_MQTT_SESSION_EXPIRY"),
    )

    private suspend fun startRuntime(): Runtime {
        log("🔧 Starting the QVAC worker...")
        val fixtureRoot = File(env("QVAC_E2E_FIXTURES") ?: error("QVAC_E2E_FIXTURES is not set")).canonicalFile
        require(fixtureRoot.isDirectory) { "the fixtures directory does not exist: $fixtureRoot" }
        val host = object : HostResolvers {
            override fun asset(kind: String, file: String): String {
                val root = Interpreter.ASSET_ROOTS[kind] ?: error("asset kind \"$kind\" has no root")
                return File(File(fixtureRoot, root), file).absolutePath
            }
        }
        val table = asMap(resourceJson("e2e/resources/resource-table.json"))
        // Policy is keyed by app family, the first segment of the platform (policyFor in platform-policy.ts).
        val policy = asMap(asMap(resourceJson("e2e/resources/platform-policy.json"))[RESOURCE_PLATFORM.substringBefore('-')])
        val unloadSettleMs = (policy["unloadSettleMs"] as? Number)?.toLong()
            ?: error("no platform policy for \"$RESOURCE_PLATFORM\" in platform-policy.json")
        val singleUseResources = asList(policy["singleUseResources"]).map(Any?::toString)
        val workerConfig = workerConfig()
        val transport = RestartableTransport.connect { JvmBareKitTransport.connect(config = workerConfig) }
        val client = QvacClient(transport)
        val wire = Wire(client)
        val resources = Resources(client, table, RESOURCE_PLATFORM, host, ::log, unloadSettleMs, singleUseResources)
        val calls = Calls(wire, resources, Files.createTempDirectory("qvac-e2e-scratch").toFile())
        val interpreter = Interpreter(resources, calls, fixtureRoot, ::log, restartWorker = transport::restart)
        log("✅ Worker ready")
        return Runtime(client, wire, resources, calls, interpreter)
    }

    /** The bundled worker config, with the keys of the QVAC_CONFIG_PATH file over it (CI's model cache). */
    private fun workerConfig(): JsonObject {
        val bundled = Json.parseToJsonElement(resourceText("e2e/worker-config.json")).jsonObject
        val override = env("QVAC_CONFIG_PATH")?.let { Json.parseToJsonElement(File(it).readText()).jsonObject }
            ?: return bundled
        return JsonObject(bundled + override)
    }

    private fun env(name: String): String? = System.getenv(name)?.takeIf { it.isNotEmpty() }

    private fun resourceText(path: String): String =
        (DesktopSession::class.java.classLoader.getResourceAsStream(path) ?: error("$path is not bundled"))
            .bufferedReader().use { it.readText() }

    private fun resourceJson(path: String): Any? = fromJson(Json.parseToJsonElement(resourceText(path)))
}
