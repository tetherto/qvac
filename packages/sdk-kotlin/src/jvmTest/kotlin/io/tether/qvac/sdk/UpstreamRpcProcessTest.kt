package io.tether.qvac.sdk

import java.nio.file.Path
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.collect
import kotlinx.serialization.json.*
import kotlin.test.*

class UpstreamRpcProcessTest {
    @Test
    fun interoperatesWithRealJavaScriptBareRpc() = runBlocking {
        withTimeout(30_000) {
            val transport = JvmBareRpcTransport.connect(
                command = listOf("node", Path.of("test-fixtures/rpc-peer.cjs").toAbsolutePath().toString()),
            )
            val client = QvacClient(transport)
            try {
                assertEquals(9.0, client.heartbeat().number)
                val inputEntered = CompletableDeferred<Unit>()
                val pending = launch {
                    client.duplex(buildJsonObject { put("type", "duplex") }, flow {
                        inputEntered.complete(Unit)
                        awaitCancellation()
                    }).collect()
                }
                inputEntered.await()
                // Real peer barrier: it has accepted the open request.
                assertEquals(9.0, client.heartbeat().number)
                pending.cancelAndJoin()
                // The peer's input must have ended: it ignores a DESTROY in that
                // direction, which would leave its input open indefinitely.
                val closed = client.call(buildJsonObject { put("type", "inputClosed") })
                assertTrue(closed.getValue("closed").jsonPrimitive.boolean)
                // 200 KiB behind a slow collector crosses the pause mark, so the
                // peer is paused and resumed on the way.
                val frames = client.stream(buildJsonObject { put("type", "stream") }).onEach { delay(2) }.toList()
                assertEquals((0 until 200).toList(), frames.map { it.getValue("index").jsonPrimitive.int })
                assertEquals(9.0, client.heartbeat().number)
            } finally { client.close() }
            assertFalse(transport.isWorkerAlive)
        }
    }
}
