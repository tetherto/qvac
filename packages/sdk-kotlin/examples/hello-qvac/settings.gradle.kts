pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
        exclusiveContent {
            forRepository { maven("https://jitpack.io") } // bare-rpc-kotlin
            filter { includeGroupByRegex("com\\.github\\.holepunchto\\..*") }
        }
        // The extracted qvac-sdk-android-<profile>-<version>-maven.zip.
        maven { url = uri(providers.gradleProperty("qvacMavenRepository").get()) }
    }
}

rootProject.name = "hello-qvac"

include(":app")
