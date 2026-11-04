plugins {
    id("com.android.application") version "9.3.0" apply false
    // sdk-kotlin and bare-rpc-kotlin ship Kotlin 2.4 metadata, which the Kotlin 2.2
    // compiler AGP 9.3 bundles cannot read. The version on the classpath is the one
    // AGP's built-in Kotlin compiles with.
    id("org.jetbrains.kotlin.android") version "2.4.20" apply false
}
