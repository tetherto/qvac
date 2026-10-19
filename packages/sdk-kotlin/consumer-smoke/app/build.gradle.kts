plugins {
    id("com.android.application") version "9.3.0"
}

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
}

dependencies {
    val qvacArtifact = providers.gradleProperty("qvacArtifact").orElse("qvac-sdk-android")
    val qvacVersion = providers.gradleProperty("qvacVersion")
    implementation("io.tether:${qvacArtifact.get()}:${qvacVersion.get()}")
}
