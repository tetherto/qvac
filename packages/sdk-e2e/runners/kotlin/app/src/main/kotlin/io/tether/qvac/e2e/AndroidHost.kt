package io.tether.qvac.e2e

import android.content.Context
import io.tether.qvac.e2e.runner.HostResolvers
import io.tether.qvac.e2e.runner.Interpreter
import java.io.File

/**
 * The app's view of its own files. The worker opens fixtures by path, and APK assets have none, so
 * the fixtures are copied out to app storage once per install.
 */
class AndroidHost(private val context: Context) : HostResolvers {
    val fixtureRoot: File = File(context.filesDir, "e2e/fixtures")

    /** Copies `assets/e2e/fixtures` out, unless this APK already did. */
    fun extractFixtures() {
        val stamp = File(fixtureRoot, ".installed")
        val version = context.packageManager.getPackageInfo(context.packageName, 0).lastUpdateTime.toString()
        if (stamp.exists() && stamp.readText() == version) return
        fixtureRoot.deleteRecursively()
        copyAssetTree("e2e/fixtures", fixtureRoot)
        stamp.writeText(version)
    }

    private fun copyAssetTree(path: String, target: File) {
        val children = context.assets.list(path).orEmpty()
        if (children.isEmpty()) {
            target.parentFile?.mkdirs()
            context.assets.open(path).use { input -> target.outputStream().use(input::copyTo) }
            return
        }
        target.mkdirs()
        for (child in children) copyAssetTree("$path/$child", File(target, child))
    }

    override fun asset(kind: String, file: String): String {
        val root = Interpreter.ASSET_ROOTS[kind] ?: error("asset kind \"$kind\" has no root")
        return File(File(fixtureRoot, root), file).absolutePath
    }
}
