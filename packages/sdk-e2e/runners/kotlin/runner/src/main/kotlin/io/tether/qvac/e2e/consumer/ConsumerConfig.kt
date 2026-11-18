package io.tether.qvac.e2e.consumer

import io.tether.qvac.e2e.runner.asMap

/**
 * Baked into the APK at build time (`e2e/consumer-config.json`, from MQTT_* and E2E_RUN_ID) and
 * overridable per launch by intent extras, so a local run can retarget an installed app.
 */
data class ConsumerConfig(
    val runId: String,
    val platform: String,
    val mqtt: MqttSettings,
) {
    companion object {
        /** Intent extras a launcher may pass; every one is optional. */
        const val EXTRA_RUN_ID = "runId"
        const val EXTRA_PLATFORM = "platform"
        const val EXTRA_BROKER_URL = "brokerUrl"
        const val EXTRA_MQTT_USERNAME = "mqttUsername"
        const val EXTRA_MQTT_PASSWORD = "mqttPassword"
        const val EXTRA_SESSION_EXPIRY = "mqttSessionExpiry"

        fun resolve(baked: Map<String, Any?>, extras: Map<String, String?>): ConsumerConfig {
            val mqtt = asMap(baked["mqtt"])
            fun extra(key: String) = extras[key]?.takeIf { it.isNotEmpty() }
            val bakedUrl = "${mqtt["protocol"] ?: "ws"}://${mqtt["host"] ?: "localhost"}:${mqtt["port"] ?: 8080}${mqtt["path"] ?: "/mqtt"}"
            val sessionExpiry = extra(EXTRA_SESSION_EXPIRY)?.toLongOrNull()?.takeIf { it > 0 }
                ?: (mqtt["sessionExpiryInterval"] as? Number)?.toLong()
            return ConsumerConfig(
                runId = extra(EXTRA_RUN_ID) ?: baked["runId"]?.toString() ?: "*",
                platform = extra(EXTRA_PLATFORM) ?: baked["platform"]?.toString() ?: "kotlin-android",
                mqtt = MqttSettings(
                    url = extra(EXTRA_BROKER_URL) ?: bakedUrl,
                    username = extra(EXTRA_MQTT_USERNAME) ?: mqtt["username"]?.toString(),
                    password = extra(EXTRA_MQTT_PASSWORD) ?: mqtt["password"]?.toString(),
                    ca = mqtt["ca"]?.toString(),
                    rejectUnauthorized = mqtt["rejectUnauthorized"] != false,
                    sessionExpiryInterval = sessionExpiry,
                ),
            )
        }
    }
}
