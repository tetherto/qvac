package io.tether.qvac.e2e.runner

import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.PI
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToLong
import kotlin.math.sin

/** Media helpers kept in step with runners/js/shared/wav-pcm.ts and the Python port. */
object Media {
    class DecodedPcm(val sampleRate: Int, val channels: Int, val samplesMono: FloatArray)

    /** Width and height out of a PNG's IHDR, or null if it is not a PNG. */
    fun pngDimensions(data: ByteArray): Pair<Int, Int>? {
        val signature = byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A)
        if (data.size < 24 || !data.copyOfRange(0, 8).contentEquals(signature)) return null
        return bigEndian(data, 16, 4).toInt() to bigEndian(data, 20, 4).toInt()
    }

    /** PNG IHDR or JPEG SOF0..SOF3 dimensions, so both frame encodings are accepted. */
    fun frameDimensions(data: ByteArray): Pair<Int, Int>? {
        pngDimensions(data)?.let { return it }
        if (data.size < 24 || data[0] != 0xFF.toByte() || data[1] != 0xD8.toByte()) return null
        var offset = 2
        while (offset + 9 < data.size) {
            if (data[offset] != 0xFF.toByte()) return null
            val marker = data[offset + 1].toInt() and 0xFF
            val length = bigEndian(data, offset + 2, 2).toInt()
            if (marker in 0xC0..0xC3) {
                val height = bigEndian(data, offset + 5, 2).toInt()
                val width = bigEndian(data, offset + 7, 2).toInt()
                return width to height
            }
            offset += 2 + length
        }
        return null
    }

    private fun bigEndian(data: ByteArray, offset: Int, length: Int): Long {
        var value = 0L
        for (index in offset until offset + length) value = (value shl 8) or (data[index].toLong() and 0xFF)
        return value
    }

    /** 16-bit PCM WAV -> mono float32 in [-1, 1]. */
    fun decodeWavToMonoF32(data: ByteArray): DecodedPcm {
        val buffer = ByteBuffer.wrap(data).order(ByteOrder.LITTLE_ENDIAN)
        fun tag(at: Int) = String(data, at, 4, Charsets.US_ASCII)
        require(data.size >= 12 && tag(0) == "RIFF" && tag(8) == "WAVE") {
            "decodeWavToMonoF32: not a RIFF/WAVE file"
        }
        var offset = 12
        var sampleRate = 0
        var channels = 0
        var bitsPerSample = 0
        var format = 0
        while (offset + 8 <= data.size) {
            val id = tag(offset)
            // Unsigned on disk; clamp to what the buffer holds so a bad header cannot overrun it.
            val size = minOf(buffer.getInt(offset + 4).toLong() and 0xFFFFFFFFL, (data.size - offset - 8).toLong()).toInt()
            val body = offset + 8
            if (id == "fmt ") {
                format = buffer.getShort(body).toInt() and 0xFFFF
                channels = buffer.getShort(body + 2).toInt()
                sampleRate = buffer.getInt(body + 4)
                bitsPerSample = buffer.getShort(body + 14).toInt()
            } else if (id == "data") {
                require(format == 1 || format == 0xFFFE) { "decodeWavToMonoF32: only PCM is supported, got format $format" }
                require(channels > 0) { "decodeWavToMonoF32: no fmt chunk before the data chunk" }
                require(bitsPerSample == 16) {
                    "decodeWavToMonoF32: only 16-bit PCM is supported, got $bitsPerSample-bit"
                }
                val frames = size / 2 / channels
                val mono = FloatArray(frames)
                for (frame in 0 until frames) {
                    var total = 0
                    for (channel in 0 until channels) total += buffer.getShort(body + (frame * channels + channel) * 2)
                    mono[frame] = (total.toDouble() / channels / 32768.0).toFloat()
                }
                return DecodedPcm(sampleRate, channels, mono)
            }
            offset = body + size + (size and 1)
        }
        throw IllegalArgumentException("decodeWavToMonoF32: no data chunk")
    }

    /** Raw little-endian float32, the form the whisper stream takes. */
    fun f32ToLeBytes(samples: FloatArray): ByteArray {
        val out = ByteBuffer.allocate(samples.size * 4).order(ByteOrder.LITTLE_ENDIAN)
        samples.forEach(out::putFloat)
        return out.array()
    }

    /** Signed 16-bit little-endian PCM, the form the parakeet stream takes. */
    fun f32ToS16LeBytes(samples: FloatArray): ByteArray {
        val out = ByteBuffer.allocate(samples.size * 2).order(ByteOrder.LITTLE_ENDIAN)
        for (sample in samples) {
            val clamped = max(-1.0, min(1.0, sample.toDouble()))
            // JS's Math.round: a half rounds toward +Infinity.
            out.putShort(floor(clamped * 32767 + 0.5).toInt().toShort())
        }
        return out.array()
    }

    private val TONE = Regex("""^(\d+(?:\.\d+)?)s-(\d+(?:\.\d+)?)hz$""")
    private const val TONE_SAMPLE_RATE = 48000
    private const val TONE_CHANNELS = 2

    /** Raw interleaved stereo 48 kHz Float32 LE PCM for a named tone: "2s-440hz". */
    fun synthesizeTone(spec: String): ByteArray {
        val match = TONE.matchEntire(spec) ?: throw StepError("tone \"$spec\" is not \"<seconds>s-<frequency>hz\"")
        val seconds = match.groupValues[1].toDouble()
        val frequency = match.groupValues[2].toDouble()
        val frames = (TONE_SAMPLE_RATE * seconds).roundToLong().toInt()
        val out = ByteBuffer.allocate(frames * TONE_CHANNELS * 4).order(ByteOrder.LITTLE_ENDIAN)
        for (frame in 0 until frames) {
            val sample = (0.1 * sin(2 * PI * frequency * frame / TONE_SAMPLE_RATE)).toFloat()
            repeat(TONE_CHANNELS) { out.putFloat(sample) }
        }
        return out.array()
    }

    /** A fixture spelled out in hex: "00010203" is four bytes. */
    fun synthesizeBytes(spec: String): ByteArray {
        if (spec.length % 2 != 0 || !spec.all { it.isDigit() || it.lowercaseChar() in 'a'..'f' }) {
            throw StepError("bytes \"$spec\" is not an even-length hex string")
        }
        return ByteArray(spec.length / 2) { index -> spec.substring(index * 2, index * 2 + 2).toInt(16).toByte() }
    }
}
