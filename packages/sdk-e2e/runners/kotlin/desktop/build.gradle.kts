import groovy.json.JsonOutput
import groovy.json.JsonSlurper
import javax.inject.Inject
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

// The Kotlin client's e2e consumer on a desktop JVM, with the worker in-process through
// packages/sdk-kotlin/jvm-barekit. scripts/desktop.mjs builds it with installDist and runs it.
plugins {
    id("org.jetbrains.kotlin.jvm")
    application
}

/** The catalog, the resource table, the platform policy and the worker config, as classpath resources. */
abstract class StageE2eResources : DefaultTask() {
    @get:InputDirectory
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val catalogJson: DirectoryProperty

    @get:InputFiles
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val resources: ConfigurableFileCollection

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
        files.sync {
            into(root)
            from(catalogJson) { into("catalog") }
            from(resources) { into("resources") }
        }
        // The shared e2e worker config, minus the plugins and rpcServerProvider the profile decides.
        @Suppress("UNCHECKED_CAST")
        val worker = JsonSlurper().parse(workerConfigSource.get().asFile) as Map<String, Any?>
        root.file("worker-config.json").asFile.writeText(
            JsonOutput.prettyPrint(JsonOutput.toJson(worker - setOf("plugins", "rpcServerProvider"))),
        )
    }
}

// packages/sdk-e2e: the catalog and its resources.
val e2eRoot: File = rootDir.resolve("../..").canonicalFile
val catalogJsonDir = layout.buildDirectory.dir("intermediates/e2e-catalog")

val emitCatalogJson by tasks.registering(Exec::class) {
    description = "Write the catalog as JSON for the program to carry"
    workingDir(e2eRoot)
    commandLine(
        if (System.getProperty("os.name").startsWith("Windows")) listOf("cmd", "/c", "npm") else listOf("npm"),
    )
    args("run", "--silent", "emit:catalog-json", "--", "--out", catalogJsonDir.get().asFile.absolutePath)
    inputs.dir(e2eRoot.resolve("catalog"))
    inputs.file(e2eRoot.resolve("scripts/emit-catalog-json.mjs"))
    outputs.dir(catalogJsonDir)
}

val stageE2eResources by tasks.registering(StageE2eResources::class) {
    description = "Stage the catalog, the resource table, the platform policy and the worker config"
    catalogJson.set(layout.dir(emitCatalogJson.map { catalogJsonDir.get().asFile }))
    resources.from(e2eRoot.resolve("catalog/resources/resource-table.json"), e2eRoot.resolve("catalog/resources/platform-policy.json"))
    workerConfigSource.set(e2eRoot.resolve("fixtures/qvac.config.e2e.json"))
    outputDir.set(layout.buildDirectory.dir("generated/e2e-resources"))
}

sourceSets {
    main {
        resources.srcDir(stageE2eResources)
    }
}

kotlin {
    compilerOptions.jvmTarget.set(JvmTarget.JVM_17)
}

java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

application {
    applicationName = "qvac-e2e-desktop"
    mainClass.set("io.tether.qvac.e2e.desktop.MainKt")
}

dependencies {
    implementation(project(":runner"))
    // packages/sdk-kotlin/jvm-barekit through the composite build; it is not published.
    implementation("io.tether:qvac-sdk-jvm:local")
}
