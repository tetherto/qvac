package io.tether.qvac.sdk.sample

import android.graphics.Bitmap
import android.graphics.Color
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.filters.LargeTest
import androidx.test.platform.app.InstrumentationRegistry
import io.tether.qvac.sdk.QvacClient
import io.tether.qvac.sdk.QvacCapability
import io.tether.qvac.sdk.QvacProgressEvent
import io.tether.qvac.sdk.barekit.AndroidServiceTransport
import io.tether.qvac.sdk.completion
import io.tether.qvac.sdk.generated.CompletionStreamRequest
import io.tether.qvac.sdk.generated.Models
import io.tether.qvac.sdk.generated.SDK_VERSION
import io.tether.qvac.sdk.generated.TranscribeRequest
import io.tether.qvac.sdk.models
import io.tether.qvac.sdk.transcribe
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest

@RunWith(AndroidJUnit4::class)
class AndroidContractInstrumentationTest {
    private val expectedProfiles = mapOf(
        "aio" to setOf(
            QvacCapability.CLASSIFICATION,
            QvacCapability.AUDIO_GENERATION,
            QvacCapability.EMBEDDINGS,
            QvacCapability.IMAGE_GENERATION,
            QvacCapability.LLM,
            QvacCapability.OCR,
            QvacCapability.TRANSCRIPTION,
            QvacCapability.TRANSLATION,
            QvacCapability.TTS,
            QvacCapability.UPSCALING,
            QvacCapability.VIDEO_GENERATION,
            QvacCapability.VLA,
            QvacCapability.WORLD,
        ),
        "assistant" to setOf(QvacCapability.LLM, QvacCapability.TRANSCRIPTION),
        "llm" to setOf(QvacCapability.EMBEDDINGS, QvacCapability.LLM),
        "speech" to setOf(
            QvacCapability.TRANSCRIPTION,
            QvacCapability.TRANSLATION,
            QvacCapability.TTS,
        ),
        "vision" to setOf(QvacCapability.CLASSIFICATION, QvacCapability.LLM, QvacCapability.OCR),
        "media" to setOf(
            QvacCapability.AUDIO_GENERATION,
            QvacCapability.IMAGE_GENERATION,
            QvacCapability.UPSCALING,
            QvacCapability.VIDEO_GENERATION,
            QvacCapability.WORLD,
        ),
        "robotics" to setOf(QvacCapability.VLA),
    )

    @Test
    fun packagedWorkerBundleIsReadable() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        context.assets.open("qvac/worker.bundle").use { bundle ->
            assertTrue(bundle.read() >= 0)
        }
    }

    @Test
    fun packagedProfileMatchesClientAndWorker() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val expectedProfile = InstrumentationRegistry.getArguments()
            .getString("qvacProfile")
            ?: "aio"
        val expectedCapabilities = requireNotNull(expectedProfiles[expectedProfile]) {
            "Unknown QVAC test profile: $expectedProfile"
        }
        val profile = context.assets.open("qvac/profile.json").use { input ->
            kotlinx.serialization.json.Json.parseToJsonElement(input.bufferedReader().readText())
                .jsonObject
        }
        val workerDigest = context.assets.open("qvac/worker.bundle").use { input ->
            MessageDigest.getInstance("SHA-256")
                .digest(input.readBytes())
                .joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }
        }

        assertEquals(SDK_VERSION, profile["sdkVersion"]?.jsonPrimitive?.content)
        assertEquals(expectedProfile, profile["name"]?.jsonPrimitive?.content)
        assertEquals(
            expectedCapabilities.map(QvacCapability::name).toSet(),
            profile["capabilities"]
                ?.let { it as? kotlinx.serialization.json.JsonArray }
                ?.map { it.jsonPrimitive.content }
                ?.toSet(),
        )
        assertEquals(workerDigest, profile["workerSha256"]?.jsonPrimitive?.content)
        assertTrue(profile["addons"]?.let { it is kotlinx.serialization.json.JsonArray && it.isNotEmpty() } == true)

        if (QvacCapability.CLASSIFICATION in expectedCapabilities) {
            val classificationResource = profile["resources"]
                ?.let { it as? kotlinx.serialization.json.JsonArray }
                ?.map { it.jsonObject }
                ?.firstOrNull {
                    it["name"]?.jsonPrimitive?.content ==
                        "classification/mobilenetv3_3class_v3_fp16.gguf"
                }
            val classificationDigest = context.assets.open(
                "qvac/classification/mobilenetv3_3class_v3_fp16.gguf",
            ).use { input ->
                MessageDigest.getInstance("SHA-256")
                    .digest(input.readBytes())
                    .joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }
            }
            assertEquals(
                classificationDigest,
                classificationResource?.get("sha256")?.jsonPrimitive?.content,
            )
        }
    }

    @Test
    fun isolatedWorkerAnswersHeartbeat() = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val transport = AndroidServiceTransport.connect(context)
        val client = QvacClient(transport)
        try {
            val expectedProfile = InstrumentationRegistry.getArguments()
                .getString("qvacProfile")
                ?: "aio"
            val expectedCapabilities = requireNotNull(expectedProfiles[expectedProfile])
            assertEquals(expectedProfile, client.runtimeProfile?.name)
            assertEquals(expectedCapabilities, client.runtimeProfile?.capabilities)
            val heartbeat = client.heartbeat()
            assertTrue(heartbeat.number >= 0)
        } finally {
            client.close()
        }
    }

    @Test
    @LargeTest
    fun qwenCpuProducesCompletion() = runModelTest {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val transport = AndroidServiceTransport.connect(context)
        val client = QvacClient(transport)
        try {
            client.models.downloadWithProgress(
                source = Models.QWEN3_600M_INST_Q4.src,
                seed = false,
            ).collect()
            var modelId: String? = null
            client.models.loadWithProgress(
                source = Models.QWEN3_600M_INST_Q4.src,
                modelType = Models.QWEN3_600M_INST_Q4.engine,
                modelName = Models.QWEN3_600M_INST_Q4.name,
                modelConfig = AssistantModelConfig.qwen(),
            ).collect { event ->
                if (event is QvacProgressEvent.Result) {
                    assertTrue(event.value.error.orEmpty(), event.value.success)
                    modelId = event.value.modelId
                }
            }

            val output = StringBuilder()
            client.completion.stream(
                CompletionStreamRequest(
                    captureThinking = false,
                    generationParams = buildJsonObject {
                        put("predict", 16)
                        put("reasoning_budget", 0)
                        put("temp", 0.0)
                    },
                    history = listOf(buildJsonObject {
                        put("role", "user")
                        put("content", "Reply with exactly CPU_OK")
                    }),
                    modelId = requireNotNull(modelId),
                    stream = true,
                    type = "completionStream",
                ),
            ).collect { response ->
                response.events.forEach { element ->
                    val event = element.jsonObject
                    if (event["type"]?.jsonPrimitive?.contentOrNull == "contentDelta") {
                        output.append(event["text"]?.jsonPrimitive?.contentOrNull.orEmpty())
                    }
                }
            }

            assertEquals("CPU_OK", output.toString().trim())
        } finally {
            client.close()
        }
    }

    @Test
    @LargeTest
    fun parakeetLoadsAndAcceptsWavInput() = runModelTest {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val transport = AndroidServiceTransport.connect(context)
        val client = QvacClient(transport)
        val audioFile = File(context.cacheDir, "parakeet-silence.wav")
        writeSilentWav(audioFile)
        try {
            client.models.downloadWithProgress(
                source = Models.PARAKEET_CTC_0_6B_Q4_0.src,
                seed = false,
            ).collect()
            var modelId: String? = null
            client.models.loadWithProgress(
                source = Models.PARAKEET_CTC_0_6B_Q4_0.src,
                modelType = Models.PARAKEET_CTC_0_6B_Q4_0.engine,
                modelName = Models.PARAKEET_CTC_0_6B_Q4_0.name,
                modelConfig = AssistantModelConfig.parakeet(),
            ).collect { event ->
                if (event is QvacProgressEvent.Result) {
                    assertTrue(event.value.error.orEmpty(), event.value.success)
                    modelId = event.value.modelId
                }
            }

            client.transcribe(
                TranscribeRequest(
                    audioChunk = buildJsonObject {
                        put("type", "filePath")
                        put("value", audioFile.absolutePath)
                    },
                    metadata = false,
                    modelId = requireNotNull(modelId),
                    type = "transcribe",
                ),
            ).collect()
        } finally {
            audioFile.delete()
            client.close()
        }
    }

    @Test
    @LargeTest
    fun smolVlmCpuProducesImageCompletion() = runModelTest {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val transport = AndroidServiceTransport.connect(context)
        val client = QvacClient(transport)
        val imageFile = File(context.cacheDir, "smolvlm-red-square.png")
        Bitmap.createBitmap(64, 64, Bitmap.Config.ARGB_8888).also { bitmap ->
            bitmap.eraseColor(Color.RED)
            FileOutputStream(imageFile).use { output ->
                bitmap.compress(Bitmap.CompressFormat.PNG, 100, output)
            }
            bitmap.recycle()
        }
        try {
            client.models.downloadWithProgress(
                source = Models.SMOLVLM2_500M_MULTIMODAL_Q8_0.src,
                seed = false,
            ).collect()
            var modelId: String? = null
            client.models.loadWithProgress(
                source = Models.SMOLVLM2_500M_MULTIMODAL_Q8_0.src,
                modelType = Models.SMOLVLM2_500M_MULTIMODAL_Q8_0.engine,
                modelName = Models.SMOLVLM2_500M_MULTIMODAL_Q8_0.name,
                modelConfig = AssistantModelConfig.smolVlm(),
            ).collect { event ->
                if (event is QvacProgressEvent.Result) {
                    assertTrue(event.value.error.orEmpty(), event.value.success)
                    modelId = event.value.modelId
                }
            }

            val output = StringBuilder()
            client.completion.stream(
                CompletionStreamRequest(
                    captureThinking = false,
                    generationParams = buildJsonObject {
                        put("predict", 16)
                        put("temp", 0.0)
                    },
                    history = listOf(buildJsonObject {
                        put("role", "user")
                        put("content", "Name the dominant color in one word.")
                        put("attachments", buildJsonArray {
                            add(buildJsonObject { put("path", imageFile.absolutePath) })
                        })
                    }),
                    modelId = requireNotNull(modelId),
                    stream = true,
                    type = "completionStream",
                ),
            ).collect { response ->
                response.events.forEach { element ->
                    val event = element.jsonObject
                    if (event["type"]?.jsonPrimitive?.contentOrNull == "contentDelta") {
                        output.append(event["text"]?.jsonPrimitive?.contentOrNull.orEmpty())
                    }
                }
            }

            assertTrue(output.toString(), output.isNotBlank())
        } finally {
            imageFile.delete()
            client.close()
        }
    }

    private fun writeSilentWav(file: File) {
        val dataLength = 32_000
        val header = ByteArray(44)
        "RIFF".encodeToByteArray().copyInto(header, 0)
        putInt(header, 4, dataLength + 36)
        "WAVEfmt ".encodeToByteArray().copyInto(header, 8)
        putInt(header, 16, 16)
        header[20] = 1
        header[22] = 1
        putInt(header, 24, 16_000)
        putInt(header, 28, 32_000)
        header[32] = 2
        header[34] = 16
        "data".encodeToByteArray().copyInto(header, 36)
        putInt(header, 40, dataLength)
        FileOutputStream(file).use { output ->
            output.write(header)
            output.write(ByteArray(dataLength))
        }
    }

    private fun runModelTest(block: suspend () -> Unit) = runBlocking {
        withTimeout(MODEL_TEST_TIMEOUT_MS) {
            block()
        }
    }

    private fun putInt(buffer: ByteArray, offset: Int, value: Int) {
        buffer[offset] = value.toByte()
        buffer[offset + 1] = (value shr 8).toByte()
        buffer[offset + 2] = (value shr 16).toByte()
        buffer[offset + 3] = (value shr 24).toByte()
    }

    private companion object {
        const val MODEL_TEST_TIMEOUT_MS = 15 * 60 * 1_000L
    }
}
