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
        providers.gradleProperty("qvacMavenRepository").orNull?.let { repositoryPath ->
            maven { url = uri(repositoryPath) }
        }
    }
}

rootProject.name = "qvac-sdk-kotlin"

include(":android-barekit")
include(":android-example")
