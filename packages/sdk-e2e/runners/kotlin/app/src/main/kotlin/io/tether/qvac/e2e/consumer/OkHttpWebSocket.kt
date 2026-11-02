package io.tether.qvac.e2e.consumer

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.URI
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * MQTT over WebSocket for Paho, carried by OkHttp.
 *
 * Paho 1.2.5's WebSocket transport reads every frame as MQTT data whatever its opcode: pings
 * from load balancers go unanswered and close frames are malformed, so CI connections drop and
 * do not come back. OkHttp handles pings and close; Paho keeps its MQTT state machine.
 * Registered through Paho's NetworkModuleFactory SPI (META-INF/services) under `okws`/`okwss`,
 * so it never competes with the built-in `ws`/`wss` modules.
 */
object OkHttpWebSocket {
    const val SCHEME = "okws"
    const val SECURE_SCHEME = "okwss"

    private val clients = ConcurrentHashMap<String, OkHttpClient>()

    /** The URI Paho is given for a `ws://` or `wss://` broker, with the client that will dial it. */
    fun register(brokerUrl: String, client: OkHttpClient): String {
        val uri = URI(brokerUrl)
        val scheme = when (uri.scheme) {
            "ws" -> SCHEME
            "wss" -> SECURE_SCHEME
            else -> throw IllegalArgumentException("not a WebSocket broker URL: $brokerUrl")
        }
        val routed = URI(scheme, uri.userInfo, uri.host, uri.port, uri.path, uri.query, uri.fragment).toString()
        clients[routed] = client
        return routed
    }

    internal fun clientFor(uri: URI): OkHttpClient =
        clients[uri.toString()] ?: throw IllegalStateException("no WebSocket client registered for this broker")

    internal fun validate(uri: URI) {
        require(uri.scheme == SCHEME || uri.scheme == SECURE_SCHEME) { "unsupported scheme ${uri.scheme}" }
        require(!uri.host.isNullOrEmpty()) { "the broker URL has no host" }
    }
}

/** One MQTT connection's socket: Paho reads [input], writes [output] and flushes per packet. */
class OkHttpWebSocketStream(private val uri: URI, private val client: OkHttpClient, private val connectTimeoutMs: Long) {
    private val incoming = LinkedBlockingQueue<ByteArray>()
    private val opened = CountDownLatch(1)
    @Volatile private var socket: WebSocket? = null
    @Volatile private var open = false
    @Volatile private var failure: Throwable? = null

    val input: InputStream = object : InputStream() {
        private var chunk = ByteArray(0)
        private var position = 0

        private fun fill(): Boolean {
            while (position >= chunk.size) {
                val next = incoming.take()
                if (next === END) {
                    incoming.put(END)
                    // A failure reaches Paho as the cause of the lost connection; a close as its end.
                    failure?.let { throw IOException("WebSocket failed: ${it.message}", it) }
                    return false
                }
                chunk = next
                position = 0
            }
            return true
        }

        override fun read(): Int = if (fill()) chunk[position++].toInt() and 0xFF else -1

        override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
            if (length == 0) return 0
            if (!fill()) return -1
            val count = minOf(length, chunk.size - position)
            System.arraycopy(chunk, position, buffer, offset, count)
            position += count
            return count
        }

        override fun available(): Int = (chunk.size - position).coerceAtLeast(0)
    }

    val output: OutputStream = object : OutputStream() {
        private val pending = ByteArrayOutputStream()

        override fun write(byte: Int) = synchronized(pending) { pending.write(byte) }

        override fun write(bytes: ByteArray, offset: Int, length: Int) = synchronized(pending) { pending.write(bytes, offset, length) }

        // Paho flushes once per MQTT packet: one packet, one binary message.
        override fun flush() {
            val packet = synchronized(pending) { pending.toByteArray().also { pending.reset() } }
            if (packet.isEmpty()) return
            // Errors leave the broker's address out: it is a secret on CI, and logcat is kept.
            val open = socket ?: throw IOException("WebSocket is not open")
            if (!open.send(packet.toByteString())) throw IOException("WebSocket is closed")
        }
    }

    fun start() {
        val target = URI(if (uri.scheme == OkHttpWebSocket.SECURE_SCHEME) "wss" else "ws", uri.userInfo, uri.host, uri.port, uri.path, uri.query, null)
        val request = Request.Builder()
            .url(target.toString())
            .header("Sec-WebSocket-Protocol", "mqtt")
            .build()
        socket = client.newWebSocket(
            request,
            object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    open = true
                    opened.countDown()
                }

                override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                    incoming.put(bytes.toByteArray())
                }

                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                    webSocket.close(NORMAL_CLOSURE, null)
                    finish(null)
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = finish(null)

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = finish(t)
            },
        )
        if (!opened.await(connectTimeoutMs, TimeUnit.MILLISECONDS)) {
            stop()
            throw IOException("WebSocket did not open within ${connectTimeoutMs}ms")
        }
        failure?.let { throw IOException("WebSocket failed: ${it.message}", it) }
    }

    fun stop() {
        // A close frame waits for the handshake; an unanswered upgrade must be cancelled, or each
        // retry leaks a call and its socket.
        if (open) socket?.close(NORMAL_CLOSURE, null) else socket?.cancel()
        finish(null)
    }

    /** Ends the input stream, which is how Paho learns the connection is gone. */
    private fun finish(error: Throwable?) {
        if (error != null && failure == null) failure = error
        opened.countDown()
        incoming.put(END)
    }

    private companion object {
        val END = ByteArray(0)
        const val NORMAL_CLOSURE = 1000
    }
}

/** Paho MQTT 3.1.1's entry point to [OkHttpWebSocketStream]. */
class OkHttpWebSocketModuleFactoryV3 : org.eclipse.paho.client.mqttv3.spi.NetworkModuleFactory {
    override fun getSupportedUriSchemes(): Set<String> = setOf(OkHttpWebSocket.SCHEME, OkHttpWebSocket.SECURE_SCHEME)

    override fun validateURI(brokerUri: URI) = OkHttpWebSocket.validate(brokerUri)

    override fun createNetworkModule(
        brokerUri: URI,
        options: org.eclipse.paho.client.mqttv3.MqttConnectOptions,
        clientId: String,
    ): org.eclipse.paho.client.mqttv3.internal.NetworkModule {
        val stream = OkHttpWebSocketStream(brokerUri, OkHttpWebSocket.clientFor(brokerUri), options.connectionTimeout * 1000L)
        return object : org.eclipse.paho.client.mqttv3.internal.NetworkModule {
            override fun start() = stream.start()
            override fun getInputStream() = stream.input
            override fun getOutputStream() = stream.output
            override fun stop() = stream.stop()
            override fun getServerURI() = brokerUri.toString()
        }
    }
}

/** Paho MQTT 5's entry point to [OkHttpWebSocketStream]. */
class OkHttpWebSocketModuleFactoryV5 : org.eclipse.paho.mqttv5.client.spi.NetworkModuleFactory {
    override fun getSupportedUriSchemes(): Set<String> = setOf(OkHttpWebSocket.SCHEME, OkHttpWebSocket.SECURE_SCHEME)

    override fun validateURI(brokerUri: URI) = OkHttpWebSocket.validate(brokerUri)

    override fun createNetworkModule(
        brokerUri: URI,
        options: org.eclipse.paho.mqttv5.client.MqttConnectionOptions,
        clientId: String,
    ): org.eclipse.paho.mqttv5.client.internal.NetworkModule {
        val stream = OkHttpWebSocketStream(brokerUri, OkHttpWebSocket.clientFor(brokerUri), options.connectionTimeout * 1000L)
        return object : org.eclipse.paho.mqttv5.client.internal.NetworkModule {
            override fun start() = stream.start()
            override fun getInputStream() = stream.input
            override fun getOutputStream() = stream.output
            override fun stop() = stream.stop()
            override fun getServerURI() = brokerUri.toString()
        }
    }
}
