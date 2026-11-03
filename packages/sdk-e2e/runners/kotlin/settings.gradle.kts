// Builds against this checkout's packages/sdk-kotlin as a composite build, so the
// runner tests the SDK at this commit without publishing it first.
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
        // The included sdk-kotlin build resolves its holepunch dependencies through this
        // build's repositories, and Holepunch publishes them only on JitPack.
        exclusiveContent {
            forRepository { maven("https://jitpack.io") }
            filter { includeGroupByRegex("com\\.github\\.holepunchto\\..*") }
        }
    }
}

rootProject.name = "qvac-sdk-e2e-kotlin"

includeBuild("../../../sdk-kotlin") {
    dependencySubstitution {
        substitute(module("io.tether:qvac-sdk-android")).using(project(":android-barekit"))
    }
}

include(":app")
