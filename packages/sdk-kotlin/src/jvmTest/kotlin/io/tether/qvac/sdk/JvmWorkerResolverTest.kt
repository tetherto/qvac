package io.tether.qvac.sdk

import io.tether.qvac.sdk.generated.SDK_VERSION
import java.nio.file.Files
import java.nio.file.Path
import kotlin.io.path.createDirectories
import kotlin.io.path.writeText
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class JvmWorkerResolverTest {
    private fun writeFile(path: Path, text: String): Path {
        path.parent.createDirectories()
        path.writeText(text)
        return path
    }

    private fun writeSdk(
        root: Path,
        manifest: String = """{"name":"@qvac/sdk","version":"$SDK_VERSION","qvacIpcAuthentication":"token-v1"}""",
    ): Path {
        writeFile(root.resolve("package.json"), manifest)
        writeFile(root.resolve("dist/src/worker/index.js"), "worker")
        writeFile(root.resolve("dist/src/worker/tcp-shim.js"), "shim")
        return root
    }

    private fun writeBare(root: Path): Path {
        val bare = writeFile(JvmWorkerResolver.sidecarBareCandidates(root).first(), "bare")
        bare.toFile().setExecutable(true)
        return bare
    }

    @Test
    fun installerReusesVersionedCache() {
        val cache = Files.createTempDirectory("qvac-sdk-cache")
        val sdkRoot = writeSdk(cache.resolve("$SDK_VERSION/node_modules/@qvac/sdk"))

        val installed = JvmWorkerInstaller.install(
            cacheRoot = cache,
            npmExecutable = "must-not-run",
        )

        assertEquals(sdkRoot, installed)
    }

    @Test
    fun resolvesCompatibleSdkDirectory() {
        val root = writeSdk(Files.createTempDirectory("qvac-sdk-resolver"))
        val bare = writeBare(root)

        val resolved = JvmWorkerResolver.resolve(
            sdkDirectory = root.toString(),
            environment = emptyMap(),
            currentDirectory = root.resolve("consumer"),
            userHome = null,
        )

        assertEquals(root.resolve("dist/src/worker/index.js"), Path.of(resolved.workerPath))
        assertEquals(root.resolve("dist/src/worker/tcp-shim.js"), Path.of(resolved.shimPath))
        assertEquals(bare, Path.of(resolved.bareExecutable))
    }

    @Test
    fun resolvesTheSdkAWorkerEntryBelongsTo() {
        // A project's generated entry: the SDK is the one the project installed,
        // and the runtime is the bare-sidecar the install hoisted above it.
        val project = Files.createTempDirectory("qvac-project")
        val sdk = writeSdk(project.resolve("node_modules/@qvac/sdk"))
        val bare = writeBare(project)
        val entry = writeFile(project.resolve("qvac/worker.entry.mjs"), "entry")

        val resolved = JvmWorkerResolver.resolve(
            workerPath = entry.toString(),
            environment = emptyMap(),
            currentDirectory = project,
            userHome = null,
        )

        assertEquals(entry, Path.of(resolved.workerPath))
        assertEquals(sdk.resolve("dist/src/worker/tcp-shim.js"), Path.of(resolved.shimPath))
        assertEquals(bare, Path.of(resolved.bareExecutable))
    }

    @Test
    fun rejectsMismatchedSdkVersion() {
        val root = writeSdk(
            Files.createTempDirectory("qvac-sdk-mismatch"),
            """{"name":"@qvac/sdk","version":"0.0.0-mismatch"}""",
        )
        writeBare(root)

        val error = assertFailsWith<QvacWorkerStartException> {
            JvmWorkerResolver.resolve(
                sdkDirectory = root.toString(),
                environment = emptyMap(),
                currentDirectory = root.resolve("consumer"),
                userHome = null,
            )
        }

        assertTrue(error.message.orEmpty().contains("requires $SDK_VERSION"))
    }

    @Test
    fun explicitWorkerPathRequiresTokenIpcFromEnclosingSdk() {
        val bare = Files.createTempDirectory("qvac-bare").resolve("bare")
        bare.writeText("bare")
        bare.toFile().setExecutable(true)

        fun resolve(worker: java.nio.file.Path) = JvmWorkerResolver.resolve(
            workerPath = worker.toString(),
            bareExecutable = bare.toString(),
            environment = emptyMap(),
            currentDirectory = worker.parent,
            userHome = null,
        )

        val current = Files.createTempDirectory("qvac-explicit-current")
        current.resolve("package.json")
            .writeText("""{"name":"@qvac/sdk","version":"$SDK_VERSION","qvacIpcAuthentication":"token-v1"}""")
        val currentWorker = current.resolve("dist/src/worker/index.js")
        currentWorker.parent.createDirectories()
        currentWorker.writeText("worker")
        val shim = current.resolve("dist/src/worker/tcp-shim.js")
        shim.writeText("shim")
        assertEquals(shim, Path.of(resolve(currentWorker).shimPath))

        val tokenless = Files.createTempDirectory("qvac-explicit-tokenless")
        tokenless.resolve("package.json").writeText("""{"name":"@qvac/sdk","version":"0.0.0-older"}""")
        val tokenlessWorker = tokenless.resolve("dist/src/worker/index.js")
        tokenlessWorker.parent.createDirectories()
        tokenlessWorker.writeText("worker")
        val error = assertFailsWith<QvacWorkerStartException> { resolve(tokenlessWorker) }
        assertTrue(error.message.orEmpty().contains("qvacIpcAuthentication"))

        // No @qvac/sdk above the worker: there is no shim to start it with.
        val bareWorker = Files.createTempDirectory("qvac-explicit-bare").resolve("worker.js")
        bareWorker.writeText("worker")
        val missing = assertFailsWith<QvacWorkerStartException> { resolve(bareWorker) }
        assertTrue(missing.message.orEmpty().contains("QVAC_SDK_DIR"))
    }

    @Test
    fun rejectsAWorkerFolder() {
        val folder = Files.createTempDirectory("qvac-worker-folder")

        val error = assertFailsWith<QvacWorkerStartException> {
            JvmWorkerResolver.resolve(
                workerPath = folder.toString(),
                environment = emptyMap(),
                currentDirectory = folder,
                userHome = null,
            )
        }

        assertTrue(error.message.orEmpty().contains("is a folder"))
    }

    @Test
    fun rejectsWorkerMetadataWithoutTokenIpc() {
        val tokenless = Files.createTempDirectory("qvac-tokenless")
        tokenless.resolve("package.json").writeText("""{"version":"$SDK_VERSION"}""")
        val error = assertFailsWith<QvacWorkerStartException> { JvmWorkerResolver.requireCompatibleSdk(tokenless) }
        assertTrue(error.message.orEmpty().contains("token-v1"))

        val authenticated = Files.createTempDirectory("qvac-authenticated")
        authenticated.resolve("package.json")
            .writeText("""{"version":"$SDK_VERSION","qvacIpcAuthentication":"token-v1"}""")
        JvmWorkerResolver.requireCompatibleSdk(authenticated)
    }
}
