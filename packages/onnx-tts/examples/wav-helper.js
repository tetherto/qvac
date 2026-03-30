const fs = require('bare-fs')

// Read a WAV file and return Float32Array of mono samples in [-1, 1].
// Supports 16-bit PCM and 32-bit float; stereo is converted to mono (left channel).
function readWavAsFloat32 (wavPath) {
  const buf = fs.readFileSync(wavPath)
  if (buf.length < 44) throw new Error('WAV file too small')

  // Create DataView - handle both Buffer and Uint8Array
  let arrayBuffer, byteOffset
  if (buf.buffer && buf.byteOffset !== undefined) {
    arrayBuffer = buf.buffer
    byteOffset = buf.byteOffset
  } else {
    // Copy to ArrayBuffer if needed
    arrayBuffer = new ArrayBuffer(buf.length)
    new Uint8Array(arrayBuffer).set(buf)
    byteOffset = 0
  }
  const view = new DataView(arrayBuffer, byteOffset, buf.length)

  // Verify RIFF header
  const riff = String.fromCharCode(buf[0], buf[1], buf[2], buf[3])
  const wave = String.fromCharCode(buf[8], buf[9], buf[10], buf[11])
  if (riff !== 'RIFF') throw new Error('Not a RIFF file')
  if (wave !== 'WAVE') throw new Error('Not WAVE format')

  // Parse chunks
  let fmtChunk = null
  let dataChunk = null
  let offset = 12

  while (offset + 8 <= buf.length) {
    const chunkId = String.fromCharCode(buf[offset], buf[offset + 1], buf[offset + 2], buf[offset + 3])
    const chunkSize = view.getUint32(offset + 4, true)

    if (chunkId === 'fmt ') {
      fmtChunk = { offset: offset + 8, size: chunkSize }
    } else if (chunkId === 'data') {
      dataChunk = { offset: offset + 8, size: chunkSize }
    }

    // Move to next chunk (chunks are word-aligned, so add padding if size is odd)
    offset += 8 + chunkSize
    if (chunkSize % 2 === 1 && offset < buf.length) {
      offset += 1 // padding byte
    }
  }

  if (!fmtChunk) throw new Error('WAV missing fmt chunk')
  if (!dataChunk) throw new Error('WAV missing data chunk')

  // Parse fmt chunk
  const fmtOff = fmtChunk.offset
  if (fmtOff + 16 > buf.length) throw new Error('fmt chunk truncated')

  const audioFormat = view.getUint16(fmtOff, true)
  const numChannels = view.getUint16(fmtOff + 2, true)
  const sampleRate = view.getUint32(fmtOff + 4, true)
  const bitsPerSample = view.getUint16(fmtOff + 14, true)

  // Validate format: 1 = PCM, 3 = IEEE float
  if (audioFormat !== 1 && audioFormat !== 3) {
    throw new Error('Unsupported WAV audio format: ' + audioFormat + ' (only PCM=1 and IEEE_FLOAT=3 supported)')
  }

  const dataOff = dataChunk.offset
  const dataLen = Math.min(dataChunk.size, buf.length - dataOff) // clamp to actual buffer

  let samples
  if (audioFormat === 1 && bitsPerSample === 16) {
    // 16-bit PCM
    const bytesPerSample = 2
    const numSamples = Math.floor(dataLen / bytesPerSample)
    const numFrames = numChannels === 1 ? numSamples : Math.floor(numSamples / numChannels)
    samples = new Float32Array(numFrames)
    for (let i = 0; i < numFrames; i++) {
      const idx = dataOff + (numChannels === 1 ? i * 2 : i * numChannels * 2)
      if (idx + 2 > buf.length) break
      const s = view.getInt16(idx, true)
      samples[i] = s / 32768
    }
  } else if (audioFormat === 1 && bitsPerSample === 24) {
    // 24-bit PCM
    const bytesPerSample = 3
    const numSamples = Math.floor(dataLen / bytesPerSample)
    const numFrames = numChannels === 1 ? numSamples : Math.floor(numSamples / numChannels)
    samples = new Float32Array(numFrames)
    for (let i = 0; i < numFrames; i++) {
      const idx = dataOff + (numChannels === 1 ? i * 3 : i * numChannels * 3)
      if (idx + 3 > buf.length) break
      // Read 24-bit signed little-endian
      const lo = buf[idx]
      const mid = buf[idx + 1]
      const hi = buf[idx + 2]
      let s = (hi << 16) | (mid << 8) | lo
      if (s >= 0x800000) s -= 0x1000000 // sign extend
      samples[i] = s / 8388608
    }
  } else if (audioFormat === 3 && bitsPerSample === 32) {
    // 32-bit IEEE float
    const bytesPerSample = 4
    const numSamples = Math.floor(dataLen / bytesPerSample)
    const numFrames = numChannels === 1 ? numSamples : Math.floor(numSamples / numChannels)
    samples = new Float32Array(numFrames)
    for (let i = 0; i < numFrames; i++) {
      const idx = dataOff + (numChannels === 1 ? i * 4 : i * numChannels * 4)
      if (idx + 4 > buf.length) break
      samples[i] = view.getFloat32(idx, true)
    }
  } else if (audioFormat === 1 && bitsPerSample === 8) {
    // 8-bit PCM (unsigned)
    const numSamples = dataLen
    const numFrames = numChannels === 1 ? numSamples : Math.floor(numSamples / numChannels)
    samples = new Float32Array(numFrames)
    for (let i = 0; i < numFrames; i++) {
      const idx = dataOff + (numChannels === 1 ? i : i * numChannels)
      if (idx >= buf.length) break
      samples[i] = (buf[idx] - 128) / 128
    }
  } else {
    throw new Error('Unsupported WAV format: audioFormat=' + audioFormat + ', bitsPerSample=' + bitsPerSample)
  }

  return { samples, sampleRate, numChannels }
}

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
function resampleLinear (samples, fromRate, toRate) {
  if (fromRate === toRate) return samples
  const ratio = fromRate / toRate
  const outputLen = Math.round(samples.length / ratio)
  const output = new Float32Array(outputLen)
  for (let i = 0; i < outputLen; i++) {
    const srcIdx = i * ratio
    const lo = Math.floor(srcIdx)
    const hi = Math.min(lo + 1, samples.length - 1)
    const frac = srcIdx - lo
    output[i] = samples[lo] * (1 - frac) + samples[hi] * frac
  }
  return output
}

module.exports = {
  createWav,
  readWavAsFloat32,
  resampleLinear
}
