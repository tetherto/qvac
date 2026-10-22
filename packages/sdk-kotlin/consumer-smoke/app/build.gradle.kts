plugins {
    id("com.android.application") version "9.3.0"
}

// One product flavour per published runtime artifact, so a single build
// resolves and packages each artifact into its own APK.
val qvacArtifacts = mapOf(
    "aio" to "qvac-sdk-android",
    "assistant" to "qvac-sdk-android-assistant",
    "llm" to "qvac-sdk-android-llm",
    "speech" to "qvac-sdk-android-speech",
    "vision" to "qvac-sdk-android-vision",
    "media" to "qvac-sdk-android-media",
    "robotics" to "qvac-sdk-android-robotics",
)

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
