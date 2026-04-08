'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const process = require('bare-process')
const TranscriptionWhispercpp = require('../index.js')
const FakeDL = require('../test/mocks/loader.fake.js')

// Usage: node examples/example.reload.js [audioPath] [modelPath]
// Demonstrates reloading the model with different configurations
// This example transcribes the same audio twice with different language settings

async function main () {
  const args = process.argv.slice(2)
  const [audioPathArg, modelPathArg] = args

  const modelsDir = path.join(__dirname, '..', 'models')
  const audioFilePath = audioPathArg || path.join(__dirname, 'samples', 'sample.raw')
  const modelPath = modelPathArg || path.join(modelsDir, 'ggml-tiny.bin')

  if (!fs.existsSync(modelPath)) {
    console.error(`Model file not found at ${modelPath}. Download or provide a path as the second argument.`)
    process.exit(1)
  }
  if (!fs.existsSync(audioFilePath)) {
    console.error(`Audio file not found at ${audioFilePath}. Provide a path as the first argument.`)
    process.exit(1)
  }

  console.log('='.repeat(60))
  console.log('RELOAD EXAMPLE: Changing Language Configuration')
  console.log('='.repeat(60))
  console.log(`Audio: ${audioFilePath}`)
  console.log(`Model: ${modelPath}\n`)

  // Constructor arguments for TranscriptionWhispercpp
  const constructorArgs = {
    modelName: modelPathArg || 'ggml-tiny.bin',
    loader: new FakeDL({}),
    diskPath: modelsDir
  }

  // Initial configuration with English language
  const config = {
    opts: { stats: true },
    whisperConfig: {
      audio_format: 's16le',
      vad_model_path: path.join(modelsDir, 'ggml-silero-v5.1.2.bin'),
      vad_params: {
        threshold: 0.35,
        min_speech_duration_ms: 200,
        min_silence_duration_ms: 150,
        max_speech_duration_s: 30,
        speech_pad_ms: 600,
        samples_overlap: 0.3
      },
      language: 'en',
      temperature: 0.0
    }
  }

  const model = new TranscriptionWhispercpp(constructorArgs, config)

  // Load the model
  console.log('📦 Loading model...')
  await model._load()
  console.log('✅ Model loaded successfully\n')

  // First transcription with English
  console.log('─'.repeat(60))
  console.log('FIRST RUN: English Configuration (language: en)')
  console.log('─'.repeat(60))

  const transcription1 = await transcribeAudio(model, audioFilePath)

  console.log('\n📝 English Transcription Result:')
  console.log(transcription1)
  console.log()

  // Reload with Spanish configuration
  console.log('─'.repeat(60))
  console.log('RELOADING: Changing to Spanish Configuration')
  console.log('─'.repeat(60))
  console.log('🔄 Reloading model with new configuration...')

  await model.reload({
    whisperConfig: {
      language: 'es',
      temperature: 0.2
    }
  })

  console.log('✅ Model reloaded with Spanish configuration\n')

  // Second transcription with Spanish
  console.log('─'.repeat(60))
  console.log('SECOND RUN: Spanish Configuration (language: es)')
  console.log('─'.repeat(60))

  const transcription2 = await transcribeAudio(model, audioFilePath)

  console.log('\n📝 Spanish Transcription Result:')
  console.log(transcription2)
  console.log()

  // Reload with different temperature
  console.log('─'.repeat(60))
  console.log('RELOADING: Changing Temperature Setting')
  console.log('─'.repeat(60))
  console.log('🔄 Reloading model with higher temperature...')

  await model.reload({
    whisperConfig: {
      language: 'en',
      temperature: 0.8
    }
  })

  console.log('✅ Model reloaded with temperature: 0.8\n')

  // Third transcription with higher temperature
  console.log('─'.repeat(60))
  console.log('THIRD RUN: English with Higher Temperature (temp: 0.8)')
  console.log('─'.repeat(60))

  const transcription3 = await transcribeAudio(model, audioFilePath)

  console.log('\n📝 English (High Temp) Transcription Result:')
  console.log(transcription3)
  console.log()

  // Cleanup
  await model.destroy()

  console.log('='.repeat(60))
  console.log('SUMMARY')
  console.log('='.repeat(60))
  console.log('✅ Successfully demonstrated model reload functionality')
  console.log('   - Initial run with English (temp: 0.0)')
  console.log('   - Reloaded and ran with Spanish (temp: 0.2)')
  console.log('   - Reloaded and ran with English (temp: 0.8)')
  console.log('\n💡 The reload() method allows you to change configuration')
  console.log('   without destroying and recreating the entire instance.')
  console.log('='.repeat(60))
}

async function transcribeAudio (model, audioFilePath) {
  const bitRate = 128000
  const bytesPerSecond = bitRate / 8
  const audioStream = fs.createReadStream(audioFilePath, { highWaterMark: bytesPerSecond })

  const streamingChunks = []
  const response = await model.run(audioStream)

  response.onUpdate((outputArr) => {
    const items = Array.isArray(outputArr) ? outputArr : [outputArr]
    streamingChunks.push(...items)
    const last = items[items.length - 1]
    if (last && last.text) {
      console.log(`   [${last.start?.toFixed(2)}s → ${last.end?.toFixed(2)}s] ${last.text}`)
    }
  })

  const full = []
  for await (const output of response.iterate()) {
    const items = Array.isArray(output) ? output : [output]
    full.push(...items)
  }

  if (full.length) {
    return full.map(s => s.text).join(' ').trim()
  } else {
    return '(No transcription output received)'
  }
}

main().catch(err => {
  console.error('❌ Error:', err)
  process.exit(1)
})
