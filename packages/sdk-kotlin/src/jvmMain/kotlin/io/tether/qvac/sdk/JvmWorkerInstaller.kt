package io.tether.qvac.sdk

import io.tether.qvac.sdk.generated.SDK_VERSION
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.TimeUnit

/** Installs the exact worker version used by this client into its versioned user cache. */
object JvmWorkerInstaller {
    fun install(
        cacheRoot: Path = defaultCacheRoot(),
        npmExecutable: String = "npm",
        timeoutMinutes: Long = 10,
    ): Path {
        val prefix = cacheRoot.resolve(SDK_VERSION)
        val sdkRoot = prefix.resolve("node_modules/@qvac/sdk")
        val packageJson = sdkRoot.resolve("package.json")
        fun hasWorker() = listOf("dist/src/worker/index.js", "dist/server/worker.js")
            .any { Files.isRegularFile(sdkRoot.resolve(it)) }
        if (Files.isRegularFile(packageJson) && hasWorker()) {
            JvmWorkerResolver.requireCompatibleSdk(sdkRoot)
            return sdkRoot
        }

        Files.createDirectories(prefix)
        val process = ProcessBuilder(
            npmExecutable,
            "install",
            "--prefix",
            prefix.toString(),
            "--ignore-scripts",
            "@qvac/sdk@$SDK_VERSION",
        ).inheritIO().start()
        if (!process.waitFor(timeoutMinutes, TimeUnit.MINUTES)) {
            process.destroyForcibly()
            throw QvacWorkerStartException(
                "Timed out installing @qvac/sdk@$SDK_VERSION into $prefix",
            )
        }
        if (process.exitValue() != 0 || !hasWorker()) {
            throw QvacWorkerStartException(
                "npm could not install @qvac/sdk@$SDK_VERSION into $prefix",
            )
        }
        JvmWorkerResolver.requireCompatibleSdk(sdkRoot)
        return sdkRoot
    }

    private fun defaultCacheRoot(): Path {
        val configured = System.getenv("QVAC_WORKER_HOME")
        if (!configured.isNullOrBlank()) return Path.of(configured)
        val userHome = System.getProperty("user.home")
            ?: throw QvacWorkerStartException(
                "No user home is available; set QVAC_WORKER_HOME for the managed worker cache",
            )
        return Path.of(userHome).resolve(".cache/qvac/worker")
    }
}
