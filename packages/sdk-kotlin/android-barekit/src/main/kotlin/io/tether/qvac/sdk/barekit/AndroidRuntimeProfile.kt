package io.tether.qvac.sdk.barekit

import android.content.Context
import io.tether.qvac.sdk.QvacRuntimeProfile
import kotlinx.serialization.json.Json

internal object AndroidRuntimeProfile {
    private val json = Json { ignoreUnknownKeys = true }

    fun load(context: Context, assetName: String = "qvac/profile.json"): QvacRuntimeProfile {
        return context.assets.open(assetName).bufferedReader().use { reader ->
            json.decodeFromString<QvacRuntimeProfile>(reader.readText())
        }
    }
}
