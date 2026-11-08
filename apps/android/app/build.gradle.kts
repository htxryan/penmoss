import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.ksp)
}

/**
 * Release signing (T32, D21) comes from outside the repository, never from git:
 * environment variables (CI, or a shell that loaded them), else
 * ~/.config/penmoss/android-signing.properties, else this project's
 * local.properties (git-ignored). Keys: PENMOSS_KEYSTORE (path to the .jks),
 * PENMOSS_KEYSTORE_PASSWORD, PENMOSS_KEY_ALIAS, PENMOSS_KEY_PASSWORD.
 * See docs/android.md.
 */
val signing: Map<String, String> = run {
    val keys = listOf("PENMOSS_KEYSTORE", "PENMOSS_KEYSTORE_PASSWORD", "PENMOSS_KEY_ALIAS", "PENMOSS_KEY_PASSWORD")
    val files = listOf(
        File(System.getProperty("user.home"), ".config/penmoss/android-signing.properties"),
        rootProject.file("local.properties"),
    )
    val fromFiles = Properties().apply {
        files.filter { it.isFile }.reversed().forEach { file -> file.inputStream().use { load(it) } }
    }
    keys.mapNotNull { key ->
        (providers.environmentVariable(key).orNull ?: fromFiles.getProperty(key))?.takeIf { it.isNotBlank() }?.let { key to it }
    }.toMap()
}
val canSignRelease = signing.size == 4

/**
 * The public APK (P8, A1187): the release build type of app.penmoss, signed with the sideload
 * key (A400) instead of Play's upload key, so every APK from GitHub Releases installs over the
 * last. `task android:apk:sideload` sets PENMOSS_RELEASE_SIGNING=sideload; CI decodes the key
 * from the android-sideload environment into PENMOSS_SIDELOAD_KEYSTORE (with
 * PENMOSS_SIDELOAD_PASSWORD). Debug builds always keep the machine's own debug key, and the
 * Play bundle always the upload key.
 */
val sideloadKeystore = providers.environmentVariable("PENMOSS_SIDELOAD_KEYSTORE").orNull?.takeIf { it.isNotBlank() }
val sideloadPassword = providers.environmentVariable("PENMOSS_SIDELOAD_PASSWORD").orNull?.takeIf { it.isNotBlank() }
val canSignSideload = sideloadKeystore != null && sideloadPassword != null
val releaseForSideload = providers.environmentVariable("PENMOSS_RELEASE_SIGNING").orNull == "sideload"

/**
 * Play needs a higher versionCode for every upload: PENMOSS_VERSION_CODE, or 1 for local builds.
 * The public APK's is the CI build number (P8). PENMOSS_VERSION_NAME is the version people see.
 */
val versionCodeFromEnv = providers.environmentVariable("PENMOSS_VERSION_CODE").orNull?.toIntOrNull() ?: 1
val versionNameFromEnv = providers.environmentVariable("PENMOSS_VERSION_NAME").orNull?.takeIf { it.isNotBlank() } ?: "0.1.0"

android {
    namespace = "app.penmoss"
    compileSdk = 37

    defaultConfig {
        applicationId = "app.penmoss"
        // Android 17 and later only (A835, Ryan 29 Oct 2026).
        minSdk = 37
        targetSdk = 37
        versionCode = versionCodeFromEnv
        versionName = versionNameFromEnv
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        val local = Properties().apply {
            rootProject.file("local.properties").takeIf { it.isFile }?.inputStream()?.use { load(it) }
        }
        // Send feedback's GitHub hosts (A1010): a debug build may point at a fake GitHub with
        // penmoss.githubApi / penmoss.githubUploads in local.properties; a release build never does.
        buildConfigField("String", "GITHUB_API", "\"${local.getProperty("penmoss.githubApi") ?: ""}\"")
        buildConfigField("String", "GITHUB_UPLOADS", "\"${local.getProperty("penmoss.githubUploads") ?: ""}\"")
    }

    signingConfigs {
        if (canSignSideload) {
            create("sideload") {
                storeFile = file(sideloadKeystore!!)
                storePassword = sideloadPassword
                keyAlias = "penmoss-sideload"
                keyPassword = sideloadPassword
            }
        }
        if (canSignRelease) {
            create("release") {
                storeFile = file(signing.getValue("PENMOSS_KEYSTORE"))
                storePassword = signing.getValue("PENMOSS_KEYSTORE_PASSWORD")
                keyAlias = signing.getValue("PENMOSS_KEY_ALIAS")
                keyPassword = signing.getValue("PENMOSS_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        debug {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
        }
        release {
            buildConfigField("String", "GITHUB_API", "\"\"")
            buildConfigField("String", "GITHUB_UPLOADS", "\"\"")
            // Not minified until a release build has run on the Pixel (A285).
            isMinifyEnabled = false
            // The public APK with the sideload key (P8), else Play's upload key.
            if (releaseForSideload) {
                if (canSignSideload) signingConfig = signingConfigs.getByName("sideload")
            } else if (canSignRelease) {
                signingConfig = signingConfigs.getByName("release")
            }
            // The bundle carries its native libraries' symbols for Play's crash reports (A691).
            ndk { debugSymbolLevel = "SYMBOL_TABLE" }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    // Never compress the editor page: WebViewAssetLoader streams it from the APK.
    androidResources {
        noCompress += listOf("js", "css", "html")
    }

    testOptions {
        unitTests {
            isIncludeAndroidResources = true
            all { test ->
                test.maxHeapSize = "1g"
                test.systemProperty("robolectric.logging.enabled", "false")
                // Robolectric's Android 16 sets up shared memory through JDK internals.
                test.jvmArgs("--add-opens=java.base/jdk.internal.access=ALL-UNNAMED", "--add-exports=java.base/jdk.internal.access=ALL-UNNAMED")
            }
        }
    }

    packaging {
        resources.excludes += setOf("META-INF/LICENSE*", "META-INF/NOTICE*", "META-INF/*.kotlin_module")
    }
}

ksp {
    arg("room.schemaLocation", "$projectDir/schemas")
}

/**
 * Every build type's merged manifest, handed to the unit tests (A596), so `AppLinkManifestTest`
 * checks what each build really declares: its package and its own App Link path.
 */
abstract class MergedManifestArgument : CommandLineArgumentProvider {
    @get:InputFile
    @get:PathSensitive(PathSensitivity.NONE)
    abstract val manifest: RegularFileProperty

    @get:Input
    abstract val variant: Property<String>

    override fun asArguments(): List<String> =
        listOf("-Dpenmoss.mergedManifest.${variant.get()}=${manifest.get().asFile.absolutePath}")
}

androidComponents {
    onVariants { variant ->
        val argument = objects.newInstance(MergedManifestArgument::class.java).apply {
            manifest.set(variant.artifacts.get(com.android.build.api.artifact.SingleArtifact.MERGED_MANIFEST))
            this.variant.set(variant.name)
        }
        tasks.withType<Test>().configureEach { jvmArgumentProviders.add(argument) }
    }
}

// The editor page is built by `task android:editor` (Vite) into assets/editor and is not
// committed. Fail early with a clear message instead of shipping a blank editor.
// The graph page (T40 P7, A478) and the git engine page (T50 G7, A872) are built beside it.
val editorBundle = layout.projectDirectory.file("src/main/assets/editor/editor.js")
val graphBundle = layout.projectDirectory.file("src/main/assets/editor/graph.js")
val gitBundle = layout.projectDirectory.file("src/main/assets/editor/git.js")
tasks.named("preBuild") {
    val bundles = listOf(editorBundle.asFile, graphBundle.asFile, gitBundle.asFile)
    doFirst {
        for (bundle in bundles) {
            if (!bundle.exists()) {
                throw GradleException("Editor page missing at $bundle. Run `task android:editor` first.")
            }
        }
    }
}

// A release must be signed; say how instead of producing an unsigned bundle or APK. The Play
// bundle is only ever signed with the upload key, never the sideload key (P8, A595).
tasks.matching { it.name == "bundleRelease" || it.name == "assembleRelease" }.configureEach {
    val bundle = name == "bundleRelease"
    val sideload = releaseForSideload
    val signed = if (sideload) canSignSideload else canSignRelease
    doFirst {
        if (sideload && bundle) {
            throw GradleException("The Play bundle is signed with the upload key: unset PENMOSS_RELEASE_SIGNING.")
        }
        if (!signed && sideload) {
            throw GradleException(
                "Sideload signing is not configured. Set PENMOSS_SIDELOAD_KEYSTORE and " +
                    "PENMOSS_SIDELOAD_PASSWORD (see docs/android.md).",
            )
        }
        if (!signed) {
            throw GradleException(
                "Release signing is not configured. Set PENMOSS_KEYSTORE, PENMOSS_KEYSTORE_PASSWORD, " +
                    "PENMOSS_KEY_ALIAS and PENMOSS_KEY_PASSWORD (see docs/android.md).",
            )
        }
    }
}

dependencies {
    implementation(project(":engine-bridge"))

    implementation(platform(libs.compose.bom))
    implementation(libs.compose.foundation)
    implementation(libs.compose.material3)
    implementation(libs.compose.material.icons)
    implementation(libs.compose.ui)
    implementation(libs.activity.compose)
    implementation(libs.core.ktx)
    implementation(libs.lifecycle.runtime.compose)
    implementation(libs.lifecycle.viewmodel.compose)
    implementation(libs.lifecycle.process)
    implementation(libs.navigation.compose)
    implementation(libs.room.runtime)
    implementation(libs.room.ktx)
    ksp(libs.room.compiler)
    implementation(libs.browser)
    implementation(libs.webkit)
    implementation(libs.coroutines.android)
    implementation(libs.work.runtime)

    testImplementation(libs.junit)
    testImplementation(libs.robolectric)
    testImplementation(libs.androidx.test.core)
    testImplementation(libs.androidx.test.junit)
    testImplementation(libs.coroutines.test)
    testImplementation(libs.okhttp.mockwebserver)
    testImplementation(libs.work.testing)
    testImplementation(platform(libs.compose.bom))
    testImplementation(libs.compose.ui.test.junit4)
    testImplementation(libs.espresso.core)
    debugImplementation(libs.compose.ui.test.manifest)

    androidTestImplementation(platform(libs.compose.bom))
    androidTestImplementation(libs.compose.ui.test.junit4)
    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(libs.androidx.test.junit)
    androidTestImplementation(libs.metrics.performance)
}
