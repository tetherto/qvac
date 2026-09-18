package io.tether.qvac.sdk

import io.tether.qvac.sdk.generated.SDK_VERSION
import java.io.File
import java.nio.file.Files
import java.nio.file.Path
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

data class JvmWorkerCommand(
    val bareExecutable: String,
    val workerPath: String,
    val authenticated: Boolean = false,
)

/** Resolves a version-compatible desktop worker without requiring hard-coded paths. */
object JvmWorkerResolver {
    fun resolve(
        workerPath: String? = null,
        bareExecutable: String? = null,
        sdkDirectory: String? = null,
    ): JvmWorkerCommand = resolve(
        workerPath = workerPath,
        bareExecutable = bareExecutable,
        sdkDirectory = sdkDirectory,
        environment = System.getenv(),
        currentDirectory = Path.of("").toAbsolutePath(),
        userHome = System.getProperty("user.home")?.let(Path::of),
    )

    internal fun resolve(
        workerPath: String? = null,
        bareExecutable: String? = null,
        sdkDirectory: String? = null,
        environment: Map<String, String>,
        currentDirectory: Path,
        userHome: Path?,
    ): JvmWorkerCommand {
        val configuredWorker = workerPath ?: environment["QVAC_WORKER_PATH"]
        val configuredBare = bareExecutable ?: environment["QVAC_BARE_PATH"]
        if (configuredWorker != null) {
            val worker = requireRegularFile(Path.of(configuredWorker), "QVAC worker")
            val bare = resolveBare(configuredBare, emptyList(), environment)
            return JvmWorkerCommand(bare.toString(), worker.toString())
        }

        val roots = linkedSetOf<Path>()
        (sdkDirectory ?: environment["QVAC_SDK_DIR"])?.let { roots.add(Path.of(it)) }
        roots.addAll(discoverLocalSdkRoots(currentDirectory))
        managedSdkRoot(environment, userHome)?.let(roots::add)
        npmGlobalSdkRoot()?.let(roots::add)

        for (root in roots) {
            val worker = workerCandidates(root).firstOrNull(Files::isRegularFile) ?: continue
            val authenticated = requireCompatibleSdk(root)
            val bare = resolveBare(configuredBare, bareCandidates(root), environment)
            return JvmWorkerCommand(bare.toString(), worker.toString(), authenticated)
        }

        throw QvacWorkerStartException(
            "No QVAC worker for SDK $SDK_VERSION was found. Set QVAC_SDK_DIR to an " +
                "@qvac/sdk@$SDK_VERSION installation, or set QVAC_WORKER_PATH and " +
                "QVAC_BARE_PATH explicitly.",
        )
    }

    private fun discoverLocalSdkRoots(start: Path): List<Path> {
        val roots = mutableListOf<Path>()
        var directory: Path? = start.toAbsolutePath().normalize()
        while (directory != null) {
            roots.add(directory.resolve("node_modules/@qvac/sdk"))
            roots.add(directory.resolve("packages/sdk"))
            directory = directory.parent
        }
        return roots
    }

    private fun managedSdkRoot(environment: Map<String, String>, userHome: Path?): Path? {
        val base = environment["QVAC_WORKER_HOME"]?.let(Path::of)
            ?: userHome?.resolve(".cache/qvac/worker")
            ?: return null
        return base.resolve(SDK_VERSION).resolve("node_modules/@qvac/sdk")
    }

    private fun npmGlobalSdkRoot(): Path? {
        return runCatching {
            val process = ProcessBuilder("npm", "root", "-g")
                .redirectErrorStream(true)
                .start()
            if (!process.waitFor(15, java.util.concurrent.TimeUnit.SECONDS)) {
                process.destroyForcibly()
                return null
            }
            if (process.exitValue() != 0) return null
            process.inputStream.bufferedReader().use { it.readText() }
                .trim()
                .takeIf(String::isNotEmpty)
                ?.let(Path::of)
                ?.resolve("@qvac/sdk")
        }.getOrNull()
    }

    private fun workerCandidates(root: Path): List<Path> = listOf(
        root.resolve("dist/server/worker.js"),
        root.resolve("dist/src/worker/index.js"),
    )

    private fun bareCandidates(root: Path): List<Path> {
        val executable = if (System.getProperty("os.name").startsWith("Windows", true)) {
            "bare.exe"
        } else {
            "bare"
        }
        val platform = when {
            System.getProperty("os.name").startsWith("Mac", true) -> "darwin"
            System.getProperty("os.name").startsWith("Windows", true) -> "win32"
            else -> "linux"
        }
        val architecture = when (System.getProperty("os.arch").lowercase()) {
            "aarch64", "arm64" -> "arm64"
            "amd64", "x86_64" -> "x64"
            else -> System.getProperty("os.arch").lowercase()
        }
        // Prefer the real runtime binary: supervising a Node launcher can leave
        // its native child behind when the launcher is terminated.
        return listOf(
            root.resolve("node_modules/bare-runtime-$platform-$architecture/bin/$executable"),
            root.parent?.parent?.resolve("bare-runtime-$platform-$architecture/bin/$executable"),
            root.resolve("node_modules/bare-runtime/bin/$executable"),
            root.parent?.parent?.resolve("bare-runtime/bin/$executable"),
        ).filterNotNull()
    }

    private fun resolveBare(
        configured: String?,
        candidates: List<Path>,
        environment: Map<String, String>,
    ): Path {
        if (configured != null) {
            val configuredPath = Path.of(configured)
            if (configuredPath.nameCount > 1 || configuredPath.isAbsolute) {
                val executable = requireRegularFile(configuredPath, "Bare executable")
                if (!Files.isExecutable(executable)) throw QvacWorkerStartException("Bare executable is not executable: $executable")
                return executable
            }
            findOnPath(configured, environment)?.let { return it }
            throw QvacWorkerStartException("Bare executable '$configured' was not found on PATH")
        }
        candidates.firstOrNull { Files.isRegularFile(it) && Files.isExecutable(it) }?.let { return it.toAbsolutePath().normalize() }
        findOnPath(defaultBareExecutable(), environment)?.let { return it }
        throw QvacWorkerStartException(
            "No Bare executable was found. Set QVAC_BARE_PATH or install bare-runtime.",
        )
    }

    private fun findOnPath(command: String, environment: Map<String, String>): Path? {
        val path = environment["PATH"] ?: return null
        return path.split(File.pathSeparatorChar)
            .asSequence()
            .map { Path.of(it).resolve(command) }
            .firstOrNull { Files.isRegularFile(it) && Files.isExecutable(it) }
            ?.toAbsolutePath()
            ?.normalize()
    }

    /**
     * Verifies the resolved worker matches this client's SDK version and reports
     * whether it advertises token-v1 IPC. Authentication is negotiated per worker:
     * a worker that does not declare it (the published stable release) runs over an
     * unauthenticated loopback channel rather than being rejected. Enforcement
     * returns once a coordinated token-v1 worker release is the pinned version.
     */
    internal fun requireCompatibleSdk(root: Path): Boolean {
        val packageJson = root.resolve("package.json")
        val metadata = runCatching { Json.parseToJsonElement(Files.readString(packageJson)).jsonObject }.getOrNull()
        val version = runCatching { metadata?.get("version")?.jsonPrimitive?.content }.getOrNull()
        if (version != SDK_VERSION) {
            throw QvacWorkerStartException(
                "Resolved @qvac/sdk ${version ?: "with no readable version"}, but this Kotlin " +
                    "client requires $SDK_VERSION.",
            )
        }
        return metadata?.get("qvacIpcAuthentication")?.jsonPrimitive?.content == "token-v1"
    }

    private fun requireRegularFile(path: Path, label: String): Path {
        if (!Files.isRegularFile(path)) {
            throw QvacWorkerStartException("$label was not found at $path")
        }
        return path.toAbsolutePath().normalize()
    }

    private fun defaultBareExecutable(): String {
        return if (System.getProperty("os.name").startsWith("Windows", true)) "bare.exe" else "bare"
    }
}
