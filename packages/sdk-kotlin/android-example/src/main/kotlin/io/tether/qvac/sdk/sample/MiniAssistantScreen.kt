package io.tether.qvac.sdk.sample

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.tether.qvac.sdk.QvacClient
import io.tether.qvac.sdk.QvacProgressEvent
import io.tether.qvac.sdk.completion
import io.tether.qvac.sdk.generated.CompletionStreamRequest
import io.tether.qvac.sdk.generated.ModelConstant
import io.tether.qvac.sdk.generated.ModelProgressResponse
import io.tether.qvac.sdk.generated.Models
import io.tether.qvac.sdk.generated.TranscribeRequest
import io.tether.qvac.sdk.models
import io.tether.qvac.sdk.transcribe
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.io.File
import java.io.FileOutputStream
import kotlin.math.max
import kotlin.math.roundToInt

/** Compose UI and state holder for the runnable local assistant example. */
class MiniAssistantScreen(
    private val activity: Activity,
    private val scope: CoroutineScope,
) {
    private val history = mutableListOf<JsonObject>()
    private val messages = mutableStateListOf<AssistantMessage>()
    private var nextMessageId = 0L
    private var client: QvacClient? = null
    private var chatModelId by mutableStateOf<String?>(null)
    private var parakeetModelId by mutableStateOf<String?>(null)
    private var visionModelId: String? = null
    private var selectedImagePath by mutableStateOf<String?>(null)
    private var recording: AudioRecord? = null
    private var recordingJob: Job? = null
    @Volatile private var recordingActive = false

    private var statusText by mutableStateOf("Connecting to local worker…")
    private var statusTone by mutableStateOf(StatusTone.Secondary)
    private var progressVisible by mutableStateOf(false)
    private var progressValue by mutableIntStateOf(0)
    private var busyState by mutableStateOf(false)
    private var composerText by mutableStateOf("")
    private var attachmentText by mutableStateOf("Record a message or attach an image.")
    private var attachmentTone by mutableStateOf(StatusTone.Secondary)
    private var recordLabel by mutableStateOf("Record")

    @Composable
    fun Content() {
        val messageListState = rememberLazyListState()
        val imagePicker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
            uri?.let(::attachImage)
        }
        val microphonePermission = rememberLauncherForActivityResult(
            ActivityResultContracts.RequestPermission(),
        ) { granted ->
            if (granted) {
                toggleRecording()
            } else {
                setStatus("Microphone permission is required", StatusTone.Danger)
            }
        }
        val latestMessageText = messages.lastOrNull()?.text
        LaunchedEffect(messages.size, latestMessageText) {
            if (messages.isNotEmpty()) {
                messageListState.scrollToItem(messages.lastIndex)
            }
        }

        Column(
            modifier = Modifier
                .fillMaxSize()
                .windowInsetsPadding(WindowInsets.safeDrawing)
                .imePadding()
                .padding(horizontal = 16.dp),
        ) {
            Spacer(Modifier.height(12.dp))
            Text(
                text = "QVAC Assistant",
                fontSize = 28.sp,
                fontWeight = FontWeight.SemiBold,
            )
            Text(
                text = "Private, local, and ready to help",
                color = QvacPalette.TextSecondary,
                style = MaterialTheme.typography.bodyMedium,
            )
            Spacer(Modifier.height(16.dp))
            StatusCard()
            LazyColumn(
                state = messageListState,
                modifier = Modifier
                    .weight(1f)
                    .fillMaxWidth(),
                contentPadding = PaddingValues(vertical = 12.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                items(messages, key = { it.id }) { message ->
                    MessageBubble(message)
                }
            }
            Composer(
                onChooseImage = { imagePicker.launch(arrayOf("image/*")) },
                onToggleRecording = {
                    if (activity.checkSelfPermission(Manifest.permission.RECORD_AUDIO) ==
                        PackageManager.PERMISSION_GRANTED
                    ) {
                        toggleRecording()
                    } else {
                        microphonePermission.launch(Manifest.permission.RECORD_AUDIO)
                    }
                },
            )
            Spacer(Modifier.height(8.dp))
        }
    }

    fun onConnected(connectedClient: QvacClient) {
        client = connectedClient
        setStatus("Checking required models…")
        appendMessage("assistant", "I’m checking the local models. Downloads happen once and remain on this device.")
        scope.launch { prepareModels() }
    }

    fun onConnectionFailed(error: Throwable) {
        setStatus("Unable to start local assistant", StatusTone.Danger)
        appendMessage("assistant", "I couldn’t start the local worker. Please reopen the app.\n\n${error.message.orEmpty()}")
    }

    fun dispose() {
        recordingActive = false
        runCatching { recording?.stop() }
        runCatching { recording?.release() }
        recording = null
        recordingJob?.cancel()
        recordingJob = null
    }

    @Composable
    private fun StatusCard() {
        Surface(
            color = QvacPalette.Surface,
            shape = RoundedCornerShape(18.dp),
            modifier = Modifier.fillMaxWidth(),
        ) {
            Column(modifier = Modifier.padding(horizontal = 16.dp, vertical = 14.dp)) {
                Text(
                    text = statusText,
                    color = statusTone.color(),
                    style = MaterialTheme.typography.bodyMedium,
                )
                if (progressVisible) {
                    Spacer(Modifier.height(10.dp))
                    LinearProgressIndicator(
                        progress = { progressValue / 100f },
                        modifier = Modifier.fillMaxWidth(),
                        color = QvacPalette.Accent,
                        trackColor = QvacPalette.SurfaceRaised,
                    )
                }
            }
        }
    }

    @Composable
    private fun Composer(
        onChooseImage: () -> Unit,
        onToggleRecording: () -> Unit,
    ) {
        val chatEnabled = !busyState && chatModelId != null
        val recordEnabled = !busyState && parakeetModelId != null
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(
                text = attachmentText,
                color = attachmentTone.color(),
                style = MaterialTheme.typography.bodySmall,
            )
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                SecondaryButton(
                    label = "Image",
                    enabled = chatEnabled,
                    modifier = Modifier.weight(1f),
                    onClick = onChooseImage,
                )
                SecondaryButton(
                    label = recordLabel,
                    enabled = recordEnabled,
                    modifier = Modifier.weight(1f),
                    onClick = onToggleRecording,
                )
            }
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                verticalAlignment = Alignment.Bottom,
            ) {
                OutlinedTextField(
                    value = composerText,
                    onValueChange = { composerText = it },
                    enabled = chatEnabled,
                    placeholder = { Text("Message your assistant") },
                    modifier = Modifier.weight(1f),
                    minLines = 1,
                    maxLines = 5,
                    shape = RoundedCornerShape(18.dp),
                )
                Button(
                    onClick = {
                        val prompt = composerText.trim()
                        val imagePath = selectedImagePath
                        scope.launch { submitPrompt(prompt, imagePath) }
                    },
                    enabled = chatEnabled,
                    modifier = Modifier.height(56.dp),
                    shape = RoundedCornerShape(16.dp),
                    colors = ButtonDefaults.buttonColors(
                        containerColor = QvacPalette.Accent,
                        contentColor = QvacPalette.OnAccent,
                    ),
                ) {
                    Text("Send")
                }
            }
        }
    }

    @Composable
    private fun SecondaryButton(
        label: String,
        enabled: Boolean,
        modifier: Modifier = Modifier,
        onClick: () -> Unit,
    ) {
        Button(
            onClick = onClick,
            enabled = enabled,
            modifier = modifier.height(52.dp),
            shape = RoundedCornerShape(16.dp),
            colors = ButtonDefaults.buttonColors(
                containerColor = QvacPalette.SurfaceRaised,
                contentColor = QvacPalette.TextPrimary,
            ),
        ) {
            Text(label)
        }
    }

    @Composable
    private fun MessageBubble(message: AssistantMessage) {
        val isUser = message.role == "user"
        Box(
            modifier = Modifier.fillMaxWidth(),
            contentAlignment = if (isUser) Alignment.CenterEnd else Alignment.CenterStart,
        ) {
            Surface(
                color = if (isUser) QvacPalette.Accent else QvacPalette.Surface,
                contentColor = if (isUser) QvacPalette.OnAccent else QvacPalette.TextPrimary,
                shape = RoundedCornerShape(18.dp),
                modifier = Modifier.widthIn(max = if (isUser) 300.dp else 340.dp),
            ) {
                SelectionContainer {
                    Text(
                        text = message.text,
                        modifier = Modifier.padding(horizontal = 15.dp, vertical = 12.dp),
                        lineHeight = 22.sp,
                    )
                }
            }
        }
    }

    private fun attachImage(uri: Uri) {
        scope.launch {
            runCatching { copyImageToCache(uri) }
                .onSuccess {
                    selectedImagePath = it
                    attachmentText = "Image attached"
                    attachmentTone = StatusTone.Accent
                }
                .onFailure {
                    attachmentText = "Could not attach image"
                    attachmentTone = StatusTone.Danger
                }
        }
    }

    private suspend fun prepareModels() {
        setBusy(true)
        try {
            chatModelId = prepareModel(
                Models.QWEN3_600M_INST_Q4,
                AssistantModelConfig.qwen(),
            )
            parakeetModelId = prepareModel(
                Models.PARAKEET_CTC_0_6B_Q4_0,
                AssistantModelConfig.parakeet(),
            )
            setStatus("Ready · chat and Parakeet are loaded", StatusTone.Accent)
            appendMessage("assistant", "I’m ready. Type a message or tap Record to talk.")
        } catch (error: CancellationException) {
            throw error
        } catch (error: Throwable) {
            setStatus("Setup failed", StatusTone.Danger)
            appendMessage("assistant", "I couldn’t prepare the local models. Check device storage and reopen the app.\n\n${error.message.orEmpty()}")
        } finally {
            setBusy(false)
            progressVisible = false
        }
    }

    private suspend fun prepareModel(
        model: ModelConstant,
        config: JsonObject?,
    ): String {
        showModelProgress("Downloading", model.name, 0)
        requireNotNull(client).models.downloadWithProgress(model.src, seed = false).collect { event ->
            updateModelProgress(event, "Downloading", model.name)
        }
        showModelProgress("Loading", model.name, 0)
        var id: String? = null
        requireNotNull(client).models.loadWithProgress(
            source = model.src,
            modelType = model.engine,
            modelName = model.name,
            modelConfig = config,
        ).collect { event ->
            updateModelProgress(event, "Loading", model.name)
            if (event is QvacProgressEvent.Result) {
                if (!event.value.success) error(event.value.error ?: "Unable to load ${model.name}")
                id = event.value.modelId
                showModelProgress("Loaded", model.name, 100)
            }
        }
        return id ?: error("${model.name} returned no model ID")
    }

    private suspend fun submitPrompt(prompt: String, imagePath: String?) {
        if (prompt.isEmpty() && imagePath == null) return
        setBusy(true)
        val modelId = runCatching {
            if (imagePath == null) chatModelId else ensureVisionModel()
        }.getOrElse { error ->
            setStatus("Vision setup failed", StatusTone.Danger)
            appendMessage("assistant", "I couldn’t prepare the vision model. Try again later.\n\n${error.message.orEmpty()}")
            setBusy(false)
            return
        } ?: run {
            setBusy(false)
            return
        }
        val displayPrompt = prompt.ifEmpty { "Describe this image." }
        composerText = ""
        appendMessage("user", displayPrompt + if (imagePath == null) "" else "\n[Image attached]")
        history += buildJsonObject {
            put("role", "user")
            put("content", displayPrompt)
            if (imagePath != null) {
                put("attachments", buildJsonArray {
                    add(buildJsonObject { put("path", imagePath) })
                })
            }
        }
        selectedImagePath = null
        attachmentText = "Record a message or attach an image."
        attachmentTone = StatusTone.Secondary
        val bubbleId = appendMessage("assistant", "Thinking…")
        val responseText = StringBuilder()
        var stopReason: String? = null
        try {
            requireNotNull(client).completion.stream(
                CompletionStreamRequest(
                    // Separate thinking events from the visible answer.
                    captureThinking = true,
                    generationParams = buildJsonObject {
                        // -1 generates until EOS. The finite model context is
                        // the only unavoidable upper bound.
                        put("predict", -1)
                        put("reasoning_budget", -1)
                        put("temp", 0.7)
                    },
                    history = history.toList(),
                    modelId = modelId,
                    stream = true,
                    type = "completionStream",
                ),
            ).collect { response ->
                response.events.forEach { element ->
                    val event = element.jsonObject
                    when (event["type"]?.jsonPrimitive?.contentOrNull) {
                        "contentDelta" -> {
                            responseText.append(event["text"]?.jsonPrimitive?.contentOrNull.orEmpty())
                            updateMessage(bubbleId, responseText.toString())
                        }
                        "completionDone" -> {
                            stopReason = event["stopReason"]?.jsonPrimitive?.contentOrNull
                            if (stopReason == "error") {
                                error(
                                    event["error"]?.jsonObject?.get("message")
                                        ?.jsonPrimitive?.contentOrNull
                                        ?: "The model returned an inference error",
                                )
                            }
                        }
                    }
                }
            }
            if (responseText.isEmpty()) {
                updateMessage(bubbleId, "No response was returned. Try again.")
            }
            history += buildJsonObject {
                put("role", "assistant")
                put("content", responseText.toString())
            }
            if (stopReason == "length") {
                setStatus("The model context window is full", StatusTone.Danger)
            }
        } catch (error: CancellationException) {
            throw error
        } catch (error: Throwable) {
            updateMessage(bubbleId, "I couldn’t answer. Please try again.")
            setStatus(error.message ?: "Request failed", StatusTone.Danger)
        } finally {
            setBusy(false)
        }
    }

    private suspend fun ensureVisionModel(): String {
        visionModelId?.let { return it }
        visionModelId = prepareModel(
            Models.SMOLVLM2_500M_MULTIMODAL_Q8_0,
            AssistantModelConfig.smolVlm(),
        )
        setStatus("Ready · vision model loaded", StatusTone.Accent)
        return requireNotNull(visionModelId)
    }

    private fun toggleRecording() {
        if (recordingActive) {
            recordingActive = false
            runCatching { recording?.stop() }
            recordLabel = "Record"
            setBusy(true)
            setStatus("Transcribing with Parakeet…")
        } else {
            startRecording()
        }
    }

    @SuppressLint("MissingPermission")
    private fun startRecording() {
        val sampleRate = 16_000
        val minimum = AudioRecord.getMinBufferSize(
            sampleRate,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
        )
        val audioRecord = AudioRecord(
            MediaRecorder.AudioSource.MIC,
            sampleRate,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
            max(minimum, sampleRate),
        )
        val output = File(activity.cacheDir, "qvac-recording-${System.currentTimeMillis()}.s16le")
        recording = audioRecord
        recordingActive = true
        recordLabel = "Stop"
        setStatus("Recording… tap Stop when finished")
        audioRecord.startRecording()
        recordingJob = scope.launch(Dispatchers.IO) {
            FileOutputStream(output).use { stream ->
                val buffer = ByteArray(sampleRate)
                while (recordingActive) {
                    val read = audioRecord.read(buffer, 0, buffer.size)
                    if (read > 0) {
                        stream.write(buffer, 0, read)
                    }
                }
                stream.flush()
            }
            runCatching { audioRecord.release() }
            recording = null
            withContext(Dispatchers.Main) {
                transcribeAndSend(output)
            }
        }
    }

    private suspend fun transcribeAndSend(file: File) {
        val modelId = parakeetModelId
        if (modelId == null) {
            appendMessage("assistant", "Parakeet is still preparing. Try recording again in a moment.")
            return
        }
        val transcript = StringBuilder()
        try {
            requireNotNull(client).transcribe(
                TranscribeRequest(
                    audioChunk = buildJsonObject {
                        put("type", "filePath")
                        put("value", file.absolutePath)
                    },
                    metadata = false,
                    modelId = modelId,
                    type = "transcribe",
                ),
            ).collect { response -> response.text?.let(transcript::append) }
            if (transcript.isNotBlank()) {
                submitPrompt(transcript.toString(), null)
            } else {
                appendMessage("assistant", "Parakeet did not detect speech. Try recording again.")
            }
        } catch (error: CancellationException) {
            throw error
        } catch (error: Throwable) {
            setStatus("Parakeet failed", StatusTone.Danger)
            appendMessage("assistant", "Parakeet transcription failed: ${error.message.orEmpty()}")
        } finally {
            file.delete()
            setBusy(false)
        }
    }

    private fun setBusy(busy: Boolean) {
        busyState = busy
        if (busy) progressVisible = true
    }

    private fun updateModelProgress(
        event: QvacProgressEvent<*, *>,
        phase: String,
        modelName: String,
    ) {
        if (event is QvacProgressEvent.Progress<*>) {
            val value = event.value
            if (value is ModelProgressResponse) {
                showModelProgress(
                    phase,
                    modelName,
                    value.percentage.roundToInt().coerceIn(0, 100),
                )
            }
        }
    }

    private fun showModelProgress(phase: String, modelName: String, percentage: Int) {
        setStatus("$phase $modelName · $percentage%")
        progressVisible = true
        progressValue = percentage
    }

    private fun setStatus(text: String, tone: StatusTone = StatusTone.Secondary) {
        statusText = text
        statusTone = tone
    }

    private fun appendMessage(role: String, message: String): Long {
        val id = nextMessageId++
        messages += AssistantMessage(id, role, message)
        return id
    }

    private fun updateMessage(id: Long, text: String) {
        val index = messages.indexOfFirst { it.id == id }
        if (index >= 0) {
            messages[index] = messages[index].copy(text = text)
        }
    }

    private suspend fun copyImageToCache(uri: Uri): String {
        return withContext(Dispatchers.IO) {
            val file = File(activity.cacheDir, "qvac-image-${System.currentTimeMillis()}.jpg")
            activity.contentResolver.openInputStream(uri).use { input ->
                requireNotNull(input).use { source ->
                    FileOutputStream(file).use { output -> source.copyTo(output) }
                }
            }
            file.absolutePath
        }
    }
}

private data class AssistantMessage(
    val id: Long,
    val role: String,
    val text: String,
)

private enum class StatusTone {
    Secondary,
    Accent,
    Danger,
}

@Composable
private fun StatusTone.color(): Color = when (this) {
    StatusTone.Secondary -> QvacPalette.TextSecondary
    StatusTone.Accent -> QvacPalette.Accent
    StatusTone.Danger -> QvacPalette.Danger
}
