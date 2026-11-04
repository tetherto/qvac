package io.tether.qvac.sdk.sample

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.util.Base64
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.filters.LargeTest
import androidx.test.platform.app.InstrumentationRegistry
import io.tether.qvac.sdk.*
import io.tether.qvac.sdk.barekit.AndroidServiceTransport
import io.tether.qvac.sdk.barekit.AndroidBareKitTransport
import io.tether.qvac.sdk.generated.Models
import io.tether.qvac.sdk.generated.schema.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder

/** Real-worker regressions. Tests retain downloaded models and never delete user data. */
@RunWith(AndroidJUnit4::class)
class ApiRegressionInstrumentationTest {
    @Test
    @LargeTest
    fun rejectedDuplexKeepsConnectionUsable() = withClient { client ->
        assumeTrue(client.runtimeProfile!!.plugins.any { "whispercpp-transcription" in it })
        // Batch Whisper needs no VAD, but streaming must reject this configuration.
        val loaded = client.models.load(Models.WHISPER_TINY_Q8_0.src, Models.WHISPER_TINY_Q8_0.engine,
            modelConfig = AssistantModelConfig.whisperTiny())
        assertTrue(loaded.error, loaded.success)
        val id = requireNotNull(loaded.modelId)
        val bytes = 1024 * 1024 + 4
        val error = runCatching {
            withTimeout(30_000) {
                client.speech.transcribeStream(TranscribeStreamRequest(modelId = id), flowOf(ByteArray(bytes))).collect()
            }
        }.exceptionOrNull()
        println("QVAC_REGRESSION rejectedDuplex error=$error bytes=$bytes")
        assertTrue("Expected VAD configuration error, got $error", error is QvacException && error.message.orEmpty().contains("VAD"))
        withTimeout(15_000) {
            assertTrue(client.heartbeat().number >= 0)
            println("QVAC_REGRESSION rejectedDuplex heartbeat OK")
            assertTrue(client.models.unload(id).success)
            println("QVAC_REGRESSION rejectedDuplex unload OK")
        }
    }

    @Test
    @LargeTest
    fun duplexTranscriptionFragmentsLargeInputAndPreservesSpeech() = withClient { client ->
        assumeTrue(client.runtimeProfile!!.plugins.any { "whispercpp-transcription" in it })
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val wav = context.assets.open("sample-16khz.wav").use { it.readBytes() }
        val header = ByteBuffer.wrap(wav).order(ByteOrder.LITTLE_ENDIAN)
        assertEquals(1, header.getShort(20).toInt()) // PCM fixture
        assertEquals(1, header.getShort(22).toInt()) // mono
        assertEquals(16000, header.getInt(24))
        assertEquals(16, header.getShort(34).toInt())
        var offset = 12
        while (offset + 8 <= wav.size && String(wav, offset, 4, Charsets.US_ASCII) != "data") {
            val length = header.getInt(offset + 4)
            require(length >= 0 && length <= wav.size - offset - 8)
            offset += 8 + length + (length and 1)
        }
        require(offset + 8 <= wav.size)
        val size = header.getInt(offset + 4)
        require(size >= 0 && size % 2 == 0 && size <= wav.size - offset - 8)
        // One input emission larger than Binder's entire transaction budget.
        // Trailing zeroes are silence, keeping the fixture's spoken words intact.
        val pcm = ByteBuffer.allocate(maxOf(size * 2, 1024 * 1024 + 4)).order(ByteOrder.LITTLE_ENDIAN)
        for (index in offset + 8 until offset + 8 + size step 2) {
            pcm.putFloat(header.getShort(index) / 32768f)
        }
        val loaded = client.models.load(Models.WHISPER_TINY_Q8_0.src, Models.WHISPER_TINY_Q8_0.engine,
            modelConfig = buildJsonObject {
                AssistantModelConfig.whisperTiny().forEach { (key, value) -> put(key, value) }
                put("vadModelSrc", Models.VAD_SILERO_5_1_2.src)
            })
        assertTrue(loaded.error, loaded.success)
        val id = requireNotNull(loaded.modelId)
        var failure: Throwable? = null
        try {
            val text = StringBuilder()
            withTimeout(120_000) {
                client.speech.transcribeStream(TranscribeStreamRequest(modelId = id, metadata = true),
                    flowOf(pcm.array())).collect { event ->
                    assertNull(event.error)
                    text.append(event.text ?: event.segment?.text.orEmpty())
                }
            }
            println("QVAC_REGRESSION duplexAsr bytes=${pcm.capacity()} text=$text")
            assertTrue(text.toString(), text.contains("test", ignoreCase = true))
            assertTrue(client.heartbeat().number >= 0)
        } catch (error: Throwable) {
            failure = error
            throw error
        } finally {
            try {
                withTimeout(15_000) { assertTrue(client.models.unload(id).success) }
            } catch (cleanup: Throwable) {
                failure?.addSuppressed(cleanup) ?: throw cleanup
            }
        }
    }

    @Test
    fun directTransportCanStartAndCloseOnBackgroundDispatcher(): Unit = runBlocking {
        withTimeout(60_000) {
            repeat(3) {
                withContext(Dispatchers.Default) {
                    val context = InstrumentationRegistry.getInstrumentation().targetContext
                    val client = QvacClient(AndroidBareKitTransport.connect(context))
                    try { assertTrue(client.heartbeat().number >= 0) } finally { client.close() }
                }
            }
        }
    }

    @Test
    @LargeTest
    fun smallStandaloneUpscalerReturnsLargerPng() = withClient { client ->
        assumeTrue(client.runtimeProfile!!.supports(QvacCapability.UPSCALING))
        val loaded = client.models.load(Models.REALESRGAN_X4PLUS_ANIME_6B.src,
            Models.REALESRGAN_X4PLUS_ANIME_6B.engine, modelConfig = buildJsonObject {
                put("mode", "upscale")
                put("device", "cpu")
                putJsonObject("upscaler") { put("threads", 2); put("tile_size", 32) }
            })
        assertTrue(loaded.error, loaded.success)
        val id = requireNotNull(loaded.modelId)
        try {
            val bitmap = Bitmap.createBitmap(16, 16, Bitmap.Config.ARGB_8888)
            val bytes = try {
                bitmap.eraseColor(Color.RED)
                ByteArrayOutputStream().use { output ->
                    assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG, 100, output))
                    output.toByteArray()
                }
            } finally { bitmap.recycle() }
            val result = withTimeout(120_000) {
                client.media.upscale(id, Base64.encodeToString(bytes, Base64.NO_WRAP), repeats = 1).final.await()
            }
            assertEquals(1, result.data.size)
            val png = Base64.decode(result.data.single(), Base64.DEFAULT)
            val image = requireNotNull(BitmapFactory.decodeByteArray(png, 0, png.size))
            try {
                assertEquals(64, image.width)
                assertEquals(64, image.height)
                println("QVAC_REGRESSION upscale 16x16 -> ${image.width}x${image.height}, stats=${result.stats}")
            } finally { image.recycle() }
        } finally {
            withTimeout(15_000) { assertTrue(client.models.unload(id).success) }
        }
    }

    @Test
    fun lifecycleRegistryResourcesAndMissingCapabilities() = withClient { client ->
        assertEquals(StateResponseState.ACTIVE, client.system.state().state)
        client.system.pause()
        try {
            assertEquals(StateResponseState.SUSPENDED, client.system.state().state)
        } finally {
            client.system.resume()
        }
        assertEquals(StateResponseState.ACTIVE, client.system.state().state)
        assertEquals("getSystemResources", client.system.resources(includeUsageSnapshot = true).type)
        val registry = client.registry.list()
        assertTrue(registry.error, registry.success)
        assertFalse(registry.models.isNullOrEmpty())
        val profile = requireNotNull(client.runtimeProfile)
        val operations = mapOf(
            QvacCapability.LLM to "completionStream",
            QvacCapability.TTS to "textToSpeech",
            QvacCapability.OCR to "ocrStream",
            QvacCapability.EMBEDDINGS to "embed",
        )
        operations.filterKeys { !profile.supports(it) }.forEach { (capability, type) ->
            val error = runCatching { client.call(buildJsonObject { put("type", type) }) }.exceptionOrNull()
            assertTrue("$type must fail locally with UnsupportedCapabilityException: $error", error is UnsupportedCapabilityException)
            assertEquals(capability, (error as UnsupportedCapabilityException).capability)
        }
        assertTrue(client.heartbeat().number >= 0)
    }

    @Test
    @LargeTest
    fun demoCompletionPreservesReasoningAndHasNoOutputCap() = withClient { client ->
        assumeTrue(client.runtimeProfile!!.supports(QvacCapability.LLM))
        val demo = QwenDemo(client)
        val id = demo.loadModel {}
        try {
            val result = demo.complete(id, "What is 2+2? Answer with only the number.") {}
            assertEquals("4", result.text.trim())
            assertNotEquals("length", result.stopReason)
            println("QVAC_REGRESSION demo=$result")
        } finally { assertTrue(client.models.unload(id).success) }
    }

    @Test
    @LargeTest
    fun typedGpuCompletionCancellationAndReuse() = withClient { client ->
        assumeTrue(client.runtimeProfile!!.supports(QvacCapability.LLM))
        val device = InstrumentationRegistry.getArguments().getString("qvacDevice") ?: "gpu"
        val loaded = client.models.load(LoadModelRequest.LoadModelSrcRequest(
            LoadModelSrcRequest.LlamacppCompletion(LoadModelSrcRequestLlamacppCompletion(
                modelSrc = Models.QWEN3_600M_INST_Q4.src,
                modelConfig = LoadModelSrcRequestLlamacppCompletionModelConfig(
                    ctx_size = 2048.0, device = device, gpu_layers = if (device == "gpu") 99.0 else 0.0, reasoning_budget = -1,
                ),
            )),
        ))
        assertTrue(loaded.error, loaded.success)
        val id = requireNotNull(loaded.modelId)
        try {
            client.models.loadedInfo(id)
            val options = QvacCompletionOptions(captureThinking = true,
                generation = QvacGenerationOptions(temperature = 0.0, seed = 42, predict = -1))
            val history = listOf(QvacMessage.user("What is 2+2? Answer with only the number."))
            val before = client.completion.run(id, history, options = options).final.await()
            println("QVAC_REGRESSION beforeCancellation=$before")
            val run = client.completion.run(id, listOf(QvacMessage.user("Count from 1 to 1000, one number per line.")),
                options = QvacCompletionOptions(captureThinking = true))
            withTimeout(60_000) {
                run.events.first { it is QvacCompletionEvent.ThinkingDelta || it is QvacCompletionEvent.ContentDelta }
            }
            assertTrue("Cancellation must be acknowledged by the native worker", run.cancel())
            val error = runCatching { run.final.await() }.exceptionOrNull()
            assertTrue("Expected cancellation, got $error", error is QvacCompletionCancelledException)
            assertEquals("cancelled", (error as QvacCompletionCancelledException).partial.stopReason)
            assertTrue(client.heartbeat().number >= 0)

            val retry = client.completion.run(id, history, options = options.copy(requestId = "pixel-after-cancel"))
            val result = retry.final.await()
            println("QVAC_REGRESSION completion=$result")
            assertEquals("4", before.text.trim())
            assertEquals("4", result.text.trim())
            assertEquals("Requested backend must actually be used", device, result.stats?.backendDevice)
        } finally {
            assertTrue(client.models.unload(id).success)
        }
    }

    @Test
    @LargeTest
    fun typedDuplexSpeechProducesFiniteAudioAndFinalEvent() = withClient { client ->
        assumeTrue(client.runtimeProfile!!.supports(QvacCapability.TTS))
        val loaded = client.models.load(Models.TTS_MULTILINGUAL_SUPERTONIC3_Q4_0.src,
            Models.TTS_MULTILINGUAL_SUPERTONIC3_Q4_0.engine, modelConfig = AssistantModelConfig.supertonic())
        assertTrue(loaded.error, loaded.success)
        val id = requireNotNull(loaded.modelId)
        try {
            // Cancel before providing input, then reuse the same connection.
            coroutineScope {
                val inputEntered = CompletableDeferred<Unit>()
                val pending = launch {
                    client.speech.synthesizeStream(TextToSpeechStreamRequest(modelId = id), flow {
                        inputEntered.complete(Unit)
                        awaitCancellation()
                    }).collect()
                }
                withTimeout(15_000) { inputEntered.await() }
                pending.cancelAndJoin()
            }
            assertTrue(client.heartbeat().number >= 0)
            repeat(3) {
                var samples = 0
                var done = false
                println("QVAC_REGRESSION duplexTts model loaded; opening input stream")
                withTimeout(120_000) {
                    client.speech.synthesizeStream(TextToSpeechStreamRequest(modelId = id, inputType = "text", accumulateSentences = true),
                        flow {
                            println("QVAC_REGRESSION duplexTts sending input")
                            emit("Hello from Kotlin. ".encodeToByteArray())
                            emit("The stream works.".encodeToByteArray())
                        })
                        .collect { event ->
                            assertTrue("Non-finite audio samples", event.buffer.all(Double::isFinite))
                            samples += event.buffer.size
                            done = done || event.done
                            println("QVAC_REGRESSION duplexTts received=${event.buffer.size} done=${event.done}")
                        }
                }
                println("QVAC_REGRESSION duplexTts samples=$samples done=$done")
                assertTrue(samples > 0)
                assertTrue("Missing final speech event", done)
                assertTrue(client.heartbeat().number >= 0)
            }
        } finally {
            withTimeout(15_000) { assertTrue(client.models.unload(id).success) }
        }
    }

    private fun withClient(block: suspend (QvacClient) -> Unit): Unit = runBlocking {
        withTimeout(15 * 60_000L) {
            val context = InstrumentationRegistry.getInstrumentation().targetContext
            val direct = InstrumentationRegistry.getArguments().getString("qvacDirect") == "true"
            val client = QvacClient(if (direct) withContext(Dispatchers.Default) {
                AndroidBareKitTransport.connect(context)
            } else AndroidServiceTransport.connect(context))
            try { block(client) } finally { client.close() }
        }
    }
}
