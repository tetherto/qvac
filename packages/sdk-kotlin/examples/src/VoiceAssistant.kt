// Kotlin port of packages/sdk/examples/voice-assistant/voice-assistant.ts.
//
// Real-time Voice Assistant: mic → Whisper (with Silero VAD) → Llama →
// Supertonic TTS.
//
// Speak a question; the VAD detects when you pause, the utterance is
// transcribed, sent to the LLM, and the response is spoken back. The loop
// continues until you press Ctrl+C. While the assistant is speaking, mic audio
// is dropped so it does not hear itself.
//
// The microphone and playback helpers the TypeScript example imports from
// `audio/mic-input` and `tts/utils` are repeated inline, on the JDK's
// `javax.sound.sampled` (a `TargetDataLine` for the mic, a `SourceDataLine` for
// the speakers) instead of the ffmpeg/ffplay subprocesses that JS and Python
// spawn, so no external tool is needed. Set `MIC_DEVICE` to part of a mixer
// name to pick a microphone other than the system default.
//
// Kotlin notes: the microphone is a cold `Flow<ByteArray>` handed straight to
// the duplex `client.speech.transcribeStream()`; it reads on `Dispatchers.IO`
// and keeps draining the mic while a turn runs, which JS gets from Node's event
// loop and Python from a pump task. Ctrl+C ends the JVM: the transport's
// shutdown hook then stops the worker, which releases the loaded models.
//
// Requirements: microphone access, speakers.
//
// RUN: ./gradlew run -Pexample=VoiceAssistant

import io.tether.qvac.sdk.JvmBareRpcTransport
import io.tether.qvac.sdk.QvacClient
import io.tether.qvac.sdk.QvacCompletionEvent
import io.tether.qvac.sdk.QvacMessage
import io.tether.qvac.sdk.completion
import io.tether.qvac.sdk.generated.ModelConstant
import io.tether.qvac.sdk.generated.Models
import io.tether.qvac.sdk.generated.schema.TranscribeStreamRequest
import io.tether.qvac.sdk.models
import io.tether.qvac.sdk.run
import io.tether.qvac.sdk.speech
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.atomic.AtomicBoolean
import javax.sound.sampled.AudioFormat
import javax.sound.sampled.AudioSystem
import javax.sound.sampled.DataLine
import javax.sound.sampled.TargetDataLine
import kotlin.math.roundToInt
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.isActive
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

private const val MIC_SAMPLE_RATE = 16000
private const val TTS_SAMPLE_RATE = 44100

private const val SYSTEM_PROMPT =
    "You are a concise, friendly voice assistant. Keep responses under two " +
        "sentences. Never use markdown, lists, or code blocks — your output will " +
        "be spoken aloud."

// VAD parameters tuned for conversational speech without the assistant looping
// on its own echo. These defaults are deliberately conservative:
//   - threshold 0.6: less sensitive than Silero's default; avoids triggering
//     on TTS reverb bleeding into the mic or low-level background noise.
//   - min_speech_duration_ms 300: drops short clicks/breaths and stray words.
//   - min_silence_duration_ms 700: requires a longer quiet tail before
//     committing a segment. Crucial for preventing self-hearing feedback loops
//     where Whisper hallucinates content from near-silent audio.
//   - max_speech_duration_s 15: caps runaway utterances.
//   - speech_pad_ms 200: padding improves accuracy on utterance edges.
// If the assistant cuts you off mid-sentence, raise min_silence_duration_ms.
// If it keeps hallucinating / talking to itself, raise threshold to 0.7 and/or
// min_silence_duration_ms to 900.
private val VAD_PARAMS = buildJsonObject {
    put("threshold", 0.6)
    put("min_speech_duration_ms", 300)
    put("min_silence_duration_ms", 700)
    put("max_speech_duration_s", 15.0)
    put("speech_pad_ms", 200)
}

// Short grace period after TTS playback before we start listening again.
// Gives the speaker amp / room reverb a moment to fully settle so the first
// post-playback mic frames don't get transcribed as the tail of our own voice.
private const val POST_PLAYBACK_COOLDOWN_MS = 300L

// Minimum characters for an utterance to be considered meaningful. Whisper
// frequently hallucinates single words like "you", ".", or "Thanks." from
// silence or faint noise; these short phantoms are the main driver of the
// self-hearing feedback loop, so we drop them.
private const val MIN_UTTERANCE_CHARS = 3

private fun isMeaningfulTranscript(text: String): Boolean {
    val trimmed = text.trim()
    if (trimmed.isEmpty()) return false
    if ("[No speech detected]" in trimmed) return false
    // Whisper sometimes emits non-linguistic cues on silence, e.g. "[BLANK_AUDIO]".
    if (Regex("""\[[^\]]+\]""").matches(trimmed)) return false
    // Strip punctuation/whitespace for the length check so ". . ." is rejected.
    val letters = trimmed.replace(Regex("""(?U)[\W_]"""), "")
    return letters.length >= MIN_UTTERANCE_CHARS
}

// ── Microphone (audio/mic-input.ts) ──

/** Open the `MIC_DEVICE` mixer's input line when set, else the system default microphone. */
private fun openMicrophone(format: AudioFormat): TargetDataLine {
    val info = DataLine.Info(TargetDataLine::class.java, format)
    val override = System.getenv("MIC_DEVICE")
        ?: return AudioSystem.getLine(info) as TargetDataLine
    val mixer = AudioSystem.getMixerInfo()
        .map(AudioSystem::getMixer)
        .firstOrNull { override in it.mixerInfo.name && it.isLineSupported(info) }
        ?: error("No audio input device matches MIC_DEVICE=\"$override\"")
    return mixer.getLine(info) as TargetDataLine
}

/**
 * Capture mono audio from the mic as f32le chunks. Samples are read as 16-bit
 * PCM (which every Java Sound mixer supports) and converted to the `f32le`
 * format the Whisper model is loaded with. Chunks read while [muted] returns
 * true are dropped, so the line keeps draining.
 */
private fun microphone(sampleRate: Int, muted: () -> Boolean): Flow<ByteArray> = flow {
    val line = openMicrophone(AudioFormat(sampleRate.toFloat(), 16, 1, true, false))
    line.open()
    try {
        line.start()
        val buffer = ByteArray(4096)
        while (currentCoroutineContext().isActive) {
            val count = line.read(buffer, 0, buffer.size)
            if (count > 0 && !muted()) emit(s16leToF32le(buffer, count))
        }
    } finally {
        line.close()
    }
}.flowOn(Dispatchers.IO)

private fun s16leToF32le(pcm: ByteArray, length: Int): ByteArray {
    val input = ByteBuffer.wrap(pcm, 0, length).order(ByteOrder.LITTLE_ENDIAN)
    val output = ByteBuffer.allocate(length / 2 * 4).order(ByteOrder.LITTLE_ENDIAN)
    while (input.remaining() >= 2) output.putFloat(input.getShort() / 32768f)
    return output.array()
}

// ── Playback (tts/utils.ts) ──

/** Convert int16 PCM samples to little-endian bytes. */
private fun int16ArrayToBuffer(samples: List<Double>): ByteArray {
    val buffer = ByteBuffer.allocate(samples.size * 2).order(ByteOrder.LITTLE_ENDIAN)
    for (s in samples) buffer.putShort(s.roundToInt().coerceIn(-32768, 32767).toShort())
    return buffer.array()
}

/** Play 16-bit mono PCM on the default speakers and block until it has been heard. */
private fun playAudio(pcm: ByteArray, sampleRate: Int) {
    val line = AudioSystem.getSourceDataLine(AudioFormat(sampleRate.toFloat(), 16, 1, true, false))
    line.open()
    try {
        line.start()
        line.write(pcm, 0, pcm.size)
        line.drain()
    } finally {
        line.close()
    }
}

// ── Main ──

fun main(): Unit = runBlocking {
    val client = QvacClient(JvmBareRpcTransport.connectResolved(installWorkerIfMissing = true))
    val modelIds = mutableListOf<String>()
    try {
        println("▸ Loading whisper-tiny + Silero VAD...")
        val asrModelId = client.loadModel(
            Models.WHISPER_TINY,
            buildJsonObject {
                put("vadModelSrc", Models.VAD_SILERO_5_1_2.src)
                put("audio_format", "f32le")
                put("strategy", "greedy")
                put("n_threads", 4)
                put("language", "en")
                put("no_timestamps", true)
                put("suppress_blank", true)
                put("suppress_nst", true)
                put("temperature", 0.0)
                put("vad_params", VAD_PARAMS)
            },
        )
        modelIds += asrModelId

        println("▸ Loading Llama 3.2 1B...")
        val llmModelId = client.loadModel(
            Models.LLAMA_3_2_1B_INST_Q4_0,
            buildJsonObject { put("ctx_size", 4096) },
        )
        modelIds += llmModelId

        println("▸ Loading Supertonic TTS...")
        val ttsModelId = client.loadModel(
            Models.TTS_EN_SUPERTONIC_Q8_0,
            buildJsonObject {
                put("ttsEngine", "supertonic")
                put("language", "en")
                put("voice", "F1")
                put("ttsSpeed", 1.05)
                put("ttsNumInferenceSteps", 5)
            },
        )
        modelIds += ttsModelId

        println("▸ All models loaded.\n")

        val history = mutableListOf(QvacMessage.system(SYSTEM_PROMPT))

        // Dropped-chunk gate: while the assistant is speaking we stop feeding
        // the mic stream into the ASR session. Using a flag (rather than
        // stopping the mic line) keeps the line drained so we never accumulate
        // stale audio, and the VAD starts fresh on the next turn.
        val isSpeaking = AtomicBoolean(false)
        val mic = microphone(MIC_SAMPLE_RATE) { isSpeaking.get() }

        println("▸ Listening. Speak a question and pause. Ctrl+C to quit.\n")

        client.speech.transcribeStream(TranscribeStreamRequest(modelId = asrModelId), mic).collect { response ->
            response.error?.let { error(it) }
            val rawText = response.text ?: return@collect
            if (!isMeaningfulTranscript(rawText)) return@collect
            val userText = rawText.trim()

            println("▸ You: $userText")
            history += QvacMessage.user(userText)

            isSpeaking.set(true)
            try {
                println("▸ Assistant:")
                val run = client.completion.run(modelId = llmModelId, history = history.toList())
                val assistantText = StringBuilder()
                run.events.collect { event ->
                    if (event is QvacCompletionEvent.ContentDelta) {
                        print(event.text)
                        System.out.flush()
                        assistantText.append(event.text)
                    }
                }
                println()
                history += QvacMessage.assistant(assistantText.toString())

                val spoken = assistantText.trim().toString()
                if (spoken.isNotEmpty()) {
                    val speech = client.speech.synthesize(ttsModelId, spoken)
                    val audioData = int16ArrayToBuffer(speech.samples)
                    withContext(Dispatchers.IO) { playAudio(audioData, TTS_SAMPLE_RATE) }
                    // Cooldown keeps the mic gated briefly so speaker tail /
                    // room reverb doesn't feed into the next VAD segment.
                    delay(POST_PLAYBACK_COOLDOWN_MS)
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (turnError: Exception) {
                System.err.println("\n✖ Turn failed: ${turnError.message}")
            } finally {
                isSpeaking.set(false)
                println("\n▸ Listening...\n")
            }
        }
    } finally {
        println("\n\n▸ Stopping...")
        for (modelId in modelIds.asReversed()) {
            runCatching { client.models.unload(modelId) }
        }
        client.close()
        println("▸ Done.")
    }
}

/** Load [model] with [modelConfig] and return its model id. */
private suspend fun QvacClient.loadModel(model: ModelConstant, modelConfig: JsonObject): String {
    val loaded = models.load(model.src, model.engine, model.name, modelConfig = modelConfig)
    return loaded.modelId ?: error(loaded.error ?: "loadModel failed")
}
