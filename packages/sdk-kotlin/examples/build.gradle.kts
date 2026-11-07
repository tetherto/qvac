import java.lang.reflect.Modifier
import java.net.URLClassLoader

plugins {
    kotlin("jvm") version "2.4.20"
}

// Every file in src/ is one standalone example with its own `main`. Each gets
// its own source set, so a file compiles only against the SDK and never against
// a sibling example: the same file copied out of this directory still builds.
val exampleNames = layout.projectDirectory.dir("src").asFile
    .listFiles { file -> file.extension == "kt" }
    .orEmpty()
    .map { it.nameWithoutExtension }
    .sorted()

fun sourceSetName(example: String) = example.replaceFirstChar(Char::lowercase)

dependencies {
    // The release archive holds exactly one version; inside the monorepo the
    // included build substitutes the SDK source.
    implementation("io.tether:qvac-sdk-kotlin:+")
}

exampleNames.forEach { example ->
    val sourceSet = sourceSets.create(sourceSetName(example))
    kotlin.sourceSets.getByName(sourceSet.name).kotlin.apply {
        setSrcDirs(listOf("src"))
        include("$example.kt")
    }
    configurations.getByName(sourceSet.implementationConfigurationName)
        .extendsFrom(configurations.implementation.get())
}

// Third-party stores some examples write to, scoped to that example only
// (Python: the `examples` extra).
val exampleDependencies = mapOf(
    "RagMongodb" to listOf("org.mongodb:mongodb-driver-kotlin-coroutine:5.13.0"),
    "RagSqlite" to listOf("org.xerial:sqlite-jdbc:3.53.4.0"),
)

exampleDependencies.filterKeys { it in exampleNames }.forEach { (example, coordinates) ->
    val configuration = sourceSets.getByName(sourceSetName(example)).implementationConfigurationName
    coordinates.forEach { dependencies.add(configuration, it) }
}

val compileExamples by tasks.registering {
    group = "verification"
    description = "Compiles every example in isolation against the SDK."
    dependsOn(exampleNames.map { "compile${it}Kotlin" })
}

// `fun main() = runBlocking { ... }` takes its return type from the block's last
// expression, which compiles to a `main` the JVM cannot launch.
val verifyEntryPoints by tasks.registering {
    group = "verification"
    description = "Checks that every example compiles to a launchable static void main(String[])."
    dependsOn(compileExamples)
    val classpaths = exampleNames.associateWith { sourceSets.getByName(sourceSetName(it)).runtimeClasspath }
    doLast {
        val broken = classpaths.filter { (example, classpath) ->
            val urls = classpath.map { it.toURI().toURL() }.toTypedArray()
            URLClassLoader(urls, ClassLoader.getPlatformClassLoader()).use { loader ->
                val main = runCatching {
                    loader.loadClass("${example}Kt").getMethod("main", Array<String>::class.java)
                }.getOrNull()
                main == null || main.returnType != Void.TYPE || !Modifier.isStatic(main.modifiers)
            }
        }.keys
        check(broken.isEmpty()) {
            "No launchable static void main(String[]) in $broken: declare `fun main(): Unit = runBlocking { ... }`"
        }
    }
}

tasks.named("check") { dependsOn(compileExamples, verifyEntryPoints) }

// ./gradlew run -Pexample=Quickstart --args="path/to/input"
tasks.register<JavaExec>("run") {
    group = "application"
    description = "Runs the example named by -Pexample."
    val example = providers.gradleProperty("example").orNull
    if (example != null) {
        require(example in exampleNames) { "Unknown example '$example'; expected one of $exampleNames" }
        classpath = sourceSets.getByName(sourceSetName(example)).runtimeClasspath
        mainClass.set("${example}Kt")
    }
    standardInput = System.`in`
    doFirst {
        requireNotNull(example) { "Pass the example to run: -Pexample=<FileName>, one of $exampleNames" }
    }
}
