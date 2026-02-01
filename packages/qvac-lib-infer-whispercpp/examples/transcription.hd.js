'use strict'

const TranscriptionWhispercpp = require('../index')
const HyperDriveDL = require('@qvac/dl-hyperdrive')
const fs = require('bare-fs')
const path = require('bare-path')

const audioFilePath = path.join(__dirname, 'samples/decodedFile.raw')
const bitRate = 128000

async function main () {
  // Instantiate Hyperdrive Loader with the specific model key
  const hdDL = new HyperDriveDL({
    key: 'hd://35c5da25696a59d07713c50f0bd3265aea627e62329f9ab469a5dafa962c0605'
  })

  // Constructor arguments
  const args = {
    loader: hdDL,
    modelName: 'ggml-tiny.bin',
    diskPath: './models'
  }

  // Configuration for transcription
  const hdConfig = {
    audio_format: 'f32le', // decodedFile.raw contains 32-bit float samples
    whisperConfig: {
      duration_ms: 0,
      language: 'en',
      temperature: 0.0
    },
    contextParams: {
      use_gpu: false
    },
    miscConfig: {
      caption_enabled: false
    }
  }

  const model = new TranscriptionWhispercpp(args, hdConfig)

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
    // Check if audio file exists
    if (!fs.existsSync(audioFilePath)) {
      throw new Error(`Audio file not found: ${audioFilePath}`)
    }

    const audioStats = fs.statSync(audioFilePath)
    console.log('\n🎧 Starting transcription...')
    console.log(`📁 Audio file: ${audioFilePath}`)
    console.log(`📏 Audio file size: ${(audioStats.size / 1024).toFixed(2)} KB`)

    // Create a readable stream for the audio file
    const bytesPerSecond = bitRate / 8
    const audioStream = fs.createReadStream(audioFilePath, {
      highWaterMark: bytesPerSecond
    })

    console.log(`🔊 Stream created with highWaterMark: ${bytesPerSecond} bytes/sec\n`)

    // Run transcription on the audio stream
    console.log('🚀 Starting transcription...')
    const startTime = Date.now()
    const response = await model.run(audioStream)

    const transcriptionResults = []

    // Process the transcription results as they arrive
    await response
      .onUpdate(output => {
        console.log('📝 Streaming Transcription Update:', output)
        transcriptionResults.push(output)
      })
      .onFinish(() => {
        const duration = Date.now() - startTime
        console.log(`\n⏱️  Transcription completed in ${(duration / 1000).toFixed(2)} seconds`)
      })
      .onError((error) => {
        console.error('❌ Transcription error:', error)
      })
      .await()

    // Display final results
    console.log('\n' + '='.repeat(60))
    console.log('📄 FINAL TRANSCRIPTION RESULT')
    console.log('='.repeat(60))

    if (transcriptionResults.length > 0) {
      const fullText = transcriptionResults.flat().map(item => item.text).join(' ').trim()
      console.log(fullText || '(No speech detected)')
    } else {
      console.log('(No transcription output received)')
    }

    console.log('='.repeat(60) + '\n')
  } finally {
    // Unload the model to free resources
    console.log('🧹 Unloading model...')
    await model.unload()
    console.log('✅ Model unloaded successfully')
  }
  console.log('🎉 Transcription completed.')
}

main().catch(console.error)
