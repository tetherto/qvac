/* global dirPath */
const ONNXTTS = require('@qvac/tts-onnx')
const HyperDriveDL = require('@qvac/dl-hyperdrive')
const fs = require('bare-fs')
const path = require('bare-path')

let eSpeakDataPath = null

// Helper: write a little-endian integer
function writeIntLE (buffer, value, offset, byteLength) {
  for (let i = 0; i < byteLength; i++) {
    buffer[offset + i] = value & 0xff
    value >>= 8
  }
}

// Generate WAV file (16-bit PCM mono) with correct sample rate for TTS
function _createWav (samples, sampleRate = 22050) { // Changed default to 22kHz (common TTS rate)
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
    // Clamp the int16 value to valid range
    const sample = Math.max(-32768, Math.min(32767, samples[i]))

    // Write as signed 16-bit little-endian (no unsigned conversion needed)
    const lowByte = sample & 0xFF
    const highByte = (sample >> 8) & 0xFF

    buffer[44 + i * 2] = lowByte
    buffer[44 + i * 2 + 1] = highByte
  }

  return buffer
}

async function testTts () {
  // DOWNLOAD ESPEAK DATA
  eSpeakDataPath = path.join(dirPath, 'espeak-ng-data')

  const loader = new HyperDriveDL({ key: 'hd://c00ea8bc3d250968943ecab83e39b22828c2ad7995b159d8aedcb0f3fef81894' })
  try {
    await loader.ready()
    console.log('>>> [DOWNLOADER] Hyperdrive ready')
    const files = await loader.list()
    const keys = files.map(f => f.key)
    console.log(`>>> [DOWNLOADER] Found ${keys.length} files to download.`)

    for (const key of keys) {
      const fullPath = path.join(eSpeakDataPath, key)
      if (fs.existsSync(fullPath)) {
        continue
      }
      const newDirName = path.dirname(fullPath)
      fs.mkdirSync(newDirName, { recursive: true })
      const response = await loader.download(key, { diskPath: newDirName })
      await response.await()
    }
    console.log('>>> [DOWNLOADER] All eSpeak data files downloaded successfully.')
    await loader.close()
  } catch (err) {
    console.error('>>> [DOWNLOADER] Error during download:', err)
    throw err
  } finally {
    if (loader) {
      await loader.close()
    }
  }
  // DOWNLOAD ESPEAK DATA ENDS HERE

  const hdDL = new HyperDriveDL({ key: 'hd://69581b1431e3abceec7708187922025dec6ccccd291c9e804679fd21371ccd1b' })
  const args = {
    loader: hdDL,
    mainModelUrl: 'model.onnx',
    configJsonPath: 'config.json',
    cache: dirPath,
    opts: { stats: true },
    eSpeakDataPath
  }
  const config = {
    language: 'en'
  }

  const model = new ONNXTTS(args, config)

  await model.load()

  const textToSynthesize = 'Hello world! This is a test of the TTS system using the ONNX base pattern.'
  console.log(`Running TTS on: "${textToSynthesize}"`)

  const response = await model.run({
    input: textToSynthesize,
    type: 'text'
  })

  let buffer = []
  console.log('Waiting for TTS results...')
  await response
    .onUpdate(data => {
      console.log('--- TTS Update ---')
      if (data && data.outputArray) {
        buffer = buffer.concat(Array.from(data.outputArray))
      }
      console.log('------------------')
    })
    .await() // Wait for the final result

  if (buffer.length === 0) {
    throw new Error('No audio data received')
  }

  const wavBuffer = _createWav(buffer)
  const audioData = Buffer.from(wavBuffer).toString('base64')
  return { audioData }
}

module.exports = { testTts }
