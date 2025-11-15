plugins {
    id("org.jetbrains.intellij.platform") version "2.10.4"
    kotlin("jvm") version "2.1.0"
}

group = "com.idea.enhanced"
version = "0.1.0"

repositories {
    mavenCentral()
    intellijPlatform.defaultRepositories()
}

dependencies {
    implementation("com.google.code.gson:gson:2.11.0")
    intellijPlatform {
        intellijIdeaCommunity("2025.1")
        bundledPlugins("com.intellij.java")
    }
}

kotlin {
    jvmToolchain(21)
}

java {
    toolchain {
        languageVersion.set(JavaLanguageVersion.of(21))
    }
}

intellijPlatform {
    pluginConfiguration {
        version.set(project.version.toString())
        ideaVersion {
            sinceBuild.set("251")
            untilBuild.set("")
        }
    }
}

tasks {
    signPlugin {
        enabled = false
    }
    publishPlugin {
        enabled = false
    }
    named("instrumentCode") {
        enabled = false
    }
}
