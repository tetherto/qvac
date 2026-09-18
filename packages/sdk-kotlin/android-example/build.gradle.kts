plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
}

val qvacProfile = providers.gradleProperty("qvacProfile").orElse("aio")

android {
    namespace = "io.tether.qvac.sdk.sample"
    compileSdk = 36
    ndkVersion = "29.0.14206865"

    defaultConfig {
        missingDimensionStrategy("qvacProfile", qvacProfile.get())
        applicationId = "io.tether.qvac.sdk.sample"
        minSdk = 29
        targetSdk = 36
        versionCode = 1
        versionName = "1.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"

        ndk {
            abiFilters += "arm64-v8a"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    sourceSets {
        getByName("main").assets.directories.add("../../sdk/examples/audio")
    }

    buildFeatures {
        compose = true
    }
}

dependencies {
    val qvacArtifact = providers.gradleProperty("qvacArtifact")
    if (qvacArtifact.isPresent) {
        implementation("io.tether:${qvacArtifact.get()}:${rootProject.version}")
    } else {
        implementation(project(":android-barekit"))
    }
    val composeBom = platform("androidx.compose:compose-bom:2026.04.01")
    implementation(composeBom)
    implementation("androidx.activity:activity-compose:1.12.4")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.11.0")
    debugImplementation("androidx.compose.ui:ui-tooling")
    testImplementation("org.jetbrains.kotlin:kotlin-test-junit:2.3.20")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.11.0")
    androidTestImplementation("androidx.test:runner:1.6.2")
    androidTestImplementation("androidx.test:core:1.6.1")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
}
