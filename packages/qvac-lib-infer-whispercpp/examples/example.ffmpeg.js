'use strict'

const fs = require('bare-fs')
const path = require('path')
const process = require('bare-process')
const TranscriptionFfmpegAddon = require('../transcription-ffmpeg')
const HyperDriveDL = require('@qvac/dl-hyperdrive')

/**
 * Example: Using TranscriptionFfmpegAddon with FFmpeg decoder
 *
 * This example demonstrates how to use the TranscriptionFfmpegAddon with the FFmpeg decoder
 * to transcribe audio files. The FFmpeg decoder handles various audio formats and converts
 * them to the format required by Whisper (F32LE, 16kHz, mono).
 *
 * Usage: bare examples/example.ffmpeg.js
 * Default: Uses sample.raw and ggml-tiny.bin from examples directory
 */
async function main () {
  console.log('🎤 TranscriptionFfmpegAddon with FFmpeg Decoder Example')
  console.log('================================================\n')

  const bitRate = 192000 // 192 kbps
  const audioFiles = [
    path.join(__dirname, 'samples/LastQuestion_long_EN.mp3')
    // path.join(__dirname, 'LastQuestion_long_EN.ogg'),
    // path.join(__dirname, 'LastQuestion_long_EN.opus')
  ]

  // Check if files exist
  if (audioFiles.some(audioFile => {
    const fileExists = fs.existsSync(audioFile)
    if (!fileExists) {
      console.error(`❌ Audio file not found: ${audioFile}`)
    }
    return !fileExists
  })) {
    console.error('Please provide a valid audio file path as the first argument')
    process.exit(1)
  }

  console.log(`📁 Audio file: ${audioFiles.join(', ')}`)
  console.log()

  // Create TranscriptionFfmpegAddon configuration
  const addonConfig = {
    loader: new HyperDriveDL({ key: 'hd://35c5da25696a59d07713c50f0bd3265aea627e62329f9ab469a5dafa962c0605' }),
    modelName: 'ggml-tiny.bin',
    diskPath: path.join(__dirname, './models'),
    logger: console,
    params: {
      decoder: {
        streamIndex: 0, // Stream index of the media file
        inputBitrate: 192000 // 192kbps bitrate of the media file, used to calculate the buffer size for the decoder
      }
    }
  }

  // Whisper configuration
  const whisperConfig = {
    contextParams: {
      model: path.join(__dirname, './models/ggml-tiny.bin')
    },
    whisperConfig: {
      language: 'en',
      duration_ms: 0,
      temperature: 0.0,
      vadParams: {
        threshold: 0.6
      }
    },
    miscConfig: {
      caption_enabled: false
    },
    audio_format: 'f32le' // 'f32le' | 's16le'
  }

  // Create TranscriptionFfmpegAddon instance
  console.log('🔧 Creating TranscriptionFfmpegAddon...')
  const transcriptionAddon = new TranscriptionFfmpegAddon(addonConfig, whisperConfig)

  try {
    // Load the model and decoder with timeout
    console.log('📥 Loading model and decoder from HyperDrive...')
    const LOAD_TIMEOUT_MS = 60000 // 60 seconds timeout

    const loadPromise = transcriptionAddon.load()
    const timeoutPromise = new Promise((_resolve, reject) =>
      setTimeout(() => reject(new Error(`Model loading timeout after ${LOAD_TIMEOUT_MS}ms. Check network connection and HyperDrive availability.`)), LOAD_TIMEOUT_MS)
    )

    try {
      await Promise.race([loadPromise, timeoutPromise])
      console.log('✅ Model and decoder loaded successfully\n')
    } catch (error) {
      console.error('❌ Failed to load model from HyperDrive')
      if (error.message.includes('timeout')) {
        console.error('   The HyperDrive network may be unreachable or the download is taking too long.')
        console.error('   Please check your network connection and try again.')
      }
      throw error
    }

    for (const audioFile of audioFiles) {
    // Create audio stream
      console.log('🎵 Creating audio stream...')
      const audioStats = fs.statSync(audioFile)
      console.log(`📏 Audio file size: ${(audioStats.size / 1024).toFixed(2)} KB`)

      // Create a readable stream with appropriate chunk size
      const bytesPerSecond = bitRate / 8

      console.log('🎵 Creating audio stream with highWaterMark:', bytesPerSecond)
      const audioStream = fs.createReadStream(audioFile, {
        highWaterMark: bytesPerSecond
      })

      // Run transcription
      console.log('🚀 Starting transcription...\n')
      const startTime = Date.now()

      const response = await transcriptionAddon.run(audioStream)

      // Collect transcription results
      const transcriptionResults = []

      // Process the response
      await response
        .onUpdate((output) => {
          transcriptionResults.push(output.map(item => item.text).join(''))
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
      console.log('\n' + '='.repeat(50))
      console.log('📄 FINAL TRANSCRIPTION RESULT')
      console.log('='.repeat(50))

      if (transcriptionResults.length > 0) {
        const fullTranscription = transcriptionResults.join(' ').trim()
        console.log(fullTranscription || '(No speech detected)')
      } else {
        console.log('(No transcription output received)')
      }

      console.log('='.repeat(50) + '\n')
    }
  } catch (error) {
    console.error('💥 Fatal error:', error)
    throw error
  } finally {
    // Clean up resources
    console.log('🧹 Cleaning up resources...')

    try {
      await transcriptionAddon.unload()
      console.log('✅ Resources cleaned up successfully')
    } catch (cleanupError) {
      console.error('⚠️  Error during cleanup:', cleanupError)
    }
  }

  console.log('\n🎉 Example completed successfully!')
}

// Run the example
if (require.main === module) {
  main().catch((error) => {
    console.error('\n💀 Example failed:', error)
    process.exit(1)
  })
}

module.exports = main
