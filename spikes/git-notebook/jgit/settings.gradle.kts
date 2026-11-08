// T50 G0 JGit spike (throwaway, not shipped): a plain-Java probe that clones, fetches, commits
// on the remote head and pushes with JGit, run on the JVM (:jvm:run) and from a throwaway
// Android activity (:app). See ../README.md.
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

rootProject.name = "penmoss-jgit-spike"
include(":probe", ":jvm", ":app")
