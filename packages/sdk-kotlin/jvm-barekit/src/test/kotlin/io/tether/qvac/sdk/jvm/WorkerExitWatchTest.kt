package io.tether.qvac.sdk.jvm

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.consumeAsFlow
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import to.holepunch.bare.stow.host.Frame
import to.holepunch.bare.stow.host.Ipc

class WorkerExitWatchTest {
    @Test
    fun aWorkerKilledWithoutAClosedTransportBlocksLaterStarts() = runBlocking {
        val data = Channel<ByteArray>(Channel.UNLIMITED)
        val ipc = Ipc(data.consumeAsFlow(), write = {}, kill = {})
        var unclean = false
        val watch = JvmBareKitTransport.watchExit(ipc) { unclean = true }

        // The worklet ends without an exit frame, and its transport is never closed.
        data.close()
        ipc.exited(null, signal = 9)

        withTimeout(5_000) { watch.join() }
        assertTrue(unclean)
    }

    @Test
    fun aWorkerThatReportsItsExitLeavesTheProcessUsable() = runBlocking {
        val data = Channel<ByteArray>(Channel.UNLIMITED)
        val ipc = Ipc(data.consumeAsFlow(), write = {}, kill = {})
        var unclean = false
        val watch = JvmBareKitTransport.watchExit(ipc) { unclean = true }

        data.send(Frame.control("exit", mapOf("code" to 0)))
        data.close()
        ipc.exited(0)

        withTimeout(5_000) { watch.join() }
        assertFalse(unclean)
    }
}
