'use strict'

// Output-format helpers for @qvac/audiogen-ggml.
//
// The native addon emits raw PCM (interleaved Int16 @ the engine sample rate);
// the requested container/encoding is applied here, at the JS boundary, mirroring
// how tts-ggml keeps the native side format-agnostic. `pcm` and `wav` are
// dependency-free; compressed formats (mp3/ogg/...) would need an encoder and are
// intentionally not bundled yet.

const SUPPORTED_FORMATS = ['pcm', 'wav']

function writeIntLE(buf, value, offset, byteLength) {
  for (let i = 0; i < byteLength; i++) {
    buf[offset + i] = value & 0xff
    value = Math.floor(value / 256)
  }
}

/**
 * Wrap interleaved Int16 PCM in a canonical 16-bit PCM WAV container.
 * @param {Buffer|Uint8Array} pcm Interleaved Int16 little-endian samples.
 * @param {Object} opts
 * @param {number} [opts.sampleRate=48000]
 * @param {number} [opts.channels=2]
 * @returns {Buffer}
 */
function pcmToWav(pcm, { sampleRate = 48000, channels = 2 } = {}) {
  const bytesPerSample = 2
  const blockAlign = channels * bytesPerSample
  const byteRate = sampleRate * blockAlign
  const dataSize = pcm.length
  const out = Buffer.alloc(44 + dataSize)

  out.write('RIFF', 0, 'ascii')
  writeIntLE(out, 36 + dataSize, 4, 4)
  out.write('WAVE', 8, 'ascii')

  out.write('fmt ', 12, 'ascii')
  writeIntLE(out, 16, 16, 4) // fmt chunk size
  writeIntLE(out, 1, 20, 2) // PCM
  writeIntLE(out, channels, 22, 2)
  writeIntLE(out, sampleRate, 24, 4)
  writeIntLE(out, byteRate, 28, 4)
  writeIntLE(out, blockAlign, 32, 2)
  writeIntLE(out, bytesPerSample * 8, 34, 2) // bits per sample

  out.write('data', 36, 'ascii')
  writeIntLE(out, dataSize, 40, 4)
  Buffer.from(pcm.buffer ? pcm.buffer : pcm, pcm.byteOffset || 0, dataSize).copy(out, 44)

  return out
}

/**
 * Encode interleaved Int16 PCM into the requested output format.
 * @param {Buffer|Uint8Array} pcm
 * @param {'pcm'|'wav'} format
 * @param {Object} opts sampleRate / channels
 * @returns {{ data: Buffer, extension: string }}
 */
function encodePcm(pcm, format, opts = {}) {
  const fmt = String(format || 'wav').toLowerCase()
  if (fmt === 'pcm') {
    return { data: Buffer.from(pcm), extension: 'pcm' }
  }
  if (fmt === 'wav') {
    return { data: pcmToWav(pcm, opts), extension: 'wav' }
  }
  throw new Error(
    `Unsupported outputFormat "${format}". Supported: ${SUPPORTED_FORMATS.join(', ')}. ` +
      'Compressed formats (mp3/ogg/...) require an external encoder and are not bundled.'
  )
}

module.exports = { SUPPORTED_FORMATS, pcmToWav, encodePcm }
