// The sync engine and editor bridge (T32): plain Kotlin on the JVM, so its contract and
// sync tests run without Android. It moves Yjs updates as opaque base64 and never reads
// them (A11, A280); the app module supplies storage (Room) and the WebView.
plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.kotlin.serialization)
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

// The built-in themes (T40 P1, A412) ship with the app: contract/themes-v1.json, made from
// @penmoss/ui and checked by the editor page's vitest, is a resource of this module, and so is
// the web's command registry, contract/shortcuts-v1.json (T40 P9, A492). Copied on their own
// into a generated folder, so no other resource of the module is filtered.
val contractResources = tasks.register<Copy>("contractResources") {
    from(rootProject.file("contract/themes-v1.json"))
    from(rootProject.file("contract/shortcuts-v1.json"))
    into(layout.buildDirectory.dir("generated/contract-resources"))
}

sourceSets {
    main {
        resources.srcDir(contractResources)
    }
}

dependencies {
    api(libs.coroutines.core)
    api(libs.serialization.json)
    api(libs.okhttp)
    // Git notebooks on Android (T50 G7, A824, A870).
    implementation(libs.jgit)

    testImplementation(libs.junit)
    testImplementation(libs.coroutines.test)
    testImplementation(libs.okhttp.mockwebserver)
}

tasks.test {
    // Test repositories go under build/, not the shared machine's /tmp (LANE-RULES: never fill /tmp).
    val scratch = layout.buildDirectory.dir("test-tmp").get().asFile
    doFirst { scratch.mkdirs() }
    systemProperty("java.io.tmpdir", scratch.absolutePath)
    // The bridge contract lives beside the editor page (apps/android/contract).
    systemProperty("penmoss.contract", rootProject.file("contract/bridge-v1.json").absolutePath)
    // The Kotlin sources the "never reads Yjs" check scans.
    systemProperty("penmoss.androidRoot", rootProject.projectDir.absolutePath)
    // The engine page and the CLI under Node, for the cross-engine tests (T50 G7, A878): built by
    // `task android:editor` from the page's and the CLI's own sources.
    systemProperty("penmoss.gitRunner", rootProject.file("build/git-runner/git-runner.mjs").absolutePath)
    // An input too: a page changed alone runs the tests again, never "up to date" on the old one.
    inputs.files(rootProject.file("build/git-runner")).withPropertyName("gitRunner")
}
