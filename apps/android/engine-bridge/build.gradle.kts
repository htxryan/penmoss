// The sync engine and editor bridge (T32): plain Kotlin on the JVM, so its contract and
// sync tests run without Android. It moves Yjs updates as opaque base64 and never reads
// them (A11, A280); the app module supplies storage (Room) and the WebView.
plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.kotlin.serialization)
    // InMemorySyncStore, the sync store engine-git's cross-engine tests also run on (A10).
    `java-test-fixtures`
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

// The Characters a line symbol is chosen from (A1569): the web's own file, written by
// scripts/characters.mjs, with the notice its data's licences ask for beside it.
val characterResources = tasks.register<Copy>("characterResources") {
    from(rootProject.file("../../packages/core/data/characters.json"))
    from(rootProject.file("../../packages/core/data/NOTICE.txt")) { rename { "characters-NOTICE.txt" } }
    into(layout.buildDirectory.dir("generated/character-resources"))
}

sourceSets {
    main {
        resources.srcDir(contractResources)
        resources.srcDir(characterResources)
    }
}

dependencies {
    api(libs.coroutines.core)
    api(libs.serialization.json)
    api(libs.okhttp)

    testImplementation(libs.junit)
    testImplementation(libs.coroutines.test)
    testImplementation(libs.okhttp.mockwebserver)
}

/**
 * What the tests read beyond their classpath (architecture review A8), declared so the build cache
 * never hands back a pass from before a change: the contracts the TypeScript side writes and every
 * Kotlin source `NoYjsInKotlinTest` scans (the app's and engine-git's too). Their contents are the
 * inputs; their paths are not, so another worktree's checkout hits the same cache entry. The engine
 * page and CLI the cross-engine tests run are engine-git's inputs (A10).
 */
abstract class EngineTestArguments : CommandLineArgumentProvider {
    @get:InputDirectory
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val contracts: DirectoryProperty

    @get:InputFiles
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val kotlinSources: ConfigurableFileCollection

    /** Where the scanned sources are found: their contents are the input, not this path. */
    @get:Internal
    abstract val androidRoot: DirectoryProperty

    /** Test repositories go under build/, not the shared machine's /tmp (never fill /tmp). */
    @get:Internal
    abstract val scratch: DirectoryProperty

    override fun asArguments(): List<String> = listOf(
        "-Djava.io.tmpdir=${scratch.get().asFile.absolutePath}",
        // The bridge contract lives beside the editor page (apps/android/contract).
        "-Dpenmoss.contract=${contracts.get().file("bridge-v1.json").asFile.absolutePath}",
        // The Kotlin sources the "never reads Yjs" check scans.
        "-Dpenmoss.androidRoot=${androidRoot.get().asFile.absolutePath}",
    )
}

tasks.test {
    val scratch = layout.buildDirectory.dir("test-tmp")
    doFirst { scratch.get().asFile.mkdirs() }
    val root = rootProject.layout.projectDirectory
    jvmArgumentProviders.add(
        objects.newInstance(EngineTestArguments::class.java).apply {
            contracts.set(root.dir("contract"))
            kotlinSources.from(
                root.asFileTree.matching {
                    include("**/*.kt", "**/*.kts")
                    exclude("**/build/**", "**/.gradle/**", "**/node_modules/**")
                },
            )
            androidRoot.set(root)
            this.scratch.set(scratch)
        },
    )
}
