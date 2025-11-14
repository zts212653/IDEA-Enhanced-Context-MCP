plugins {
    id("org.jetbrains.intellij") version "1.17.4"
    kotlin("jvm") version "1.9.25"
}

group = "com.idea.enhanced"
version = "0.1.0"

repositories {
    mavenCentral()
}

dependencies {
    implementation("com.google.code.gson:gson:2.11.0")
}

kotlin {
    jvmToolchain(17)
}

intellij {
    version.set("2025.1")
    type.set("IC")
    plugins.set(listOf("java"))
}

tasks {
    patchPluginXml {
        sinceBuild.set("251")
        untilBuild.set("")
    }
    signPlugin {
        enabled = false
    }
    publishPlugin {
        enabled = false
    }
}
