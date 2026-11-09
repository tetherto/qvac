package io.tether.qvac.e2e

import android.app.Activity
import android.os.Bundle
import android.view.WindowManager
import android.widget.ScrollView
import android.widget.TextView
import io.tether.qvac.e2e.consumer.ConsumerConfig

/**
 * Launching it starts [E2eSession]. Launched by Device Farm's test spec or by
 * `qvac-test run:local:kotlin-android`; nothing here needs a tap.
 */
class MainActivity : Activity() {
    private lateinit var output: TextView
    private lateinit var scroll: ScrollView
    private val sink: (String) -> Unit = { message -> show(message) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Runs last hours, and OEM freezers (Samsung's within seconds) freeze a stopped activity:
        // keep the screen on and show over the lock screen.
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        setShowWhenLocked(true)
        setTurnScreenOn(true)
        output = TextView(this).apply { setTextIsSelectable(true); textSize = 11f }
        scroll = ScrollView(this).apply { addView(output) }
        setContentView(scroll)
        E2eSession.display = sink

        val extras = intent?.extras
        val overrides = listOf(
            ConsumerConfig.EXTRA_RUN_ID,
            ConsumerConfig.EXTRA_PLATFORM,
            ConsumerConfig.EXTRA_BROKER_URL,
            ConsumerConfig.EXTRA_MQTT_USERNAME,
            ConsumerConfig.EXTRA_MQTT_PASSWORD,
            ConsumerConfig.EXTRA_SESSION_EXPIRY,
        ).associateWith { extras?.getString(it) }
        if (!E2eSession.start(applicationContext, overrides)) {
            E2eSession.log("ℹ️  Consumer already running in this process")
        }
    }

    override fun onDestroy() {
        // A recreated activity has already taken the display over; leave it.
        if (E2eSession.display === sink) E2eSession.display = null
        super.onDestroy()
    }

    private fun show(message: String) {
        runOnUiThread {
            output.append(message + "\n")
            // By length, not lineCount: a view that is not laid out (screen off, app frozen) counts no lines.
            if (output.length() > UI_CHAR_LIMIT) output.text = output.text.takeLast(UI_CHAR_KEEP)
            scroll.post { scroll.fullScroll(ScrollView.FOCUS_DOWN) }
        }
    }

    private companion object {
        const val UI_CHAR_LIMIT = 120000
        const val UI_CHAR_KEEP = 60000
    }
}
