pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
        providers.gradleProperty("qvacMavenRepository").orNull?.let { repositoryPath ->
            maven { url = uri(repositoryPath) }
        }
    }
}

rootProject.name = "qvac-sdk-kotlin"

include(":android-barekit")
include(":android-example")
