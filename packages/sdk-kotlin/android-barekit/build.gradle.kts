import org.gradle.api.publish.maven.MavenPublication
import java.net.URI

plugins {
    id("com.android.library")
    id("maven-publish")
    id("signing")
    id("org.jetbrains.dokka")
    id("com.vanniktech.maven.publish.base")
}

group = "io.tether"
version = rootProject.version

mavenPublishing {
    publishToMavenCentral(automaticRelease = false,
        validateDeployment = com.vanniktech.maven.publish.DeploymentValidation.PUBLISHED)
}
dokka {
    // All runtime profiles expose the same Kotlin sources; document them once.
    dokkaSourceSets.configureEach { suppress.set(name != "aioRelease") }
}

val runtimeRoot = rootProject.layout.projectDirectory
val bareKitRoot = runtimeRoot.dir("node_modules/react-native-bare-kit/android/libs/bare-kit")
data class RuntimeProfile(val name: String, val configFile: String, val artifactId: String, val pomName: String)
val runtimeProfiles = listOf(
    RuntimeProfile("aio", "qvac.config.json", "qvac-sdk-android", "QVAC SDK for Android"),
    RuntimeProfile("assistant", "qvac.config.assistant.json", "qvac-sdk-android-assistant", "QVAC Android Assistant SDK"),
    RuntimeProfile("llm", "qvac.config.llm.json", "qvac-sdk-android-llm", "QVAC Android LLM SDK"),
    RuntimeProfile("speech", "qvac.config.speech.json", "qvac-sdk-android-speech", "QVAC Android Speech SDK"),
    RuntimeProfile("vision", "qvac.config.vision.json", "qvac-sdk-android-vision", "QVAC Android Vision SDK"),
    RuntimeProfile("media", "qvac.config.media.json", "qvac-sdk-android-media", "QVAC Android Media SDK"),
    RuntimeProfile("robotics", "qvac.config.robotics.json", "qvac-sdk-android-robotics", "QVAC Android Robotics SDK"),
)

android {
    namespace = "io.tether.qvac.sdk.barekit"
    compileSdk = 36
    ndkVersion = "29.0.14206865"

    buildFeatures {
        aidl = true
    }

    flavorDimensions += "qvacProfile"
    productFlavors {
        runtimeProfiles.forEach { profile ->
            create(profile.name) { dimension = "qvacProfile" }
        }
    }

    publishing {
        runtimeProfiles.forEach { profile ->
            singleVariant("${profile.name}Release") {
                withSourcesJar()
            }
        }
    }

    defaultConfig {
        minSdk = 29
        consumerProguardFiles("consumer-rules.pro")

        ndk {
            abiFilters += "arm64-v8a"
        }

        externalNativeBuild {
            cmake {
                arguments += "-DANDROID_STL=c++_shared"
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    sourceSets {
        getByName("main") {
            jniLibs.directories.add(bareKitRoot.dir("jni").asFile.absolutePath)
        }
        runtimeProfiles.forEach { profile ->
            getByName(profile.name) {
                val generatedRuntime = layout.buildDirectory.dir("generated/qvac/${profile.name}").get()
                assets.directories.add(generatedRuntime.dir("assets").asFile.absolutePath)
                jniLibs.directories.add(generatedRuntime.dir("addons").asFile.absolutePath)
            }
        }
    }

    packaging {
        jniLibs {
            excludes += setOf(
                "**/armeabi-v7a/**",
                "**/x86/**",
                "**/x86_64/**",
                "lib/armeabi-v7a/**",
                "lib/x86/**",
                "lib/x86_64/**",
            )
        }
    }

    externalNativeBuild {
        cmake {
            path = file("src/main/cpp/CMakeLists.txt")
        }
    }
}

val npmCi by tasks.registering(Exec::class) {
    description = "Install pinned QVAC Android runtime dependencies"
    workingDir(runtimeRoot)
    // `npm ci` installs the committed lockfile exactly, so two builds of the
    // same tag resolve the same @qvac/* versions.
    commandLine("npm", "ci", "--ignore-scripts", "--legacy-peer-deps")
    inputs.files(
        runtimeRoot.file("package.json"),
        runtimeRoot.file("package-lock.json"),
    )
    outputs.dir(runtimeRoot.dir("node_modules"))
}

val prepareRuntimeTasks = runtimeProfiles.associateWith { profile ->
    tasks.register<Exec>("prepare${profile.name.replaceFirstChar(Char::uppercase)}QvacAndroidRuntime") {
        description = "Bundle the ${profile.name} QVAC worker and link Android addons"
        dependsOn(npmCi)
        workingDir(runtimeRoot)
        commandLine("node", "scripts/prepare-android-runtime.mjs")
        environment("QVAC_KOTLIN_CONFIG", runtimeRoot.file(profile.configFile).asFile.absolutePath)
        environment("QVAC_KOTLIN_PROFILE", profile.name)
        environment(
            "QVAC_KOTLIN_GENERATED_ROOT",
            layout.buildDirectory.dir("generated/qvac/${profile.name}").get().asFile.absolutePath,
        )
        inputs.files(
            runtimeRoot.file("package.json"),
            runtimeRoot.file("scripts/prepare-android-runtime.mjs"),
            runtimeRoot.file("../sdk/LICENSE"),
            runtimeRoot.file("../sdk/NOTICE"),
        )
        inputs.file(runtimeRoot.file(profile.configFile))
        outputs.dir(layout.buildDirectory.dir("generated/qvac/${profile.name}"))
    }
}

tasks.configureEach {
    runtimeProfiles.forEach { profile ->
        val capitalized = profile.name.replaceFirstChar(Char::uppercase)
        if (name.startsWith("merge$capitalized") || name.startsWith("package$capitalized")) {
            dependsOn(prepareRuntimeTasks.getValue(profile))
        }
    }
}

dependencies {
    api(project(":"))
    api(files(bareKitRoot.file("classes.jar")).builtBy(npmCi))
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.11.0")
}

afterEvaluate {
    publishing {
        publications {
            runtimeProfiles.forEach { profile ->
                create<MavenPublication>(profile.name) {
                    artifactId = profile.artifactId
                    from(components["${profile.name}Release"])
                    artifact(tasks.register<Jar>("${profile.name}JavadocJar") {
                        archiveBaseName.set(profile.artifactId)
                        archiveClassifier.set("javadoc")
                        from(tasks.dokkaGeneratePublicationHtml.flatMap { it.outputDirectory })
                    })
                    pom {
                        name.set(profile.pomName)
                        description.set("Self-contained Android arm64 QVAC ${profile.name} runtime and Kotlin client")
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
            }
        }
        repositories {
            maven {
                name = "build"
                url = URI(rootProject.layout.buildDirectory.dir("maven-repository").get().asFile.toURI().toString())
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
}

val signingKey = providers.environmentVariable("MAVEN_SIGNING_KEY")
val signingPassword = providers.environmentVariable("MAVEN_SIGNING_PASSWORD")
afterEvaluate {
    signing {
        if (signingKey.isPresent) {
            useInMemoryPgpKeys(signingKey.get(), signingPassword.orNull)
            sign(publishing.publications)
        }
    }
}
