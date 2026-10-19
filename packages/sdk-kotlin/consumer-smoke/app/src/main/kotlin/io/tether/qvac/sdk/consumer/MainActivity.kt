package io.tether.qvac.sdk.consumer

import android.app.Activity
import android.os.Bundle
import io.tether.qvac.sdk.QvacClient
import io.tether.qvac.sdk.barekit.AndroidServiceTransport
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

class MainActivity : Activity() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        scope.launch {
            val transport = AndroidServiceTransport.connect(applicationContext)
            val client = QvacClient(transport)
            try {
                client.heartbeat()
            } finally {
                client.close()
            }
        }
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }
}
