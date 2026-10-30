package io.tether.qvac.sdk

import io.tether.qvac.sdk.generated.SDK_VERSION
import java.io.File
import java.nio.file.Files
import java.nio.file.Path
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * The worker process: bare-sidecar's Bare runtime running the SDK's TCP shim,
 * which loads [workerPath] and connects back to the port the transport appends.
 */
data class JvmWorkerCommand(
    val bareExecutable: String,
    val shimPath: String,
    val workerPath: String,
) {
    fun argv(): List<String> = listOf(bareExecutable, shimPath, workerPath)
}

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
        val configuredSdk = (sdkDirectory ?: environment["QVAC_SDK_DIR"])?.let(Path::of)

        if (configuredWorker != null) {
            if (Files.isDirectory(Path.of(configuredWorker))) {
                throw QvacWorkerStartException(
                    "$configuredWorker is a folder; this client takes a worker entry file, " +
                        "such as qvac/worker.entry.mjs",
                )
            }
            val worker = requireRegularFile(Path.of(configuredWorker), "QVAC worker")
            val root = configuredSdk ?: sdkRootNear(worker.parent)
                ?: throw QvacWorkerStartException(
                    "No @qvac/sdk was found for the worker at $worker. Set QVAC_SDK_DIR to " +
                        "the @qvac/sdk installation that provides its worker shim.",
                )
            // An explicit worker is not version-checked, but the shim that sends the
            // token comes from this SDK, so it must declare token-v1 IPC.
            requireTokenIpc(readPackageMetadata(root), root)
            return JvmWorkerCommand(
                bareExecutable = resolveBare(configuredBare, root, environment).toString(),
                shimPath = requireRegularFile(shimPath(root), "QVAC worker shim").toString(),
                workerPath = worker.toString(),
            )
        }

        val roots = linkedSetOf<Path>()
        configuredSdk?.let(roots::add)
        roots.addAll(discoverLocalSdkRoots(currentDirectory))
        managedSdkRoot(environment, userHome)?.let(roots::add)

        for (root in roots) {
            commandForRoot(root, configuredBare, environment)?.let { return it }
        }

        // `npm root -g` spawns a subprocess; only reach for it once the local and
        // managed roots have missed.
        npmGlobalSdkRoot()?.let { root ->
            commandForRoot(root, configuredBare, environment)?.let { return it }
        }

        throw QvacWorkerStartException(
            "No QVAC worker for SDK $SDK_VERSION was found. Set QVAC_SDK_DIR to an " +
                "@qvac/sdk@$SDK_VERSION installation, or set QVAC_WORKER_PATH and " +
                "QVAC_BARE_PATH explicitly.",
        )
    }

    private fun commandForRoot(
        root: Path,
        configuredBare: String?,
        environment: Map<String, String>,
    ): JvmWorkerCommand? {
        val worker = root.resolve("dist/src/worker/index.js")
        val shim = shimPath(root)
        if (!Files.isRegularFile(worker) || !Files.isRegularFile(shim)) return null
        requireCompatibleSdk(root)
        val bare = resolveBare(configuredBare, root, environment)
        return JvmWorkerCommand(
            bareExecutable = bare.toString(),
            shimPath = shim.toAbsolutePath().normalize().toString(),
            workerPath = worker.toAbsolutePath().normalize().toString(),
        )
    }

    private fun shimPath(root: Path): Path = root.resolve("dist/src/worker/tcp-shim.js")

    /**
     * The `@qvac/sdk` a worker entry belongs to: the package it sits in, or the one
     * its project installed.
     */
    private fun sdkRootNear(start: Path): Path? {
        var directory: Path? = start.toAbsolutePath().normalize()
        while (directory != null) {
            if (isSdkRoot(directory)) return directory
            val installed = directory.resolve("node_modules/@qvac/sdk")
            if (isSdkRoot(installed)) return installed
            directory = directory.parent
        }
        return null
    }

    private fun isSdkRoot(directory: Path): Boolean {
        val metadata = runCatching {
            Json.parseToJsonElement(Files.readString(directory.resolve("package.json"))).jsonObject
        }.getOrNull()
        return runCatching { metadata?.get("name")?.jsonPrimitive?.content }.getOrNull() == "@qvac/sdk"
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

    /**
     * bare-sidecar's Bare runtime for this host, in the SDK's node_modules or the
     * nearest ancestor's, where an install hoisted it.
     */
    internal fun sidecarBareCandidates(root: Path): List<Path> {
        val osName = System.getProperty("os.name")
        val executable = if (osName.startsWith("Windows", true)) "bare.exe" else "bare"
        val platform = when {
            osName.startsWith("Mac", true) -> "darwin"
            osName.startsWith("Windows", true) -> "win32"
            else -> "linux"
        }
        val architecture = when (System.getProperty("os.arch").lowercase()) {
            "aarch64", "arm64" -> "arm64"
            "amd64", "x86_64" -> "x64"
            else -> System.getProperty("os.arch").lowercase()
        }
        val relative = "node_modules/bare-sidecar/prebuilds/$platform-$architecture/$executable"
        return generateSequence(root.toAbsolutePath().normalize()) { it.parent }
            .map { it.resolve(relative) }
            .toList()
    }

    private fun resolveBare(
        configured: String?,
        root: Path,
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
        val bare = sidecarBareCandidates(root).firstOrNull(Files::isRegularFile)
            ?: throw QvacWorkerStartException(
                "No Bare executable was found for the @qvac/sdk at $root. Set QVAC_BARE_PATH, " +
                    "or install @qvac/sdk with its dependencies, which include bare-sidecar.",
            )
        // npm and bun do not reliably keep the exec bit on bare-sidecar's runtime;
        // bare-sidecar sets it when Node loads it, which never happens here.
        if (!Files.isExecutable(bare)) bare.toFile().setExecutable(true)
        return bare.toAbsolutePath().normalize()
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

    /** Verifies the resolved worker's version matches this client and that it declares token-v1 IPC. */
    internal fun requireCompatibleSdk(root: Path) {
        val metadata = readPackageMetadata(root)
        val version = runCatching { metadata?.get("version")?.jsonPrimitive?.content }.getOrNull()
        if (version != SDK_VERSION) {
            throw QvacWorkerStartException(
                "Resolved @qvac/sdk ${version ?: "with no readable version"}, but this Kotlin " +
                    "client requires $SDK_VERSION.",
            )
        }
        requireTokenIpc(metadata, root)
    }

    private fun readPackageMetadata(root: Path): JsonObject? {
        val packageJson = root.resolve("package.json")
        return runCatching { Json.parseToJsonElement(Files.readString(packageJson)).jsonObject }.getOrNull()
    }

    private fun requireTokenIpc(metadata: JsonObject?, root: Path) {
        if (metadata?.get("qvacIpcAuthentication")?.jsonPrimitive?.content == "token-v1") return
        throw QvacWorkerStartException(
            "The @qvac/sdk worker at $root does not declare \"qvacIpcAuthentication\": \"token-v1\", " +
                "so it cannot authenticate its IPC connection. Install @qvac/sdk@$SDK_VERSION.",
        )
    }

    private fun requireRegularFile(path: Path, label: String): Path {
        if (!Files.isRegularFile(path)) {
            throw QvacWorkerStartException("$label was not found at $path")
        }
        return path.toAbsolutePath().normalize()
    }
}
