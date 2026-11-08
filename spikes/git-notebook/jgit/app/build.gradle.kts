plugins {
    id("com.android.application")
}

android {
    namespace = "app.penmoss.gitprobe.android"
    compileSdk = 37

    defaultConfig {
        applicationId = "app.penmoss.gitprobe"
        minSdk = 30
        targetSdk = 37
        versionCode = 1
        versionName = "0.1.0-t50-g0"
    }

    buildTypes {
        // The release build is what the APK size question is about: R8 on, signed with the
        // worker's debug key so Ryan can sideload it (never published).
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    // `jgit661`: the probe on JGit 6.6.1, the last 6.x whose core reads avoid Android 13's
    // InputStream.readNBytes/readAllBytes (minSdk 30). `jgit610`: the probe on 6.10.1, which
    // calls them in util/IO (NoSuchMethodError below API 33). `bare`: the same shell without
    // JGit, for the size difference.
    flavorDimensions += "probe"
    productFlavors {
        create("jgit661") {
            dimension = "probe"
            applicationIdSuffix = ".jgit661"
            versionNameSuffix = "-jgit6.6.1"
            resValue("string", "app_name", "JGit probe 6.6.1")
        }
        create("jgit610") {
            dimension = "probe"
            applicationIdSuffix = ".jgit610"
            versionNameSuffix = "-jgit6.10.1"
            resValue("string", "app_name", "JGit probe 6.10.1")
        }
        create("bare") {
            dimension = "probe"
            applicationIdSuffix = ".bare"
            resValue("string", "app_name", "JGit probe baseline")
        }
    }

    // Both JGit flavors run the same activity.
    sourceSets {
        getByName("jgit661").java.srcDir("src/jgitShared/java")
        getByName("jgit610").java.srcDir("src/jgitShared/java")
    }

    buildFeatures {
        resValues = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    packaging {
        resources {
            excludes += listOf("META-INF/*.SF", "META-INF/*.DSA", "META-INF/*.RSA", "META-INF/LICENSE*", "META-INF/NOTICE*", "about.html", "plugin.properties",
                // commons-codec's phonetic rules (234 KB): JGit never uses them.
                "org/apache/commons/codec/language/**")
        }
    }
}

dependencies {
    "jgit661Implementation"(project(":probe"))
    "jgit661Implementation"("org.eclipse.jgit:org.eclipse.jgit:6.6.1.202309021850-r")
    "jgit610Implementation"(project(":probe"))
    "jgit610Implementation"("org.eclipse.jgit:org.eclipse.jgit:6.10.1.202505221210-r")
}
