// With -PqvacSdkRepository=<dir>, the Android app takes io.tether:qvac-sdk-android and
// io.tether:qvac-sdk-kotlin from that Maven repository, as an app outside the monorepo does;
// device.mjs build --maven publishes them there. Without it, this checkout's packages/sdk-kotlin is
// a composite build, for local work on both.
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

val sdkRepository = providers.gradleProperty("qvacSdkRepository").filter { it.isNotBlank() }.orNull

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
        // The SDK resolves its holepunch dependencies through this build's repositories, and
        // Holepunch publishes them only on JitPack.
        exclusiveContent {
            forRepository { maven("https://jitpack.io") }
            filter { includeGroupByRegex("com\\.github\\.holepunchto\\..*") }
        }
        if (sdkRepository != null) {
            exclusiveContent {
                forRepository { maven { url = file(sdkRepository).toURI() } }
                filter { includeGroup("io.tether") }
            }
        }
    }
}

rootProject.name = "qvac-sdk-e2e-kotlin"

if (sdkRepository == null) {
    includeBuild("../../../sdk-kotlin") {
        dependencySubstitution {
            substitute(module("io.tether:qvac-sdk-kotlin")).using(project(":"))
            substitute(module("io.tether:qvac-sdk-android")).using(project(":android-barekit"))
        }
    }
}

include(":runner")
include(":app")
