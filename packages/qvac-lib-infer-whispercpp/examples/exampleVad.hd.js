'use strict'

// This dependency is not installed by default. Please make sure to install it before running the example
const WhisperClient = require('../index')
const HyperDriveDL = require('@qvac/dl-hyperdrive')
const fs = require('bare-fs')
const path = require('bare-path')

const audioFilePath = path.join(__dirname, 'samples/sample.raw')
const bitRate = 128000

// To run the following example, VAD and Whisper models need to be hosted under the same key in hyperdrive
async function main () {
  const hdDL = new HyperDriveDL({ key: 'hd://35c5da25696a59d07713c50f0bd3265aea627e62329f9ab469a5dafa962c0605' })

  // Define transcription parameters (mode, output format, etc.)
  const args = {
    loader: hdDL,
    opts: {},
    modelName: 'ggml-tiny.bin',
    diskPath: './models'
  }

  // Define model configuration with whisperConfig
  // VAD model is loaded from local file
  const hdConfig = {
    vadModelPath: path.join(__dirname, 'models/ggml-silero-v5.1.2.bin'), // Use local VAD model
    whisperConfig: {
      language: 'en',
      temperature: 0.0,
      vad_params: {
        threshold: 0.6,
        min_speech_duration_ms: 500,
        min_silence_duration_ms: 300,
        max_speech_duration_s: 15.0,
        speech_pad_ms: 100,
        samples_overlap: 0.2
      }
    },
    contextParams: {
      use_gpu: false
    },
    miscConfig: {
      caption_enabled: false
    }
  }

  // Instantiate the specific Whisper model class
  const model = new WhisperClient(args, hdConfig)

  // Load the model weights and initialize with timeout
  console.log('📥 Loading Whisper model from HyperDrive...')
  const LOAD_TIMEOUT_MS = 60000 // 60 seconds timeout

  const loadPromise = model.load()
  const timeoutPromise = new Promise((_resolve, reject) =>
    setTimeout(() => reject(new Error(`Model loading timeout after ${LOAD_TIMEOUT_MS}ms. Check network connection and HyperDrive availability.`)), LOAD_TIMEOUT_MS)
  )

  try {
    await Promise.race([loadPromise, timeoutPromise])
    console.log('✅ Whisper model loaded successfully')
  } catch (error) {
    console.error('❌ Failed to load model from HyperDrive')
    if (error.message.includes('timeout')) {
      console.error('   The HyperDrive network may be unreachable or the download is taking too long.')
      console.error('   Please check your network connection and try again.')
    }
    throw error
  }

  try {
    // Create a readable stream for the audio file
    const bytesPerSecond = bitRate / 8
    const audioStream = fs.createReadStream(audioFilePath, {
      highWaterMark: bytesPerSecond
    })

    // Run transcription on the audio stream
    const response = await model.run(audioStream)

    // Process the transcription results as they arrive
    await response.onUpdate((output) => {
      console.log('Partial Transcription Response:', output)
    }).await()
  } finally {
    // Unload the model to free resources
    await model.unload()
  }
  console.log('Transcription completed.')
}

main().catch(console.error)
