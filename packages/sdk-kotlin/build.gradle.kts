import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import org.gradle.api.tasks.Exec
import org.gradle.api.publish.maven.MavenPublication
import java.net.URI
import java.util.zip.ZipFile
import java.security.MessageDigest

plugins {
    kotlin("multiplatform") version "2.3.20"
    kotlin("plugin.serialization") version "2.3.20"
    id("org.jetbrains.kotlin.plugin.compose") version "2.3.20" apply false
    id("maven-publish")
    id("signing")
    id("org.jetbrains.dokka") version "2.2.0"
    id("com.vanniktech.maven.publish.base") version "0.37.0"
    id("com.android.kotlin.multiplatform.library") version "9.3.0"
    id("com.android.library") version "9.3.0" apply false
    id("com.android.application") version "9.3.0" apply false
}

group = "io.tether"
val sdkPackageJson = projectDir.parentFile.resolve("sdk/package.json")
val sdkVersion = Regex("\"version\"\\s*:\\s*\"([^\"]+)\"")
    .find(sdkPackageJson.readText())
    ?.groupValues
    ?.get(1)
    ?: error("Could not read @qvac/sdk version from $sdkPackageJson")
version = sdkVersion

// Keep the existing coordinates/publications; delegate Central's deployment
// lifecycle to the maintained publisher rather than a custom HTTP uploader.
mavenPublishing {
    publishToMavenCentral(automaticRelease = false,
        validateDeployment = com.vanniktech.maven.publish.DeploymentValidation.PUBLISHED)
}

val qvacPomName = "QVAC Kotlin Multiplatform SDK"
val qvacPomDescription = "Typed Kotlin client for the QVAC local inference worker"

fun MavenPublication.configureQvacPom(publicationName: String, publicationDescription: String) {
    pom {
        name.set(publicationName)
        description.set(publicationDescription)
        url.set("https://github.com/tetherto/qvac")
        licenses {
            license {
                name.set("Apache License, Version 2.0")
                url.set("https://www.apache.org/licenses/LICENSE-2.0.txt")
                distribution.set("repo")
            }
        }
        developers {
            developer {
                id.set("tether-data")
                name.set("Tether Data")
                organization.set("Tether Data")
                organizationUrl.set("https://tether.io")
            }
        }
        scm {
            connection.set("scm:git:https://github.com/tetherto/qvac.git")
            developerConnection.set("scm:git:ssh://git@github.com/tetherto/qvac.git")
            url.set("https://github.com/tetherto/qvac")
        }
    }
}

val signingKey = providers.environmentVariable("MAVEN_SIGNING_KEY")
val signingPassword = providers.environmentVariable("MAVEN_SIGNING_PASSWORD")
signing {
    if (signingKey.isPresent) {
        useInMemoryPgpKeys(signingKey.get(), signingPassword.orNull)
        sign(publishing.publications)
    }
}

val generateContract = tasks.register<Exec>("generateContract") {
    inputs.files(fileTree("scripts") { include("*.py") })
    commandLine("python3", "$projectDir/scripts/generate-contract.py")
    inputs.dir(projectDir.parentFile.resolve("sdk/contract"))
    inputs.file(projectDir.parentFile.resolve("sdk/package.json"))
    outputs.dir("$projectDir/src/commonMain/kotlin/io/tether/qvac/sdk/generated")
}

val checkContract = tasks.register<Exec>("checkContract") {
    inputs.files(fileTree("scripts") { include("*.py") })
    commandLine("python3", "$projectDir/scripts/generate-contract.py", "--check")
    inputs.dir(projectDir.parentFile.resolve("sdk/contract"))
    inputs.file(projectDir.parentFile.resolve("sdk/package.json"))
    inputs.dir("$projectDir/src/commonMain/kotlin/io/tether/qvac/sdk/generated")
}

val testContractGenerator = tasks.register<Exec>("testContractGenerator") {
    commandLine("python3", "-m", "unittest", "discover", "-s", "$projectDir/scripts", "-p", "test_*.py")
}
val checkWireFixtures = tasks.register<Exec>("checkWireFixtures") {
    dependsOn(":android-barekit:npmCi")
    commandLine("node", "$projectDir/scripts/generate-wire-fixtures.cjs", "--check")
}
val checkWireLiterals = tasks.register<Exec>("checkWireLiterals") {
    commandLine("python3", "$projectDir/scripts/check-wire-literals.py")
}
checkContract.configure { dependsOn(testContractGenerator, checkWireLiterals) }
tasks.matching { it.name == "jvmTest" }.configureEach { dependsOn(checkWireFixtures) }
val testReleaseGate = tasks.register<Exec>("testReleaseGate") {
    commandLine("node", "--test", "$projectDir/scripts/verify-published-worker.test.mjs")
}
val verifyPublishedWorker = tasks.register<Exec>("verifyPublishedWorker") {
    commandLine("node", "$projectDir/scripts/verify-published-worker.mjs")
}
checkContract.configure { dependsOn(testReleaseGate) }

// Local repositories and PR builds need no credentials. A public Central
// publication must never silently degrade to unsigned artifacts.
allprojects {
    tasks.matching { it.name == "prepareMavenCentralPublishing" }.configureEach {
        dependsOn(verifyPublishedWorker)
        doFirst {
            check(signingKey.isPresent && signingKey.get().isNotBlank()) {
                "Central deployment requires MAVEN_SIGNING_KEY"
            }
        }
    }
    tasks.withType<org.gradle.api.publish.maven.tasks.PublishToMavenRepository>().configureEach {
        // Publishing assigns the repository after creating the task. Resolve
        // this dependency lazily, once the task is fully configured.
        dependsOn(providers.provider {
            if (repository.name == "mavenCentral" || repository.url.scheme != "file")
                listOf(verifyPublishedWorker) else emptyList()
        })
        doFirst {
            val destination = repository.url.host.orEmpty()
            if (repository.name == "mavenCentral" || destination.contains("sonatype") || destination.contains("maven.org") ||
                providers.environmentVariable("MAVEN_REQUIRE_SIGNING").orNull == "true") {
                check(signingKey.isPresent && signingKey.get().isNotBlank()) {
                    "Release publication requires MAVEN_SIGNING_KEY"
                }
            }
        }
    }
}

val verifyAndroidRuntimeProfiles = tasks.register<Exec>("verifyAndroidRuntimeProfiles") {
    commandLine("node", "$projectDir/scripts/verify-runtime-profiles.mjs")
    inputs.file(projectDir.parentFile.resolve("sdk/package.json"))
    inputs.files(projectDir.listFiles { file ->
        file.name.startsWith("qvac.config") && file.extension == "json"
    }?.toList().orEmpty())
    inputs.file(projectDir.resolve("scripts/verify-runtime-profiles.mjs"))
}

val checkVersionAlignment = tasks.register("checkVersionAlignment") {
    dependsOn(verifyAndroidRuntimeProfiles)
    inputs.file(projectDir.resolve("package.json"))
    inputs.file(sdkPackageJson)
    doLast {
        val runtimePackage = projectDir.resolve("package.json").readText()
        val runtimeVersion = Regex("\"version\"\\s*:\\s*\"([^\"]+)\"")
            .find(runtimePackage)
            ?.groupValues
            ?.get(1)
        val workerVersion = Regex("\"@qvac/sdk\"\\s*:\\s*\"([^\"]+)\"")
            .find(runtimePackage)
            ?.groupValues
            ?.get(1)
        check(runtimeVersion == sdkVersion && workerVersion == sdkVersion) {
            "Kotlin runtime version ($runtimeVersion), @qvac/sdk dependency ($workerVersion), " +
                "and contract version ($sdkVersion) must match"
        }
    }
}

tasks.named("check") {
    dependsOn(checkContract)
    dependsOn(checkVersionAlignment)
    dependsOn(verifyAndroidRuntimeProfiles)
}

publishing {
    publications.withType<MavenPublication>().configureEach {
        configureQvacPom(qvacPomName, qvacPomDescription)
        val publication = this
        artifact(tasks.register<Jar>("${name}JavadocJar") {
            // Separate files prevent concurrent publication signing tasks from
            // writing the same .asc output. Dokka generation itself is shared.
            archiveBaseName.set("${project.name}-${publication.name}")
            destinationDirectory.set(layout.buildDirectory.dir("javadocJars/${publication.name}"))
            archiveClassifier.set("javadoc")
            from(tasks.dokkaGeneratePublicationHtml.flatMap { it.outputDirectory })
        })
    }

    repositories {
        maven {
            name = "build"
            url = URI(project.layout.buildDirectory.dir("maven-repository").get().asFile.toURI().toString())
        }
        providers.environmentVariable("MAVEN_REPOSITORY_URL").orNull?.let { repositoryUrl ->
            maven {
                name = "release"
                url = URI(repositoryUrl)
                credentials {
                    username = providers.environmentVariable("MAVEN_USERNAME").orNull
                        ?: providers.environmentVariable("GITHUB_ACTOR").orNull
                    password = providers.environmentVariable("MAVEN_PASSWORD").orNull
                        ?: providers.environmentVariable("GITHUB_TOKEN").orNull
                }
            }
        }
    }
}

tasks.register("publishSdkToBuildRepository") {
    group = "publishing"
    description = "Publishes the KMP client and Android BareKit runtime to build/maven-repository"
    dependsOn("publishAllPublicationsToBuildRepository")
    dependsOn(":android-barekit:publishAllPublicationsToBuildRepository")
}

tasks.register("verifyMavenPublications") {
    group = "verification"
    description = "Checks sources, real API documentation and checksums for every current publication"
    dependsOn("publishSdkToBuildRepository")
    doLast {
        allprojects.forEach { module ->
            val publications = module.extensions.findByType<org.gradle.api.publish.PublishingExtension>()
                ?.publications?.withType<MavenPublication>() ?: return@forEach
            publications.forEach { publication ->
                val repo = module.extensions.getByType<org.gradle.api.publish.PublishingExtension>()
                    .repositories.getByName("build") as org.gradle.api.artifacts.repositories.MavenArtifactRepository
                val directory = File(repo.url).resolve("${publication.groupId.replace('.', '/')}/${publication.artifactId}/${publication.version}")
                val prefix = "${publication.artifactId}-${publication.version}"
                listOf("sources", "javadoc").forEach { classifier ->
                    ZipFile(directory.resolve("$prefix-$classifier.jar")).use { archive ->
                        check(archive.entries().asSequence().any {
                            !it.isDirectory && if (classifier == "javadoc") it.name.endsWith("/index.html")
                            else it.name.endsWith(".kt") || it.name.endsWith(".java")
                        }) { "${publication.artifactId}: empty $classifier artifact" }
                    }
                }
                val primary = publication.artifacts.filterNot { it.extension.endsWith("asc") }.map { artifact ->
                    directory.resolve(prefix + (artifact.classifier?.let { "-$it" } ?: "") + ".${artifact.extension}")
                } + directory.resolve("$prefix.pom")
                primary.forEach { artifact ->
                    check(artifact.isFile && artifact.length() > 0) { "Missing publication file: $artifact" }
                    mapOf("md5" to "MD5", "sha1" to "SHA-1").forEach { (suffix, algorithm) ->
                        val digest = MessageDigest.getInstance(algorithm)
                        artifact.inputStream().use { input ->
                            val buffer = ByteArray(64 * 1024)
                            var count = input.read(buffer)
                            while (count >= 0) { digest.update(buffer, 0, count); count = input.read(buffer) }
                        }
                        val actual = digest.digest().joinToString("") { "%02x".format(it) }
                        check(File("$artifact.$suffix").readText().trim() == actual) { "Invalid checksum: $artifact.$suffix" }
                    }
                }
                logger.lifecycle("Verified Maven publication: ${publication.groupId}:${publication.artifactId}:${publication.version}")
            }
        }
    }
}

tasks.named("publishToMavenCentral") {
    dependsOn(":android-barekit:publishToMavenCentral")
}
tasks.named("publishAndReleaseToMavenCentral") {
    dependsOn(":android-barekit:publishAndReleaseToMavenCentral")
}

if (providers.environmentVariable("MAVEN_REPOSITORY_URL").isPresent) {
    tasks.register("publishSdkToReleaseRepository") {
        group = "publishing"
        description = "Publishes the KMP client and Android BareKit runtime to MAVEN_REPOSITORY_URL"
        dependsOn("publishAllPublicationsToReleaseRepository")
        dependsOn(":android-barekit:publishAllPublicationsToReleaseRepository")
    }
}

kotlin {
    jvm {
        compilerOptions.jvmTarget.set(JvmTarget.JVM_11)
    }
    android {
        namespace = "io.tether.qvac.sdk"
        compileSdk = 36
        minSdk = 29
        withJava()
        withHostTestBuilder {}.configure {}
        compilerOptions.jvmTarget.set(JvmTarget.JVM_11)
    }
    sourceSets {
        commonMain.dependencies {
            api("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.11.0")
            api("org.jetbrains.kotlinx:kotlinx-serialization-json:1.11.0")
        }

        commonTest.dependencies {
            implementation(kotlin("test"))
            implementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.11.0")
        }
    }
}
