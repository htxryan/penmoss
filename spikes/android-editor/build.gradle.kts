plugins {
    // AGP 9 compiles Kotlin itself (built-in Kotlin). Declaring the Compose compiler
    // plugin at 2.4.21 also pins the Kotlin Gradle plugin AGP uses to 2.4.21.
    id("com.android.application") version "9.4.1" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "2.4.21" apply false
}
