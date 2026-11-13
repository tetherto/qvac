import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    kotlin("jvm")
}

group = "io.tether"
version = rootProject.version

val runtimeRoot = rootProject.layout.projectDirectory
val generatedRuntime = layout.buildDirectory.dir("generated/qvac/aio")

kotlin {
    compilerOptions.jvmTarget.set(JvmTarget.JVM_11)
}

java {
    sourceCompatibility = JavaVersion.VERSION_11
    targetCompatibility = JavaVersion.VERSION_11
}

// The module bare-stow writes for the worker: the harness, and the bundle with
// its addons as classpath resources, next to the profile, LICENSE and NOTICE.
sourceSets {
    main {
        kotlin.srcDir(generatedRuntime.map { it.dir("worker/src/main/kotlin") })
        resources.srcDir(generatedRuntime.map { it.dir("worker/src/main/resources") })
        resources.srcDir(generatedRuntime.map { it.dir("resources") })
    }
}

val workspaceSdk = runtimeRoot.dir("../sdk")
val workspaceInference = runtimeRoot.dir("../inference")
val hasWorkspaceSdk = workspaceSdk.file("package.json").asFile.exists()

val prepareQvacJvmRuntime by tasks.registering(Exec::class) {
    description = "Bundle the QVAC worker for this desktop host"
    usesService(gradle.sharedServices.registrations.getByName("qvacRuntimeBundleLock").service)
    dependsOn(":android-barekit:npmCi", ":android-barekit:buildWorkspaceSdk")
    workingDir(runtimeRoot)
    commandLine("node", "scripts/prepare-runtime.mjs")
    environment("QVAC_KOTLIN_PLATFORM", "jvm")
    environment("QVAC_KOTLIN_CONFIG", runtimeRoot.file("qvac.config.json").asFile.absolutePath)
    environment("QVAC_KOTLIN_PROFILE", "aio")
    environment("QVAC_KOTLIN_GENERATED_ROOT", generatedRuntime.get().asFile.absolutePath)
    inputs.files(
        runtimeRoot.file("package.json"),
        runtimeRoot.file("qvac.config.json"),
        runtimeRoot.file("scripts/prepare-runtime.mjs"),
    )
    if (hasWorkspaceSdk) {
        inputs.files(workspaceSdk.file("package.json"), workspaceSdk.file("LICENSE"), workspaceSdk.file("NOTICE"))
        inputs.dir(workspaceSdk.dir("dist"))
        inputs.dir(workspaceInference.dir("dist"))
    } else {
        inputs.dir(runtimeRoot.dir("node_modules/@qvac/sdk"))
    }
    outputs.dir(generatedRuntime)
}

tasks.named("compileKotlin") { dependsOn(prepareQvacJvmRuntime) }
tasks.named("processResources") { dependsOn(prepareQvacJvmRuntime) }

tasks.test {
    useJUnit()
}

dependencies {
    api(project(":"))
    // bare-stow's `bare-kit` harness deps, at its pins: the Bare the SDK checks the bundle against.
    api("com.github.holepunchto.bare-kit-kotlin:bare-kit-kotlin:v0.2.+")
    api("com.github.holepunchto.bare-stow-host-kotlin:bare-stow-host-kotlin:v0.2.+")

    testImplementation(kotlin("test"))
}
