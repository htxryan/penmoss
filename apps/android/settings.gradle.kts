// The Penmoss Android app (T32): the Compose shell (app), its sync engine (engine-bridge) and its
// git engine over JGit (engine-git, A10).
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
include(":engine-bridge", ":engine-git", ":app")
