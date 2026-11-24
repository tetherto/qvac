package io.tether.qvac.e2e.consumer

import org.eclipse.paho.client.mqttv3.IMqttDeliveryToken
import org.eclipse.paho.client.mqttv3.MqttCallbackExtended
import org.eclipse.paho.client.mqttv3.MqttConnectOptions
import org.eclipse.paho.client.mqttv3.persist.MemoryPersistence
import org.eclipse.paho.mqttv5.client.IMqttToken
import org.eclipse.paho.mqttv5.client.MqttCallback
import org.eclipse.paho.mqttv5.client.MqttConnectionOptions
import org.eclipse.paho.mqttv5.client.MqttDisconnectResponse
import org.eclipse.paho.mqttv5.common.MqttException
import org.eclipse.paho.mqttv5.common.MqttMessage
import org.eclipse.paho.mqttv5.common.packet.MqttProperties
import okhttp3.OkHttpClient
import java.io.ByteArrayInputStream
import java.net.URI
import java.security.KeyStore
import java.security.SecureRandom
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import javax.net.SocketFactory
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManager
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager
import org.eclipse.paho.client.mqttv3.MqttAsyncClient as MqttAsyncClientV3
import org.eclipse.paho.client.mqttv3.MqttMessage as MqttMessageV3
import org.eclipse.paho.mqttv5.client.MqttAsyncClient as MqttAsyncClientV5
import org.eclipse.paho.mqttv5.client.persist.MemoryPersistence as MemoryPersistenceV5

/** What the consumer needs from an MQTT client, over either protocol version. */
interface MqttLink {
    interface Listener {
        fun connected(reconnect: Boolean)
        fun message(topic: String, payload: ByteArray)
        fun lost(reason: String)
    }

    fun connect(listener: Listener)
    fun subscribe(topics: List<String>, done: (Throwable?) -> Unit)
    fun publish(topic: String, payload: ByteArray, qos: Int, done: ((Throwable?) -> Unit)? = null)

    /** Ends the session: on v5 the session expiry drops to zero so the broker forgets it. */
    fun close()

    companion object {
        /**
         * As in packages/test-suite/src/utils/mqtt-session.ts: MQTT 5 with a persistent session
         * when an expiry is set (CI keeps a device's queue across reconnects), else MQTT 3.1.1,
         * which the local broker speaks.
         */
        fun create(settings: MqttSettings, clientId: String): MqttLink =
            if (settings.sessionExpiryInterval != null) PahoV5Link(settings, clientId) else PahoV3Link(settings, clientId)
    }
}

data class MqttSettings(
    val url: String,
    val username: String?,
    val password: String?,
    /** A PEM bundle to trust for wss, in place of the platform store. */
    val ca: String?,
    val rejectUnauthorized: Boolean,
    val sessionExpiryInterval: Long?,
) {
    val secure: Boolean get() = url.startsWith("wss://") || url.startsWith("ssl://")

    /** Null means the platform's default trust. */
    private fun trustManager(): X509TrustManager? = when {
        !rejectUnauthorized -> TrustAll
        ca != null -> {
            val certificates = CertificateFactory.getInstance("X.509").generateCertificates(ByteArrayInputStream(ca.toByteArray()))
            val store = KeyStore.getInstance(KeyStore.getDefaultType()).apply { load(null, null) }
            certificates.forEachIndexed { index, certificate -> store.setCertificateEntry("ca-$index", certificate) }
            TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()).apply { init(store) }
                .trustManagers.filterIsInstance<X509TrustManager>().first()
        }
        else -> null
    }

    private fun sslContext(trust: X509TrustManager): SSLContext =
        SSLContext.getInstance("TLS").apply { init(null, arrayOf<TrustManager>(trust), SecureRandom()) }

    /** For a plain TCP or TLS broker, which Paho dials itself. */
    fun socketFactory(): SocketFactory? = if (secure) trustManager()?.let { sslContext(it).socketFactory } else null

    /** A WebSocket broker goes through [OkHttpWebSocket], which carries the trust and pings. */
    fun pahoUri(): String {
        val scheme = URI(url).scheme
        if (scheme != "ws" && scheme != "wss") return url
        val builder = OkHttpClient.Builder()
            .connectTimeout(CONNECT_TIMEOUT_S.toLong(), TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .pingInterval(WEBSOCKET_PING_S, TimeUnit.SECONDS)
        trustManager()?.let { builder.sslSocketFactory(sslContext(it).socketFactory, it) }
        if (!rejectUnauthorized) builder.hostnameVerifier { _, _ -> true }
        return OkHttpWebSocket.register(url, builder.build())
    }

    private object TrustAll : X509TrustManager {
        override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) = Unit
        override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) = Unit
        override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
    }
}

private const val CONNECT_TIMEOUT_S = 15
private const val KEEPALIVE_S = 30
private const val RECONNECT_DELAY_S = 3

/** Below the idle timeouts load balancers put on a WebSocket, so the connection is never idle. */
private const val WEBSOCKET_PING_S = 20L

/** Publishes held while offline, as mqtt.js does: a result sent in a blip arrives on reconnect. */
private const val OFFLINE_BUFFER = 10_000
private val RETRY = Executors.newSingleThreadScheduledExecutor { Thread(it, "mqtt-connect-retry").apply { isDaemon = true } }

/**
 * Retries the first connect: Paho's automatic reconnect only covers one that once succeeded.
 * A connect that throws is retried too, or the consumer would stay offline silently.
 */
private fun connectWithRetry(listener: MqttLink.Listener, closed: () -> Boolean, attempt: (failed: (Throwable?) -> Unit) -> Unit) {
    if (closed()) return
    val failed = { error: Throwable? ->
        if (!closed()) {
            listener.lost("connect failed: ${error?.message}")
            RETRY.schedule({ connectWithRetry(listener, closed, attempt) }, RECONNECT_DELAY_S.toLong(), TimeUnit.SECONDS)
        }
    }
    try {
        attempt(failed)
    } catch (error: Exception) {
        failed(error)
    }
}

private class PahoV3Link(private val settings: MqttSettings, clientId: String) : MqttLink {
    private val client = MqttAsyncClientV3(settings.pahoUri(), clientId, MemoryPersistence())
    @Volatile private var closed = false

    override fun connect(listener: MqttLink.Listener) {
        client.setCallback(
            object : MqttCallbackExtended {
                override fun connectComplete(reconnect: Boolean, serverURI: String) = listener.connected(reconnect)
                override fun connectionLost(cause: Throwable?) = listener.lost(cause?.message ?: "connection lost")
                override fun messageArrived(topic: String, message: MqttMessageV3) = listener.message(topic, message.payload)
                override fun deliveryComplete(token: IMqttDeliveryToken?) = Unit
            },
        )
        val options = MqttConnectOptions().apply {
            isCleanSession = false
            connectionTimeout = CONNECT_TIMEOUT_S
            keepAliveInterval = KEEPALIVE_S
            isAutomaticReconnect = true
            maxReconnectDelay = RECONNECT_DELAY_S * 1000
            settings.username?.let { userName = it }
            settings.password?.let { password = it.toCharArray() }
            settings.socketFactory()?.let { socketFactory = it }
            if (!settings.rejectUnauthorized) isHttpsHostnameVerificationEnabled = false
        }
        client.setBufferOpts(
            org.eclipse.paho.client.mqttv3.DisconnectedBufferOptions().apply {
                isBufferEnabled = true
                bufferSize = OFFLINE_BUFFER
                isPersistBuffer = false
                isDeleteOldestMessages = false
            },
        )
        connectWithRetry(listener, { closed }) { failed ->
            client.connect(
                options,
                null,
                object : org.eclipse.paho.client.mqttv3.IMqttActionListener {
                    override fun onSuccess(asyncActionToken: org.eclipse.paho.client.mqttv3.IMqttToken?) = Unit
                    override fun onFailure(asyncActionToken: org.eclipse.paho.client.mqttv3.IMqttToken?, exception: Throwable?) =
                        failed(exception)
                },
            )
        }
    }

    override fun subscribe(topics: List<String>, done: (Throwable?) -> Unit) {
        client.subscribe(
            topics.toTypedArray(),
            IntArray(topics.size) { 1 },
            null,
            object : org.eclipse.paho.client.mqttv3.IMqttActionListener {
                override fun onSuccess(asyncActionToken: org.eclipse.paho.client.mqttv3.IMqttToken?) = done(null)
                override fun onFailure(asyncActionToken: org.eclipse.paho.client.mqttv3.IMqttToken?, exception: Throwable?) =
                    done(exception ?: IllegalStateException("subscribe failed"))
            },
        )
    }

    override fun publish(topic: String, payload: ByteArray, qos: Int, done: ((Throwable?) -> Unit)?) {
        try {
            client.publish(
                topic,
                payload,
                qos,
                false,
                null,
                object : org.eclipse.paho.client.mqttv3.IMqttActionListener {
                    override fun onSuccess(asyncActionToken: org.eclipse.paho.client.mqttv3.IMqttToken?) {
                        done?.invoke(null)
                    }
                    override fun onFailure(asyncActionToken: org.eclipse.paho.client.mqttv3.IMqttToken?, exception: Throwable?) {
                        done?.invoke(exception ?: IllegalStateException("publish failed"))
                    }
                },
            )
        } catch (error: Exception) {
            done?.invoke(error)
        }
    }

    override fun close() {
        closed = true
        runCatching { client.disconnect().waitForCompletion(5000) }
        runCatching { client.close() }
    }
}

private class PahoV5Link(private val settings: MqttSettings, clientId: String) : MqttLink {
    private val client = MqttAsyncClientV5(settings.pahoUri(), clientId, MemoryPersistenceV5())
    @Volatile private var closed = false

    override fun connect(listener: MqttLink.Listener) {
        client.setCallback(
            object : MqttCallback {
                override fun disconnected(disconnectResponse: MqttDisconnectResponse?) = listener.lost(
                    disconnectResponse?.exception?.let { "${it.message} (${it.reasonCode})" }
                        ?: disconnectResponse?.reasonString
                        ?: "disconnected (reason ${disconnectResponse?.returnCode})",
                )
                override fun mqttErrorOccurred(exception: MqttException?) = listener.lost(exception?.message ?: "mqtt error")
                override fun messageArrived(topic: String, message: MqttMessage) = listener.message(topic, message.payload)
                override fun deliveryComplete(token: IMqttToken?) = Unit
                override fun connectComplete(reconnect: Boolean, serverURI: String?) = listener.connected(reconnect)
                override fun authPacketArrived(reasonCode: Int, properties: MqttProperties?) = Unit
            },
        )
        val options = MqttConnectionOptions().apply {
            isCleanStart = false
            sessionExpiryInterval = settings.sessionExpiryInterval
            connectionTimeout = CONNECT_TIMEOUT_S
            keepAliveInterval = KEEPALIVE_S
            isAutomaticReconnect = true
            setAutomaticReconnectDelay(1, RECONNECT_DELAY_S)
            settings.username?.let { userName = it }
            settings.password?.let { password = it.toByteArray() }
            settings.socketFactory()?.let { socketFactory = it }
            if (!settings.rejectUnauthorized) isHttpsHostnameVerificationEnabled = false
        }
        client.setBufferOpts(
            org.eclipse.paho.mqttv5.client.DisconnectedBufferOptions().apply {
                isBufferEnabled = true
                bufferSize = OFFLINE_BUFFER
                isPersistBuffer = false
                isDeleteOldestMessages = false
            },
        )
        connectWithRetry(listener, { closed }) { failed ->
            client.connect(
                options,
                null,
                object : org.eclipse.paho.mqttv5.client.MqttActionListener {
                    override fun onSuccess(asyncActionToken: IMqttToken?) = Unit
                    override fun onFailure(asyncActionToken: IMqttToken?, exception: Throwable?) = failed(exception)
                },
            )
        }
    }

    override fun subscribe(topics: List<String>, done: (Throwable?) -> Unit) {
        client.subscribe(
            topics.toTypedArray(),
            IntArray(topics.size) { 1 },
            null,
            object : org.eclipse.paho.mqttv5.client.MqttActionListener {
                override fun onSuccess(asyncActionToken: IMqttToken?) = done(null)
                override fun onFailure(asyncActionToken: IMqttToken?, exception: Throwable?) =
                    done(exception ?: IllegalStateException("subscribe failed"))
            },
        )
    }

    override fun publish(topic: String, payload: ByteArray, qos: Int, done: ((Throwable?) -> Unit)?) {
        try {
            val message = MqttMessage(payload).apply { this.qos = qos }
            client.publish(
                topic,
                message,
                null,
                object : org.eclipse.paho.mqttv5.client.MqttActionListener {
                    override fun onSuccess(asyncActionToken: IMqttToken?) {
                        done?.invoke(null)
                    }
                    override fun onFailure(asyncActionToken: IMqttToken?, exception: Throwable?) {
                        done?.invoke(exception ?: IllegalStateException("publish failed"))
                    }
                },
            )
        } catch (error: Exception) {
            done?.invoke(error)
        }
    }

    override fun close() {
        closed = true
        // Expire the session now: a finished run must not leave a queue behind on the broker.
        val properties = MqttProperties().apply { sessionExpiryInterval = 0L }
        runCatching { client.disconnect(5000, null, null, 0, properties).waitForCompletion(5000) }
        runCatching { client.close() }
    }
}
