plugins {
    application
}

tasks.withType<JavaCompile>().configureEach {
    options.release.set(11)
}

dependencies {
    implementation(project(":probe"))
    implementation("org.eclipse.jgit:org.eclipse.jgit:${property("jgitVersion")}")
    runtimeOnly("org.slf4j:slf4j-nop:2.0.17")
}

application {
    mainClass.set("app.penmoss.gitprobe.Main")
    // A phone app's heap, roughly: the probe must fit in it.
    applicationDefaultJvmArgs = listOf("-Xmx192m")
}
