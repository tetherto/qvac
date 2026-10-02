package io.tether.qvac.sdk

import io.tether.qvac.sdk.generated.SDK_VERSION
import java.nio.file.Files
import kotlin.io.path.createDirectories
import kotlin.io.path.writeText
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class JvmWorkerResolverTest {
    @Test
    fun installerReusesVersionedCache() {
        val cache = Files.createTempDirectory("qvac-sdk-cache")
        val sdkRoot = cache.resolve("$SDK_VERSION/node_modules/@qvac/sdk")
        sdkRoot.createDirectories()
        sdkRoot.resolve("package.json").writeText("""{"version":"$SDK_VERSION","qvacIpcAuthentication":"token-v1"}""")
        sdkRoot.resolve("dist/src/worker").createDirectories()
        sdkRoot.resolve("dist/src/worker/index.js").writeText("worker")

        val installed = JvmWorkerInstaller.install(
            cacheRoot = cache,
            npmExecutable = "must-not-run",
        )

        assertEquals(sdkRoot, installed)
    }

    @Test
    fun resolvesCompatibleSdkDirectory() {
        val root = Files.createTempDirectory("qvac-sdk-resolver")
        val worker = root.resolve("dist/server/worker.js")
        val bare = root.resolve("node_modules/bare-runtime/bin/bare")
        worker.parent.createDirectories()
        bare.parent.createDirectories()
        worker.writeText("worker")
        bare.writeText("bare")
        bare.toFile().setExecutable(true)
        root.resolve("package.json").writeText("""{"version":"$SDK_VERSION","qvacIpcAuthentication":"token-v1"}""")

        val resolved = JvmWorkerResolver.resolve(
            sdkDirectory = root.toString(),
            environment = emptyMap(),
            currentDirectory = root.resolve("consumer"),
            userHome = null,
        )

        assertEquals(worker, java.nio.file.Path.of(resolved.workerPath))
        assertEquals(bare, java.nio.file.Path.of(resolved.bareExecutable))
        assertTrue(resolved.authenticated)
    }

    @Test
    fun rejectsMismatchedSdkVersion() {
        val root = Files.createTempDirectory("qvac-sdk-mismatch")
        val worker = root.resolve("dist/server/worker.js")
        val bare = root.resolve("node_modules/bare-runtime/bin/bare")
        worker.parent.createDirectories()
        bare.parent.createDirectories()
        worker.writeText("worker")
        bare.writeText("bare")
        root.resolve("package.json").writeText("""{"version":"0.0.0-mismatch"}""")

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
    fun negotiatesAuthenticationFromWorkerMetadata() {
        val tokenless = Files.createTempDirectory("qvac-tokenless")
        tokenless.resolve("package.json").writeText("""{"version":"$SDK_VERSION"}""")
        assertFalse(JvmWorkerResolver.requireCompatibleSdk(tokenless))

        val authenticated = Files.createTempDirectory("qvac-authenticated")
        authenticated.resolve("package.json")
            .writeText("""{"version":"$SDK_VERSION","qvacIpcAuthentication":"token-v1"}""")
        assertTrue(JvmWorkerResolver.requireCompatibleSdk(authenticated))
    }
}
