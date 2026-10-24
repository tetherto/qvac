// The Kotlin client of the SDK e2e catalog. It builds against the checkout's
// packages/sdk-kotlin through a composite build, so the runner tests the SDK
// at this commit without anything being published first.
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
    }
}

rootProject.name = "qvac-sdk-e2e-kotlin"

includeBuild("../../../sdk-kotlin") {
    dependencySubstitution {
        substitute(module("io.tether:qvac-sdk-android")).using(project(":android-barekit"))
    }
}

include(":app")
