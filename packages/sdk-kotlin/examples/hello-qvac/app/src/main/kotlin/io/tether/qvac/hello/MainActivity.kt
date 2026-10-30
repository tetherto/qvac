package io.tether.qvac.hello

import android.app.Activity
import android.graphics.Typeface
import android.os.Bundle
import android.util.TypedValue
import android.widget.ScrollView
import android.widget.TextView
import io.tether.qvac.sdk.QvacClient
import io.tether.qvac.sdk.QvacCompletionOptions
import io.tether.qvac.sdk.QvacMessage
import io.tether.qvac.sdk.QvacProgressEvent
import io.tether.qvac.sdk.barekit.AndroidServiceTransport
import io.tether.qvac.sdk.completion
import io.tether.qvac.sdk.generated.Models
import io.tether.qvac.sdk.models
import io.tether.qvac.sdk.run
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.util.Locale

class MainActivity : Activity() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var client: QvacClient? = null
    private lateinit var output: TextView
    private lateinit var scroller: ScrollView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        output = TextView(this).apply {
            typeface = Typeface.MONOSPACE
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
            setPadding(32, 96, 32, 32)
        }
        scroller = ScrollView(this).apply { addView(output) }
        setContentView(scroller)

        scope.launch {
            try {
                val transport = AndroidServiceTransport.connect(applicationContext)
                val connected = QvacClient(transport)
                client = connected
                demo(connected)
            } catch (error: Throwable) {
                append("\n\nError: ${error.message}\n")
            }
        }
    }

    private suspend fun demo(client: QvacClient) {
        append("heartbeat: ${client.heartbeat()}\n")
        val profile = client.runtimeProfile
        append("profile: ${profile?.name} ${profile?.sdkVersion}\n\n")

        val model = Models.QWEN3_600M_INST_Q4
        append("download ${model.name}")
        client.models.downloadWithProgress(model.src).collect { event ->
            if (event is QvacProgressEvent.Progress) replaceLastLine("download ${model.name} ${event.value.percentage.toInt()}%")
        }
        replaceLastLine("download ${model.name} done\n")

        append("load ${model.name}")
        val modelId = requireNotNull(
            client.models.load(
                source = model.src,
                modelType = model.engine,
                modelName = model.name,
                modelConfig = buildJsonObject { put("threads", 4) },
            ).modelId,
        )
        replaceLastLine("load ${model.name} done\n\n")

        val run = client.completion.run(
            modelId = modelId,
            history = listOf(
                QvacMessage.system("Be concise."),
                QvacMessage.user("Explain on-device inference in two sentences."),
            ),
            options = QvacCompletionOptions(captureThinking = true),
        )
        var answerStarted = false
        run.tokens.collect { token ->
            if (!answerStarted && token.isBlank()) return@collect
            answerStarted = true
            append(token)
        }
        val stats = run.final.await().stats
        append("\n\n${stats?.generatedTokens?.toInt()} tokens, ${"%.1f".format(Locale.US, stats?.tokensPerSecond)} tok/s\n")
    }

    private fun append(text: String) {
        output.append(text)
        scroller.post { scroller.fullScroll(ScrollView.FOCUS_DOWN) }
    }

    private fun replaceLastLine(text: String) {
        val current = output.text.toString()
        val start = current.lastIndexOf('\n') + 1
        output.text = current.substring(0, start) + text
    }

    override fun onDestroy() {
        val toClose = client
        client = null
        scope.cancel()
        CoroutineScope(Dispatchers.IO).launch { toClose?.close() }
        super.onDestroy()
    }
}
