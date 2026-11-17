package io.tether.qvac.sdk.jvm

import io.tether.qvac.sdk.QvacClient
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue
import kotlin.time.measureTime
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout

class JvmBareKitTransportTest {
    @Test
    fun startsTheWorkerInThisJvmAndAnswersAHeartbeat() = runBlocking {
        val home = Files.createTempDirectory("qvac-jvm-home")
        try {
            withTimeout(60_000) {
                val transport = JvmBareKitTransport.connect(homeDirectory = home.toString())
                val client = QvacClient(transport)
                try {
                    assertEquals("aio", transport.runtimeProfile.name)
                    assertTrue(client.heartbeat().number >= 0)
                } finally {
                    client.close()
                }
            }
        } finally {
            home.toFile().deleteRecursively()
        }
    }

    @Test
    fun aConnectCancelledWhileStartingStopsItsWorkerAndLeavesTheProcessUsable() = runBlocking {
        val home = Files.createTempDirectory("qvac-jvm-home")
        try {
            withTimeout(180_000) {
                val firstStart = measureTime {
                    JvmBareKitTransport.connect(homeDirectory = home.toString()).close()
                }

                // Halfway through a start the worklet runs and connect() waits for its ready.
                val starting = async { JvmBareKitTransport.connect(homeDirectory = home.toString()) }
                delay(firstStart / 2)
                starting.cancel()
                assertFailsWith<CancellationException> { starting.await() }

                val client = QvacClient(JvmBareKitTransport.connect(homeDirectory = home.toString()))
                try {
                    assertTrue(client.heartbeat().number >= 0)
                } finally {
                    client.close()
                }
            }
        } finally {
            home.toFile().deleteRecursively()
        }
    }
}
