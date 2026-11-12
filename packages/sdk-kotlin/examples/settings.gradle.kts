pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
        // Holepunch publishes bare-rpc-kotlin and compact-encoding-kotlin through JitPack.
        exclusiveContent {
            forRepository { maven("https://jitpack.io") }
            filter { includeGroupByRegex("com\\.github\\.holepunchto\\..*") }
        }
    }
}

rootProject.name = "qvac-sdk-kotlin-examples"

// The SDK and its desktop JVM host (:jvm-barekit, not published) build from
// the parent directory of this checkout.
includeBuild("..")
