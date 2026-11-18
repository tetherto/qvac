import org.jetbrains.kotlin.gradle.dsl.JvmTarget

// The catalog interpreter and the MQTT consumer, plain Kotlin apart from the Android app that hosts them.
plugins {
    id("org.jetbrains.kotlin.jvm")
}

kotlin {
    compilerOptions.jvmTarget.set(JvmTarget.JVM_17)
}

java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

dependencies {
    // The version the -PqvacSdkRepository Maven repository holds; the composite build ignores it.
    api("io.tether:qvac-sdk-kotlin:${providers.gradleProperty("qvacSdkVersion").getOrElse("local")}")
    api("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.11.0")
    api("org.jetbrains.kotlinx:kotlinx-serialization-json:1.11.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.eclipse.paho:org.eclipse.paho.client.mqttv3:1.2.5")
    implementation("org.eclipse.paho:org.eclipse.paho.mqttv5.client:1.2.5")
}
