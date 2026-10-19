package io.tether.qvac.sdk.sample

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import io.tether.qvac.sdk.QvacClient
import io.tether.qvac.sdk.QvacTransport
import io.tether.qvac.sdk.barekit.AndroidServiceTransport
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    private val activityScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var transport: QvacTransport? = null
    private var client: QvacClient? = null
    private var assistantScreen: MiniAssistantScreen? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableQvacEdgeToEdge()

        val screen = MiniAssistantScreen(this, activityScope)
        assistantScreen = screen
        setContent {
            QvacSampleTheme {
                screen.Content()
            }
        }
        activityScope.launch {
            try {
                val connectedTransport = AndroidServiceTransport.connect(applicationContext)
                val connectedClient = QvacClient(connectedTransport)
                transport = connectedTransport
                client = connectedClient
                screen.onConnected(connectedClient)
            } catch (error: CancellationException) {
                throw error
            } catch (error: Throwable) {
                screen.onConnectionFailed(error)
            }
        }
    }

    override fun onDestroy() {
        val clientToClose = client
        client = null
        transport = null
        assistantScreen?.dispose()
        assistantScreen = null
        activityScope.cancel()
        CoroutineScope(SupervisorJob() + Dispatchers.IO).launch {
            clientToClose?.close()
        }
        super.onDestroy()
    }
}
