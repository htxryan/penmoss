plugins {
    `java-library`
}

// Android's Java 11 surface: the probe uses nothing newer.
tasks.withType<JavaCompile>().configureEach {
    options.release.set(11)
}

dependencies {
    // Compiled against the oldest JGit it supports (shallow clone needs 6.3+); each consumer
    // (the JVM runner, each APK flavor) brings the JGit it tests.
    compileOnly("org.eclipse.jgit:org.eclipse.jgit:6.6.1.202309021850-r")
}
