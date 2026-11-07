pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

// The extracted qvac-sdk-kotlin-jvm-<version>-maven.zip release asset. Set it
// in gradle.properties: qvacMavenRepository=/absolute/path/to/qvac-maven-repository
val qvacMavenRepository: String? = providers.gradleProperty("qvacMavenRepository").orNull

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
        qvacMavenRepository?.let { maven { url = uri(it) } }
    }
}

rootProject.name = "qvac-sdk-kotlin-examples"

// Without qvacMavenRepository, io.tether:qvac-sdk-kotlin resolves to the SDK
// source in the parent directory of this monorepo checkout.
if (qvacMavenRepository == null) includeBuild("..")
