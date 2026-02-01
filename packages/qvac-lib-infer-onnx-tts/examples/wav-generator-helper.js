const fs = require('bare-fs')

// Helper: write a little-endian integer
function writeIntLE (buffer, value, offset, byteLength) {
  for (let i = 0; i < byteLength; i++) {
    buffer[offset + i] = value & 0xff
    value >>= 8
  }
}

// Generate WAV file (16-bit PCM mono)
function createWav (samples, sampleRate = 16000, outputPath = 'test.wav') {
  const numChannels = 1
  const bytesPerSample = 2 // 16-bit PCM
  const blockAlign = numChannels * bytesPerSample
  const byteRate = sampleRate * blockAlign
  const dataSize = samples.length * bytesPerSample
  const buffer = new Uint8Array(44 + dataSize)

  // RIFF header
  buffer.set([0x52, 0x49, 0x46, 0x46], 0) // "RIFF"
  writeIntLE(buffer, 36 + dataSize, 4, 4) // file size - 8
  buffer.set([0x57, 0x41, 0x56, 0x45], 8) // "WAVE"

  // fmt chunk
  buffer.set([0x66, 0x6d, 0x74, 0x20], 12) // "fmt "
  writeIntLE(buffer, 16, 16, 4) // Subchunk1Size
  writeIntLE(buffer, 1, 20, 2) // AudioFormat = PCM
  writeIntLE(buffer, numChannels, 22, 2)
  writeIntLE(buffer, sampleRate, 24, 4)
  writeIntLE(buffer, byteRate, 28, 4)
  writeIntLE(buffer, blockAlign, 32, 2)
  writeIntLE(buffer, bytesPerSample * 8, 34, 2) // bits per sample

  // data chunk
  buffer.set([0x64, 0x61, 0x74, 0x61], 36) // "data"
  writeIntLE(buffer, dataSize, 40, 4)

  // write PCM samples - samples are already int16 values from the TTS output
  for (let i = 0; i < samples.length; i++) {
    // Clamp the int16 value to valid range and write as little-endian
    const sample = Math.max(-32768, Math.min(32767, samples[i]))
    // Convert to unsigned for proper bit manipulation
    const unsignedSample = sample < 0 ? sample + 65536 : sample
    writeIntLE(buffer, unsignedSample, 44 + i * 2, 2)
  }

  fs.writeFileSync(outputPath, buffer)
}
module.exports = {
  createWav
}
