package io.tether.qvac.e2e.consumer

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ConsumerConfigTest {
    private val baked = mapOf(
        "runId" to "android-pr1-2",
        "platform" to "kotlin-android",
        "mqtt" to mapOf(
            "protocol" to "wss",
            "host" to "broker.example",
            "port" to "443",
            "path" to "/mqtt",
            "username" to "ci",
            "password" to "secret",
            "rejectUnauthorized" to true,
            "sessionExpiryInterval" to 7200L,
        ),
    )

    @Test
    fun `the baked config stands without overrides`() {
        val config = ConsumerConfig.resolve(baked, emptyMap())
        assertEquals("android-pr1-2", config.runId)
        assertEquals("wss://broker.example:443/mqtt", config.mqtt.url)
        assertEquals(7200L, config.mqtt.sessionExpiryInterval)
        assertTrue(config.mqtt.secure)
    }

    @Test
    fun `launch extras win, and an empty one is no override`() {
        val config = ConsumerConfig.resolve(
            baked,
            mapOf(
                ConsumerConfig.EXTRA_RUN_ID to "local-1",
                ConsumerConfig.EXTRA_BROKER_URL to "ws://127.0.0.1:8080/",
                ConsumerConfig.EXTRA_MQTT_USERNAME to "",
            ),
        )
        assertEquals("local-1", config.runId)
        assertEquals("ws://127.0.0.1:8080/", config.mqtt.url)
        assertEquals("ci", config.mqtt.username)
        assertFalse(config.mqtt.secure)
    }

    @Test
    fun `defaults for an unconfigured build`() {
        val config = ConsumerConfig.resolve(emptyMap(), emptyMap())
        assertEquals("*", config.runId)
        assertEquals("kotlin-android", config.platform)
        assertEquals("ws://localhost:8080/mqtt", config.mqtt.url)
        assertNull(config.mqtt.sessionExpiryInterval)
    }
}

class PlatformsTest {
    @Test
    fun `segment matching widens over the OS only`() {
        assertTrue(Platforms.matches(listOf("kotlin-android"), "kotlin-android"))
        assertTrue(Platforms.matches(listOf("kotlin"), "kotlin-android"))
        assertFalse(Platforms.matches(listOf("mobile"), "kotlin-android"))
        assertFalse(Platforms.matches(listOf("kotlin-android-x"), "kotlin-android"))
    }

    @Test
    fun `only this platform's reasons are reported`() {
        val definition = mapOf(
            "skip" to mapOf(
                "reason" to "all of it",
                "platforms" to listOf("mobile", "kotlin-android"),
                "reasons" to listOf(
                    mapOf("platforms" to listOf("mobile"), "reason" to "mobile only"),
                    mapOf("platforms" to listOf("kotlin-android"), "reason" to "kotlin too"),
                ),
            ),
        )
        assertEquals("kotlin too", Platforms.skipReason(definition, "kotlin-android"))
        assertNull(Platforms.skipReason(definition, "desktop-macos"))
    }
}
