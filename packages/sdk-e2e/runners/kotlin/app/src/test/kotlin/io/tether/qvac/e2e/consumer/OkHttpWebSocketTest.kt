package io.tether.qvac.e2e.consumer

import okhttp3.OkHttpClient
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import okio.ByteString
import okio.ByteString.Companion.toByteString
import java.io.IOException
import java.net.URI
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class OkHttpWebSocketTest {
    private val server = MockWebServer()
    private val received = LinkedBlockingQueue<ByteArray>()
    private val opened = LinkedBlockingQueue<WebSocket>()

    private fun serve(): URI {
        server.enqueue(
            MockResponse().withWebSocketUpgrade(
                object : WebSocketListener() {
                    override fun onOpen(webSocket: WebSocket, response: Response) {
                        opened.put(webSocket)
                    }

                    override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                        received.put(bytes.toByteArray())
                    }
                },
            ),
        )
        server.start()
        return URI(OkHttpWebSocket.register("ws://${server.hostName}:${server.port}/mqtt", OkHttpClient()))
    }

    @AfterTest
    fun stop() = server.shutdown()

    @Test
    fun `a ws broker is routed to the OkHttp scheme, and Paho finds the module for it`() {
        val routed = OkHttpWebSocket.register("wss://broker.example:443/mqtt", OkHttpClient())
        assertEquals("okwss://broker.example:443/mqtt", routed)
        // The client constructors validate the URI against the registered factories (ServiceLoader).
        org.eclipse.paho.client.mqttv3.MqttAsyncClient(routed, "v3", org.eclipse.paho.client.mqttv3.persist.MemoryPersistence())
        org.eclipse.paho.mqttv5.client.MqttAsyncClient(routed, "v5", org.eclipse.paho.mqttv5.client.persist.MemoryPersistence())
    }

    @Test
    fun `each flush is one binary message and replies read back in order`() {
        val uri = serve()
        val stream = OkHttpWebSocketStream(uri, OkHttpWebSocket.clientFor(uri), 5_000)
        stream.start()
        assertEquals("mqtt", server.takeRequest().getHeader("Sec-WebSocket-Protocol"))

        stream.output.write(byteArrayOf(0x10, 0x02))
        stream.output.write(byteArrayOf(0x00, 0x04))
        stream.output.flush()
        assertContentEquals(byteArrayOf(0x10, 0x02, 0x00, 0x04), received.poll(5, TimeUnit.SECONDS))

        val peer = opened.poll(5, TimeUnit.SECONDS)!!
        peer.send(byteArrayOf(0x20, 0x02).toByteString())
        peer.send(byteArrayOf(0x00, 0x00).toByteString())
        val reply = ByteArray(4)
        var read = 0
        while (read < 4) read += stream.input.read(reply, read, 4 - read)
        assertContentEquals(byteArrayOf(0x20, 0x02, 0x00, 0x00), reply)
        stream.stop()
        peer.close(1000, null)
    }

    @Test
    fun `an upgrade that never answers is cancelled, not left behind`() {
        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE))
        server.start()
        val uri = URI(OkHttpWebSocket.register("ws://${server.hostName}:${server.port}/mqtt", OkHttpClient()))
        val client = OkHttpWebSocket.clientFor(uri)
        val stream = OkHttpWebSocketStream(uri, client, 500)
        assertFailsWith<IOException> { stream.start() }
        val deadline = System.currentTimeMillis() + 5_000
        while (client.dispatcher.runningCallsCount() > 0 && System.currentTimeMillis() < deadline) Thread.sleep(50)
        assertEquals(0, client.dispatcher.runningCallsCount())
    }

    @Test
    fun `a connection that fails after it opened reaches Paho as an error`() {
        val uri = serve()
        val stream = OkHttpWebSocketStream(uri, OkHttpWebSocket.clientFor(uri), 5_000)
        stream.start()
        opened.poll(5, TimeUnit.SECONDS)!!
        // The peer's socket goes away without a close frame.
        server.shutdown()
        assertFailsWith<IOException> { stream.input.read() }
    }

    @Test
    fun `a closed connection ends the input, which is how Paho learns it is gone`() {
        val uri = serve()
        val stream = OkHttpWebSocketStream(uri, OkHttpWebSocket.clientFor(uri), 5_000)
        stream.start()
        opened.poll(5, TimeUnit.SECONDS)!!.close(1000, "bye")
        assertEquals(-1, stream.input.read())
        assertTrue(stream.input.read(ByteArray(4), 0, 4) == -1)
    }
}
