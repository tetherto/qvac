package io.tether.qvac.sdk.sample

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.tether.qvac.sdk.QvacClient
import io.tether.qvac.sdk.barekit.AndroidServiceTransport
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout

/** Runnable Compose sample that validates QVAC's small-model Android feature matrix. */
class FeatureLabActivity : ComponentActivity() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var client: QvacClient? = null
    private var runner: FeatureLabRunner? = null
    private var state by mutableStateOf(FeatureLabUiState())

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableQvacEdgeToEdge()
        setContent {
            QvacSampleTheme {
                FeatureLabScreen(
                    state = state,
                    onRunAll = ::executeAll,
                    onRunFeature = ::execute,
                    onOpenAssistant = {
                        startActivity(Intent(this, MainActivity::class.java))
                    },
                )
            }
        }
        scope.launch {
            try {
                val transport = AndroidServiceTransport.connect(applicationContext)
                val connected = QvacClient(transport)
                client = connected
                runner = FeatureLabRunner(applicationContext, connected)
                state = state.copy(
                    status = "Ready · QVAC 0.19.1 worker connected",
                    isReady = true,
                )
            } catch (error: CancellationException) {
                throw error
            } catch (error: Throwable) {
                state = state.copy(status = "Worker failed: ${error.message.orEmpty()}")
            }
        }
    }

    override fun onDestroy() {
        val connected = client
        client = null
        runner = null
        scope.cancel()
        CoroutineScope(SupervisorJob() + Dispatchers.IO).launch { connected?.close() }
        super.onDestroy()
    }

    private fun execute(feature: FeatureLabRunner.Feature) {
        val featureRunner = runner ?: return
        scope.launch {
            setRunning(true)
            state = state.copy(output = "${feature.label}: starting…")
            try {
                val result = withTimeout(FEATURE_TIMEOUT_MS) {
                    featureRunner.run(feature) { message ->
                        state = state.copy(output = "${feature.label}: $message")
                    }
                }
                state = state.copy(
                    output = "PASS · ${result.feature.label}\n${result.detail}\n${result.elapsedMs} ms",
                    status = "Last run passed",
                )
            } catch (error: CancellationException) {
                throw error
            } catch (error: Throwable) {
                state = state.copy(
                    output = "FAIL · ${feature.label}\n${error.stackTraceToString()}",
                    status = "Last run failed",
                )
            } finally {
                setRunning(false)
            }
        }
    }

    private fun executeAll() {
        val featureRunner = runner ?: return
        scope.launch {
            setRunning(true)
            val lines = mutableListOf<String>()
            try {
                withTimeout(ALL_FEATURES_TIMEOUT_MS) {
                    FeatureLabRunner.Feature.entries.forEach { feature ->
                        state = state.copy(output = (lines + "${feature.label}: starting…").joinToString("\n"))
                        val result = featureRunner.run(feature) { message ->
                            state = state.copy(output = (lines + "${feature.label}: $message").joinToString("\n"))
                        }
                        lines += "PASS · ${feature.label}: ${result.detail} (${result.elapsedMs} ms)"
                        state = state.copy(output = lines.joinToString("\n"))
                    }
                }
                state = state.copy(status = "All 8 features passed")
            } catch (error: CancellationException) {
                throw error
            } catch (error: Throwable) {
                lines += "FAIL · ${error.message.orEmpty()}"
                state = state.copy(
                    output = lines.joinToString("\n"),
                    status = "Feature suite stopped on failure",
                )
            } finally {
                setRunning(false)
            }
        }
    }

    private fun setRunning(running: Boolean) {
        state = state.copy(isRunning = running)
    }

    private companion object {
        const val FEATURE_TIMEOUT_MS = 20 * 60 * 1_000L
        const val ALL_FEATURES_TIMEOUT_MS = 90 * 60 * 1_000L
    }
}

private data class FeatureLabUiState(
    val status: String = "Connecting to the isolated worker…",
    val output: String = "Results appear here. Model files are kept so later runs avoid downloading them again.",
    val isReady: Boolean = false,
    val isRunning: Boolean = false,
)

@Composable
private fun FeatureLabScreen(
    state: FeatureLabUiState,
    onRunAll: () -> Unit,
    onRunFeature: (FeatureLabRunner.Feature) -> Unit,
    onOpenAssistant: () -> Unit,
) {
    val controlsEnabled = state.isReady && !state.isRunning
    LazyColumn(
        modifier = Modifier
            .fillMaxSize()
            .windowInsetsPadding(WindowInsets.safeDrawing)
            .padding(horizontal = 20.dp),
        contentPadding = PaddingValues(top = 20.dp, bottom = 24.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        item {
            Text(
                text = "QVAC Kotlin Feature Lab",
                fontSize = 26.sp,
                fontWeight = FontWeight.SemiBold,
            )
            Spacer(Modifier.height(8.dp))
            Text(
                text = "Small, on-device models for Pixel 8a. Each test downloads once, then works from the local cache.",
                color = QvacPalette.TextSecondary,
                style = MaterialTheme.typography.bodyMedium,
            )
        }
        item {
            Surface(
                color = QvacPalette.Surface,
                shape = RoundedCornerShape(18.dp),
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = 8.dp),
            ) {
                Row(
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 14.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    if (state.isRunning) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(22.dp),
                            strokeWidth = 2.dp,
                        )
                    }
                    Text(
                        text = state.status,
                        color = QvacPalette.Accent,
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
            }
        }
        item {
            QvacActionButton(
                label = "Run all 8 features",
                enabled = controlsEnabled,
                primary = true,
                onClick = onRunAll,
            )
        }
        items(FeatureLabRunner.Feature.entries, key = { it.name }) { feature ->
            QvacActionButton(
                label = "Test ${feature.label}",
                enabled = controlsEnabled,
                onClick = { onRunFeature(feature) },
            )
        }
        item {
            QvacActionButton(
                label = "Open assistant demo",
                enabled = true,
                onClick = onOpenAssistant,
            )
        }
        item {
            Surface(
                color = QvacPalette.SurfaceRaised,
                shape = RoundedCornerShape(18.dp),
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = 8.dp),
            ) {
                SelectionContainer {
                    Text(
                        text = state.output,
                        modifier = Modifier.padding(16.dp),
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
            }
        }
    }
}

@Composable
private fun QvacActionButton(
    label: String,
    enabled: Boolean,
    primary: Boolean = false,
    onClick: () -> Unit,
) {
    Button(
        onClick = onClick,
        enabled = enabled,
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(14.dp),
        colors = if (primary) {
            ButtonDefaults.buttonColors(
                containerColor = QvacPalette.Accent,
                contentColor = QvacPalette.OnAccent,
            )
        } else {
            ButtonDefaults.buttonColors(
                containerColor = QvacPalette.SurfaceRaised,
                contentColor = QvacPalette.TextPrimary,
            )
        },
        contentPadding = PaddingValues(vertical = 14.dp, horizontal = 16.dp),
    ) {
        Text(label)
    }
}
