// Kotlin port of packages/sdk/examples/asr/parakeet-sortformer.ts.
//
// Parakeet Sortformer diarization + TDT transcription pipeline. Two-step flow:
// Sortformer v2.1 diarizes the audio, then TDT transcribes each speaker segment.
// Defaults to registry GGUFs. A multi-speaker sample is in the QVAC source repo:
//   https://github.com/tetherto/qvac/blob/main/packages/sdk/examples/audio/diarization-sample-16k.wav
//
// As in TypeScript, `client.speech.transcribe()` returns the joined text. The
// JDK's `javax.sound.sampled.AudioSystem` reads the PCM and writes each segment
// as its own WAV (Python uses the standard-library `wave` module; TypeScript
// parses the header by hand).
//
// Audio should be 16 kHz mono 16-bit PCM in a WAV container.
//
// RUN: ./gradlew run -Pexample=TranscriptionParakeetSortformer --args="<wav-file> [sortformer-gguf]"

import io.tether.qvac.sdk.JvmBareRpcTransport
import io.tether.qvac.sdk.QvacClient
import io.tether.qvac.sdk.QvacDataInput
import io.tether.qvac.sdk.generated.Models
import io.tether.qvac.sdk.models
import io.tether.qvac.sdk.speech
import java.io.ByteArrayInputStream
import java.io.File
import java.nio.file.Files
import javax.sound.sampled.AudioFileFormat
import javax.sound.sampled.AudioFormat
import javax.sound.sampled.AudioInputStream
import javax.sound.sampled.AudioSystem
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.min
import kotlin.system.exitProcess
import kotlinx.coroutines.runBlocking

private const val SAMPLE_RATE = 16000
private const val BYTES_PER_SAMPLE = 2
private val SEGMENT_PATTERN = Regex("""Speaker (\d+): ([\d.]+)s - ([\d.]+)s""")

private data class Segment(val speaker: Int, val start: Double, val end: Double)

private data class Entry(val speaker: Int, val start: Double, val end: Double, val text: String)

fun main(args: Array<String>): Unit = runBlocking {
    if (args.isEmpty()) {
        System.err.println(
            "Usage: ./gradlew run -Pexample=TranscriptionParakeetSortformer --args=\"<wav-file> [sortformer-gguf]\"",
        )
        System.err.println("\nIf the model path is omitted, defaults to the registry model.")
        exitProcess(1)
    }
    val audioPath = args[0]
    val sortformerSrc = args.getOrNull(1) ?: Models.PARAKEET_SORTFORMER_4SPK_V2_1_Q8_0.src

    val client = QvacClient(JvmBareRpcTransport.connectResolved(installWorkerIfMissing = true))
    try {
        // ── Step 1: Diarize with Sortformer ──

        val sfModelId = client.loadModel(sortformerSrc, "parakeet-transcription")
        val diarization = client.speech.transcribe(sfModelId, QvacDataInput.FilePath(audioPath)).text
        client.models.unload(sfModelId)

        val segments = parseDiarization(diarization)

        // ── Step 2: Transcribe each segment with TDT ──

        val tdtModelId = client.loadModel(Models.PARAKEET_TDT_0_6B_V3_Q8_0.src, "parakeet-transcription")

        val pcm = readPcm(audioPath)
        val results = mutableListOf<Entry>()
        val sliceDir = Files.createTempDirectory("qvac-diarize-").toFile()
        try {
            for ((index, seg) in segments.withIndex()) {
                val slicePath = File(sliceDir, "seg-$index.wav")

                if (!writeWavSlice(pcm, seg.start, seg.end, slicePath)) {
                    results += Entry(seg.speaker, seg.start, seg.end, "[No speech detected]")
                    continue
                }

                val text = client.speech.transcribe(tdtModelId, QvacDataInput.FilePath(slicePath.path)).text
                results += Entry(seg.speaker, seg.start, seg.end, text.trim().ifEmpty { "[No speech detected]" })
            }
        } finally {
            sliceDir.deleteRecursively()
        }

        client.models.unload(tdtModelId)

        // ── Step 3: Merge consecutive same-speaker segments and print ──

        println("\n▸ Diarized transcription")
        for (entry in mergeSpeakers(results)) {
            println("Speaker ${entry.speaker} (%.2fs - %.2fs):".format(entry.start, entry.end))
            println("  ${entry.text}\n")
        }
        println("▸ Done")
    } finally {
        client.close()
    }
}

private fun parseDiarization(text: String): List<Segment> =
    SEGMENT_PATTERN.findAll(text)
        .map { m ->
            val (speaker, start, end) = m.destructured
            Segment(speaker.toInt(), start.toDouble(), end.toDouble())
        }
        .sortedBy { it.start }
        .toList()

private fun readPcm(wavPath: String): ByteArray =
    AudioSystem.getAudioInputStream(File(wavPath)).use { it.readAllBytes() }

private fun writeWavSlice(pcm: ByteArray, startSec: Double, endSec: Double, outPath: File): Boolean {
    val startByte = floor(startSec * SAMPLE_RATE).toInt() * BYTES_PER_SAMPLE
    val endByte = min(ceil(endSec * SAMPLE_RATE).toInt() * BYTES_PER_SAMPLE, pcm.size)
    if (startByte >= endByte) return false

    val format = AudioFormat(SAMPLE_RATE.toFloat(), BYTES_PER_SAMPLE * 8, 1, true, false)
    val slice = pcm.copyOfRange(startByte, endByte)
    AudioInputStream(ByteArrayInputStream(slice), format, (slice.size / BYTES_PER_SAMPLE).toLong()).use { stream ->
        AudioSystem.write(stream, AudioFileFormat.Type.WAVE, outPath)
    }
    return true
}

private fun mergeSpeakers(entries: List<Entry>): List<Entry> {
    val merged = mutableListOf<Entry>()
    for (entry in entries) {
        val last = merged.lastOrNull()
        if (last != null && last.speaker == entry.speaker) {
            merged[merged.lastIndex] = last.copy(text = last.text + " " + entry.text, end = entry.end)
        } else {
            merged += entry
        }
    }
    return merged
}

/** Load [source] as [modelType] and return its model id. */
private suspend fun QvacClient.loadModel(source: String, modelType: String): String {
    val loaded = models.load(source, modelType)
    return loaded.modelId ?: error(loaded.error ?: "loadModel failed")
}
