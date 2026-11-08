plugins {
    // AGP 9 compiles Kotlin itself (built-in Kotlin); the Kotlin plugins below pin the
    // Kotlin Gradle plugin it uses to the catalog's version.
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.kotlin.jvm) apply false
    alias(libs.plugins.kotlin.compose) apply false
    alias(libs.plugins.kotlin.serialization) apply false
    alias(libs.plugins.ksp) apply false
}
