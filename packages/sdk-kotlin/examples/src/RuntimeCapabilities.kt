// Kotlin port of packages/sdk/examples/runtime-capabilities.ts.
//
// List the capability contracts the runtime provides, then check for the
// contracts and majors this app was built against. `client.system
// .runtimeCapabilities()` reads plugin registration only; it loads no model.
//
// RUN: ./gradlew -p examples run -Pexample=RuntimeCapabilities

import io.tether.qvac.sdk.QvacClient
import io.tether.qvac.sdk.jvm.JvmBareKitTransport
import io.tether.qvac.sdk.system
import kotlinx.coroutines.runBlocking
import kotlin.system.exitProcess

private val REQUIRED = listOf("completion" to 1L, "transcription" to 1L)

fun main(): Unit = runBlocking {
    val client = QvacClient(JvmBareKitTransport.connect())
    val missing = try {
        val capabilities = client.system.runtimeCapabilities().capabilities

        println("▸ Capability contracts the runtime provides")
        for (capability in capabilities) {
            val partial = if (capability.partialOperations.isEmpty()) "" else
                "; only some plugins: ${capability.partialOperations.joinToString(", ")}"
            println("  ${capability.id}@${capability.version}: ${capability.operations.joinToString(", ")}$partial")
        }

        REQUIRED.filter { (id, version) ->
            capabilities.none { it.id == id && it.version == version }
        }
    } finally {
        client.close()
    }

    if (missing.isNotEmpty()) {
        System.err.println("✖ Missing: ${missing.joinToString(", ") { (id, version) -> "$id@$version" }}")
        exitProcess(1)
    }
    println("\n▸ Every required contract is available.")
}
