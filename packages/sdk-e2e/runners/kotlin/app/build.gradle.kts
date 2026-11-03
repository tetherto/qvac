import groovy.json.JsonOutput
import groovy.json.JsonSlurper
import javax.inject.Inject

plugins {
    id("com.android.application")
}

/**
 * Stages `assets/e2e` as one generated source directory, so AGP wires it only into tasks that read
 * assets: compiling and unit-testing the app need neither npm nor the e2e package installed.
 */
abstract class StageE2eAssets : DefaultTask() {
    @get:InputDirectory
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val catalogJson: DirectoryProperty

    @get:InputFiles
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val resources: ConfigurableFileCollection

    @get:InputDirectory
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val fixtures: DirectoryProperty

    @get:Input
    abstract val consumerConfig: Property<String>

    @get:InputFile
    @get:PathSensitive(PathSensitivity.NONE)
    abstract val workerConfigSource: RegularFileProperty

    @get:OutputDirectory
    abstract val outputDir: DirectoryProperty

    @get:Inject
    abstract val files: FileSystemOperations

    @TaskAction
    fun stage() {
        val root = outputDir.get().dir("e2e")
        // Sync, not copy: a fixture or table entry removed from the catalog leaves the APK too.
        files.sync {
            into(root)
            from(catalogJson) { into("catalog") }
            from(resources) { into("resources") }
            from(fixtures) { into("fixtures") }
        }
        root.file("consumer-config.json").asFile.writeText(consumerConfig.get())
        // The shared e2e worker config, minus the plugins and rpcServerProvider the profile decides.
        @Suppress("UNCHECKED_CAST")
        val worker = JsonSlurper().parse(workerConfigSource.get().asFile) as Map<String, Any?>
        root.file("worker-config.json").asFile.writeText(
            JsonOutput.prettyPrint(JsonOutput.toJson(worker - setOf("plugins", "rpcServerProvider"))),
        )
    }
}

// packages/sdk-e2e: the catalog, its resources and the fixtures the app carries.
val e2eRoot: File = rootDir.resolve("../..").canonicalFile
val catalogJsonDir = layout.buildDirectory.dir("intermediates/e2e-catalog")

// Same variables as the JS mobile build (qvac-test.config.js). A Gradle property wins over the
// environment, and an intent extra at launch wins over both.
fun setting(property: String, env: String, default: String? = null): String? =
    providers.gradleProperty(property).orNull?.takeIf { it.isNotEmpty() }
        ?: providers.environmentVariable(env).orNull?.takeIf { it.isNotEmpty() }
        ?: default

val bakedConsumerConfig: Map<String, Any?> = run {
    val caPath = setting("qvacMqttCaPath", "MQTT_CA_PATH")
    val sessionExpiry = setting("qvacMqttSessionExpiry", "QVAC_MQTT_SESSION_EXPIRY")
        ?: if (providers.environmentVariable("GITHUB_ACTIONS").orNull == "true") "7200" else null
    mapOf(
        "runId" to setting("qvacRunId", "E2E_RUN_ID", "*"),
        "platform" to setting("qvacPlatform", "QVAC_TEST_PLATFORM", "kotlin-android"),
        "mqtt" to mapOf(
            "protocol" to setting("qvacMqttProtocol", "MQTT_PROTOCOL", "ws"),
            "host" to setting("qvacMqttHost", "MQTT_HOST", "localhost"),
            "port" to setting("qvacMqttPort", "MQTT_PORT", "8080"),
            "path" to setting("qvacMqttPath", "MQTT_PATH", "/mqtt"),
            "username" to setting("qvacMqttUsername", "MQTT_USERNAME"),
            "password" to setting("qvacMqttPassword", "MQTT_PASSWORD"),
            // Resolved against the directory Gradle was started from, as a path on the command line reads.
            "ca" to caPath?.let { path ->
                val ca = File(path).let { if (it.isAbsolute) it else File(gradle.startParameter.currentDir, path) }
                if (!ca.isFile) throw GradleException("the MQTT CA file does not exist: $ca")
                ca.readText()
            },
            "rejectUnauthorized" to true,
            "sessionExpiryInterval" to sessionExpiry?.let { raw ->
                // The MQTT 5 range, checked here the way the JS mobile build checks it.
                raw.toLongOrNull()?.takeIf { it in 1..4294967294 }
                    ?: throw GradleException("MQTT session expiry must be 1..4294967294 seconds, got \"$raw\"")
            },
        ),
    )
}

val emitCatalogJson by tasks.registering(Exec::class) {
    description = "Write the catalog as JSON for the app to carry"
    workingDir(e2eRoot)
    commandLine("npm", "run", "--silent", "emit:catalog-json", "--", "--out", catalogJsonDir.get().asFile.absolutePath)
    inputs.dir(e2eRoot.resolve("catalog"))
    inputs.file(e2eRoot.resolve("scripts/emit-catalog-json.mjs"))
    outputs.dir(catalogJsonDir)
}

val stageE2eAssets by tasks.registering(StageE2eAssets::class) {
    description = "Stage the catalog, the resource table, the fixtures and the configs"
    catalogJson.set(layout.dir(emitCatalogJson.map { catalogJsonDir.get().asFile }))
    // What the app reads: the skip matrix is a catalog gate, not client data.
    resources.from(e2eRoot.resolve("catalog/resources/resource-table.json"), e2eRoot.resolve("catalog/resources/platform-policy.json"))
    fixtures.set(e2eRoot.resolve("assets"))
    consumerConfig.set(JsonOutput.prettyPrint(JsonOutput.toJson(bakedConsumerConfig)))
    workerConfigSource.set(e2eRoot.resolve("fixtures/qvac.config.e2e.json"))
}

androidComponents {
    onVariants { variant ->
        variant.sources.assets?.addGeneratedSourceDirectory(stageE2eAssets, StageE2eAssets::outputDir)
    }
}

android {
    namespace = "io.tether.qvac.e2e"
    compileSdk = 36
    ndkVersion = "29.0.14206865"

    defaultConfig {
        // The runtime profile the app carries; -PqvacProfile also limits the Kotlin SDK's build to it.
        missingDimensionStrategy("qvacProfile", providers.gradleProperty("qvacProfile").filter { it.isNotBlank() }.orElse("aio").get())
        applicationId = "io.tether.qvac.e2e.kotlin"
        minSdk = 29
        targetSdk = 36
        versionCode = 1
        versionName = "1.0"

        ndk {
            abiFilters += "arm64-v8a"
        }
    }

    buildTypes {
        getByName("release") {
            isMinifyEnabled = false
            // Device Farm only installs it: the debug key spares the runner a keystore.
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    packaging {
        jniLibs {
            excludes += setOf("**/armeabi-v7a/**", "**/x86/**", "**/x86_64/**")
        }
        resources {
            // Both Paho jars carry an OSGi `bundle.properties` at the root; neither client reads it.
            excludes += setOf("bundle.properties")
            // Paho finds its transports through ServiceLoader: the app's OkHttp WebSocket factory has
            // to be appended to Paho's service file, not dropped in favour of it.
            merges += setOf("META-INF/services/**")
        }
    }

    testOptions {
        unitTests.isReturnDefaultValues = true
    }
}

dependencies {
    implementation("io.tether:qvac-sdk-android:local")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.11.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.11.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.eclipse.paho:org.eclipse.paho.client.mqttv3:1.2.5")
    implementation("org.eclipse.paho:org.eclipse.paho.mqttv5.client:1.2.5")
    testImplementation("org.jetbrains.kotlin:kotlin-test-junit:2.4.20")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.11.0")
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
}
