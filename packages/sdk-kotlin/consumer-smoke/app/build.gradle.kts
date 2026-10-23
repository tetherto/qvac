plugins {
    id("com.android.application") version "9.3.0"
}

// One product flavour per published runtime artifact, so a single build checks
// each artifact in its own variant. -PqvacProfile=<name> checks only that one.
val allQvacArtifacts = mapOf(
    "aio" to "qvac-sdk-android",
    "assistant" to "qvac-sdk-android-assistant",
    "llm" to "qvac-sdk-android-llm",
    "speech" to "qvac-sdk-android-speech",
    "vision" to "qvac-sdk-android-vision",
    "media" to "qvac-sdk-android-media",
    "robotics" to "qvac-sdk-android-robotics",
)
val selectedProfile = providers.gradleProperty("qvacProfile").filter { it.isNotBlank() }.orNull
val qvacArtifacts = if (selectedProfile == null) allQvacArtifacts else allQvacArtifacts.filterKeys { it == selectedProfile }
    .ifEmpty { error("Unknown qvacProfile '$selectedProfile'; expected one of ${allQvacArtifacts.keys}") }

android {
    namespace = "io.tether.qvac.sdk.consumer"
    compileSdk = 36

    defaultConfig {
        applicationId = "io.tether.qvac.sdk.consumer"
        minSdk = 29
        targetSdk = 36
        versionCode = 1
        versionName = "1.0"
    }

    flavorDimensions += "qvacArtifact"
    productFlavors {
        qvacArtifacts.keys.forEach { flavor ->
            create(flavor) { dimension = "qvacArtifact" }
        }
    }
}

dependencies {
    val qvacVersion = providers.gradleProperty("qvacVersion").get()
    qvacArtifacts.forEach { (flavor, artifact) ->
        add("${flavor}Implementation", "io.tether:$artifact:$qvacVersion")
    }
}

// Resolves each artifact and runs the manifest, resource, asset, native-library,
// duplicate-class and dex merges an app build performs. Stripping and packaging
// an APK test nothing about the artifact, so they are left out.
tasks.register("checkDebugBuild") {
    group = "verification"
    qvacArtifacts.keys.map { it.replaceFirstChar(Char::uppercase) }.forEach { flavor ->
        dependsOn(
            "process${flavor}DebugMainManifest",
            "process${flavor}DebugResources",
            "merge${flavor}DebugAssets",
            "merge${flavor}DebugNativeLibs",
            "check${flavor}DebugDuplicateClasses",
            "mergeExtDex${flavor}Debug",
            "mergeLibDex${flavor}Debug",
            "mergeProjectDex${flavor}Debug",
        )
    }
}
