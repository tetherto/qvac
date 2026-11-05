package io.tether.qvac.sdk.sample

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.filters.LargeTest
import androidx.test.platform.app.InstrumentationRegistry
import io.tether.qvac.sdk.QvacClient
import io.tether.qvac.sdk.barekit.AndroidServiceTransport
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/** End-to-end Pixel-class device suite for the runnable Feature Lab sample. */
@RunWith(AndroidJUnit4::class)
class FeatureLabInstrumentationTest {
    @Test
    @LargeTest
    fun allSmallModelFeaturesWorkThroughPublicKotlinApi() = runBlocking {
        withTimeout(FULL_SUITE_TIMEOUT_MS) {
            val context = InstrumentationRegistry.getInstrumentation().targetContext
            val transport = AndroidServiceTransport.connect(context)
            val client = QvacClient(transport)
            try {
                val runner = FeatureLabRunner(context, client)
                val arguments = InstrumentationRegistry.getArguments()
                val requestedFeatures = arguments.getString("qvacFeatures")
                    ?.split(',')
                    ?.filter(String::isNotBlank)
                    ?.map(FeatureLabRunner.Feature::valueOf)
                    ?: arguments.getString("qvacFeature")
                        ?.let { listOf(FeatureLabRunner.Feature.valueOf(it)) }
                val results = if (requestedFeatures == null) {
                    runner.runAll { feature, message ->
                        println("QVAC_FEATURE_LAB ${feature.name} $message")
                    }
                } else {
                    requestedFeatures.map { requestedFeature ->
                        runner.run(requestedFeature) { message ->
                            println("QVAC_FEATURE_LAB ${requestedFeature.name} $message")
                        }
                    }
                }
                assertEquals(requestedFeatures?.size ?: FeatureLabRunner.Feature.entries.size, results.size)
                results.forEach { result ->
                    println("QVAC_FEATURE_RESULT ${result.feature.name} ${result.elapsedMs}ms ${result.detail}")
                    assertTrue("${result.feature.label} returned no detail", result.detail.isNotBlank())
                    assertTrue("${result.feature.label} recorded an invalid duration", result.elapsedMs >= 0)
                }
            } finally {
                client.close()
            }
        }
    }

    private companion object {
        const val FULL_SUITE_TIMEOUT_MS = 90 * 60 * 1_000L
    }
}
