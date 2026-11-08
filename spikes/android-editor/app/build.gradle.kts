plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "app.penmoss.spike"
    compileSdk = 37

    defaultConfig {
        applicationId = "app.penmoss.spike"
        minSdk = 30
        targetSdk = 37
        versionCode = 1
        versionName = "0.1.0-t2"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    buildTypes {
        // Only the debug build is used (signed with the worker's debug key, D27).
        debug {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
    }

    // Never compress the editor bundle: WebViewAssetLoader streams it from the APK.
    androidResources {
        noCompress += listOf("js", "css", "html")
    }
}

// The web bundle is built by ../build.sh (Vite) and copied into assets; it is
// not committed. Fail early with a clear message instead of shipping a blank app.
tasks.named("preBuild") {
    // A local (not a script-level val) so the action stays configuration-cache safe.
    val editorBundle = layout.projectDirectory.file("src/main/assets/editor/editor.js").asFile
    doFirst {
        if (!editorBundle.exists()) {
            throw GradleException(
                "Editor bundle missing at $editorBundle. Run spikes/android-editor/build.sh " +
                    "(or build web/ and copy web/dist to app/src/main/assets/editor).",
            )
        }
    }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2026.09.00")
    implementation(composeBom)
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.activity:activity-compose:1.13.0")
    implementation("androidx.core:core-ktx:1.19.1")
    implementation("androidx.webkit:webkit:1.18.0")
    implementation("androidx.metrics:metrics-performance:1.0.0")

    androidTestImplementation("androidx.test:core-ktx:1.7.0")
    androidTestImplementation("androidx.test:runner:1.7.0")
    androidTestImplementation("androidx.test:rules:1.7.0")
    androidTestImplementation("androidx.test.ext:junit:1.3.0")
}
