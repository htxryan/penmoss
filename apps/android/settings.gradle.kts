// The Penmoss Android app (T32): the Compose shell (app) and its sync engine (engine-bridge).
// See docs/android.md.
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
    }
}

rootProject.name = "penmoss-android"
include(":engine-bridge", ":app")
