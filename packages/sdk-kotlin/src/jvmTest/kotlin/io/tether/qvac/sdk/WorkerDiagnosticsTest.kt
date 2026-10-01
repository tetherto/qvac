package io.tether.qvac.sdk

import kotlinx.coroutines.*
import kotlin.test.*

class WorkerDiagnosticsTest {
    @Test fun logsWithoutNewlinesRemainBoundedAndKeepTheTail(): Unit = runBlocking {
        val input = ("x".repeat(100_000) + "THE_END").byteInputStream()
        val diagnostics = WorkerDiagnostics(input)
        withTimeout(5_000) {
            while (!diagnostics.text.endsWith("THE_END")) delay(10)
        }
        assertEquals(16_384, diagnostics.text.length)
    }
}
