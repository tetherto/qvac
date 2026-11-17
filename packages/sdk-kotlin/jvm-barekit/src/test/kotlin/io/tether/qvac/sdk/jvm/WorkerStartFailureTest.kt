package io.tether.qvac.sdk.jvm

import io.tether.qvac.sdk.QvacWorkerStartException
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertSame
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import to.holepunch.bare.stow.host.WorkerError

class WorkerStartFailureTest {
    @Test
    fun aStartThatEndsWithoutAReportedExitBlocksLaterStarts() = runBlocking {
        for (code in listOf("WORKER_TIMEOUT", "WORKER_CLOSED", "WORKER_KILLED", "TRANSPORT_ERROR")) {
            assertEquals(1, uncleanStopsAfterAStartFailingWith(WorkerError("failed", code = code)), code)
        }
    }

    @Test
    fun aStartThatEndsWithAReportedExitLeavesTheProcessUsable() = runBlocking {
        for (code in listOf("WORKER_EXITED", "WORKER_ERROR")) {
            assertEquals(0, uncleanStopsAfterAStartFailingWith(WorkerError("failed", code = code)), code)
        }
    }

    @Test
    fun aStartThatFailsBeforeTheWorkletRunsLeavesTheProcessUsable() = runBlocking {
        assertEquals(0, uncleanStopsAfterAStartFailingWith(IllegalStateException("no bundle")))
    }

    @Test
    fun aCancelledStartIsRethrownAndLeavesTheProcessUsable() = runBlocking {
        val cancelled = CancellationException("cancelled")
        var uncleanStops = 0
        val thrown = assertFailsWith<CancellationException> {
            JvmBareKitTransport.startWorker(onUncleanStop = { uncleanStops++ }) { throw cancelled }
        }
        assertSame(cancelled, thrown)
        assertEquals(0, uncleanStops)
    }

    private suspend fun uncleanStopsAfterAStartFailingWith(error: Throwable): Int {
        var uncleanStops = 0
        val thrown = assertFailsWith<QvacWorkerStartException> {
            JvmBareKitTransport.startWorker(onUncleanStop = { uncleanStops++ }) { throw error }
        }
        assertSame(error, thrown.cause)
        return uncleanStops
    }
}
