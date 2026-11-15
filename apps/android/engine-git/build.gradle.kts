// Git notebooks on Android (T50 G7, A824, A870): the git engine over JGit, plain Kotlin on the JVM.
// Apart from engine-bridge (architecture review A10) so its slow tests, the cross-engine runs
// under Node among them, keep their own build cache entry: a change elsewhere in the app's
// Kotlin doesn't run them again. Its package stays app.penmoss.engine.git.
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

dependencies {
    // LocalGitApi answers engine-bridge's API client, so its types are part of this module's.
    api(project(":engine-bridge"))
    implementation(libs.jgit)

    testImplementation(testFixtures(project(":engine-bridge")))
    testImplementation(libs.junit)
    testImplementation(libs.coroutines.test)
}

/**
 * What the tests read beyond their classpath (architecture review A8), declared so the build cache
 * never hands back a pass from before a change: the contracts the TypeScript side writes
 * (`git-engine-v1.json`, `invisible-v1.json`), and the engine page and CLI the cross-engine tests
 * run. Their contents are the inputs; their paths are not, so another worktree's checkout hits the
 * same cache entry.
 */
abstract class GitTestArguments : CommandLineArgumentProvider {
    @get:InputDirectory
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val contracts: DirectoryProperty

    @get:InputFiles
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val gitRunner: ConfigurableFileCollection

    @get:Internal
    abstract val runner: RegularFileProperty

    /** Test repositories go under build/, not the shared machine's /tmp (never fill /tmp). */
    @get:Internal
    abstract val scratch: DirectoryProperty

    override fun asArguments(): List<String> = listOf(
        "-Djava.io.tmpdir=${scratch.get().asFile.absolutePath}",
        // The contracts live beside the editor page (apps/android/contract); the tests read the
        // folder through the bridge contract's path, as engine-bridge's do.
        "-Dpenmoss.contract=${contracts.get().file("bridge-v1.json").asFile.absolutePath}",
        // The engine page and the CLI under Node, for the cross-engine tests (T50 G7, A878): built
        // by `task android:editor` from the page's and the CLI's own sources.
        "-Dpenmoss.gitRunner=${runner.get().asFile.absolutePath}",
    )
}

tasks.test {
    val scratch = layout.buildDirectory.dir("test-tmp")
    doFirst { scratch.get().asFile.mkdirs() }
    val root = rootProject.layout.projectDirectory
    jvmArgumentProviders.add(
        objects.newInstance(GitTestArguments::class.java).apply {
            contracts.set(root.dir("contract"))
            // A page changed alone runs the tests again, never "up to date" on the old one.
            gitRunner.from(root.dir("build/git-runner"))
            runner.set(root.file("build/git-runner/git-runner.mjs"))
            this.scratch.set(scratch)
        },
    )
}
