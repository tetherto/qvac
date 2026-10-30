plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android") version "2.4.20" apply false
}

android {
    namespace = "io.tether.qvac.hello"
    compileSdk = 36

    defaultConfig {
        applicationId = "io.tether.qvac.hello"
        minSdk = 29
        targetSdk = 36
        versionCode = 1
        versionName = "1.0"
        ndk {
            abiFilters += "arm64-v8a"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    implementation("io.tether:qvac-sdk-android-llm:0.22.0")
}
