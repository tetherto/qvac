require('./constants.cjs')
const ONNXTTS = require('@qvac/tts-onnx')
const HyperDriveDL = require('@qvac/dl-hyperdrive')
const fs = require('bare-fs')
const path = require('bare-path')
const TranscriptionWhispercpp = require('@qvac/transcription-whispercpp')
const { Readable } = require('bare-stream')

async function _downloadEspeakData() {
    const eSpeakDataPath = path.join(dirPath, 'espeak-ng-data')

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

    return eSpeakDataPath
}

async function _loadModel() {
    const eSpeakDataPath = await _downloadEspeakData()

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
        language: 'en-us'
    }

    const model = new ONNXTTS(args, config)

    await model.load()

    return model
}

async function _runTTS(model, text) {
    const response = await model.run({
        input: text,
        type: 'text'
    })

    let buffer = []
    await response
        .onUpdate(data => {
            if (data && data.outputArray) {
                buffer = buffer.concat(Array.from(data.outputArray))
            }
        })
        .await()

    return buffer
}

function _writeIntLE(buffer, value, offset, byteLength) {
    for (let i = 0; i < byteLength; i++) {
      buffer[offset + i] = value & 0xff
      value >>= 8
    }
}

function _createWav(samples, sampleRate = 22050) {
    const numChannels = 1
    const bytesPerSample = 2 // 16-bit PCM
    const blockAlign = numChannels * bytesPerSample
    const byteRate = sampleRate * blockAlign
    const dataSize = samples.length * bytesPerSample
    const buffer = new Uint8Array(44 + dataSize)
  
    // RIFF header
    buffer.set([0x52, 0x49, 0x46, 0x46], 0) // "RIFF"
    _writeIntLE(buffer, 36 + dataSize, 4, 4) // file size - 8
    buffer.set([0x57, 0x41, 0x56, 0x45], 8) // "WAVE"
  
    // fmt chunk
    buffer.set([0x66, 0x6d, 0x74, 0x20], 12) // "fmt "
    _writeIntLE(buffer, 16, 16, 4) // Subchunk1Size
    _writeIntLE(buffer, 1, 20, 2) // AudioFormat = PCM
    _writeIntLE(buffer, numChannels, 22, 2)
    _writeIntLE(buffer, sampleRate, 24, 4)
    _writeIntLE(buffer, byteRate, 28, 4)
    _writeIntLE(buffer, blockAlign, 32, 2)
    _writeIntLE(buffer, bytesPerSample * 8, 34, 2) // bits per sample
  
    // data chunk
    buffer.set([0x64, 0x61, 0x74, 0x61], 36) // "data"
    _writeIntLE(buffer, dataSize, 40, 4)
  
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

async function _transcribeAudio(text, samples) {
  //convert samples to pcm buffer
  const pcmBuffer = new Uint8Array(samples.length * 2)

  for (let i = 0; i < samples.length; i++) {
    const sample = Math.max(-32768, Math.min(32767, samples[i]))
    pcmBuffer[i * 2] = sample & 0xFF        // low byte
    pcmBuffer[i * 2 + 1] = (sample >> 8) & 0xFF  // high byte
  }

  const hdDL = new HyperDriveDL({ key: 'hd://ebfb94b378276da139554668f1ff737644eadff529c2ea0f2662d7df61fd86ca' })
  const constructorArgs = {
    modelName: 'ggml-tiny.bin',
    loader: hdDL,
    diskPath: `${dirPath}whisper`
  }

  const config = {
    opts: { stats: true },
    whisperConfig: {
      audio_format: 's16le',
      language: 'en'
    }
  }

  const whisperModel = new TranscriptionWhispercpp(constructorArgs, config)
  await whisperModel._load()
  console.log('>>> [WHISPER] Model loaded')

  const audioStream = new Readable({
    read() {
      this.push(pcmBuffer)
      this.push(null)
    }
  })

  const response = await whisperModel.run(audioStream)
  const transcription = await _streamResponse(response)
  await whisperModel.destroy()
  console.log('>>> [WHISPER] Transcription completed', transcription)
  const wer = _wordErrorRate(text, transcription)
  console.log('>>> [WHISPER] Word Error Rate', wer)
  if (wer > 0.3) {
    console.log(`Word Error Rate is too high: ${wer} for text: \'${text}\'`)
    // throw new Error(`Word Error Rate is too high: ${wer} for text: \'${text}\'`)
  }

  return { transcription, wer }
}

async function _streamResponse(response) {
  let fullText = ''
  await response.onUpdate((output) => {
      if (Array.isArray(output)) {
          for (const item of output) {
              if (item.text) {
                  fullText += item.text
              }
          }
      }
  }).await()
  return fullText
}

function _wordErrorRate(expected, actual) {
  const r = expected.split(/\s+/);
  const h = actual.split(/\s+/);
  const d = Array(r.length + 1)
    .fill(null)
    .map(() => Array(h.length + 1).fill(0));

  for (let i = 0; i <= r.length; i++) d[i][0] = i;
  for (let j = 0; j <= h.length; j++) d[0][j] = j;

  for (let i = 1; i <= r.length; i++) {
    for (let j = 1; j <= h.length; j++) {
      const cost = r[i - 1] === h[j - 1] ? 0 : 1;
      d[i][j] = Math.min(
        d[i - 1][j] + 1, // deletion
        d[i][j - 1] + 1, // insertion
        d[i - 1][j - 1] + cost // substitution
      );
    }
  }

  const wer = d[r.length][h.length] / r.length;
  return wer;
}
