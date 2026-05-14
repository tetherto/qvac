'use strict'

const test = require('brittle')
const path = require('bare-path')
const fs = require('bare-fs')
const os = require('bare-os')
const TranscriptionWhispercpp = require('../../index')
const { ensureWhisperModel, getAssetPath, createAudioStream, isMobile } = require('./helpers.js')

// On mobile, runs fewer transcriptions to avoid memory pressure
test('Multiple consecutive transcriptions should work without errors', { timeout: 300000 }, async (t) => {
  const numTranscriptions = 3

  t.plan(3)

  const modelsDir = isMobile ? path.join(global.testDir || os.tmpdir(), 'models') : path.resolve(__dirname, '../../models')
  const modelPath = path.join(modelsDir, 'ggml-tiny.bin')

  // Create models directory if needed
  if (!fs.existsSync(modelsDir)) {
    fs.mkdirSync(modelsDir, { recursive: true })
  }

  const modelResult = await ensureWhisperModel(modelPath)
  if (!modelResult.success) {
    console.log('⚠️ Model not available, skipping test')
    t.pass('Model not available')
    t.pass('Skipped')
    t.pass('Skipped')
    return
  }

  // Get audio path - uses getAssetPath for mobile compatibility
  let audioPath
  try {
    audioPath = getAssetPath('sample.raw')
  } catch (e) {
    console.log('⚠️ Audio file not available, skipping test')
    t.pass('Audio not available')
    t.pass('Skipped')
    t.pass('Skipped')
    return
  }

  t.ok(fs.existsSync(modelPath), 'Model file should exist')
  t.ok(fs.existsSync(audioPath), 'Audio file should exist')

  const args = {
    files: {
      model: modelPath
    },
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
  }

  const config = {
    path: modelPath,
    whisperConfig: {
      language: 'en'
    }
  }

  let model
  try {
    model = new TranscriptionWhispercpp(args, config)
    await model.load()

    console.log(`\n=== Starting ${numTranscriptions} consecutive transcriptions (${isMobile ? 'mobile' : 'desktop'}) ===\n`)

    for (let i = 0; i < numTranscriptions; i++) {
      console.log(`\n--- Transcription ${i + 1}/${numTranscriptions} ---`)

      // Use createAudioStream helper to avoid fs.createReadStream bug
      const audioStream = createAudioStream(audioPath)

      const response = await model.run(audioStream)

      let transcriptText = ''
      await response.onUpdate((output) => {
        console.log('Transcription onUpdate:', output)
        if (Array.isArray(output)) {
          for (const segment of output) {
            if (segment.text) {
              transcriptText += segment.text
            }
          }
        }
      }).await()

      console.log(`Transcription ${i + 1} completed`)
      console.log(`Text length: ${transcriptText.length}`)

      // Small delay between runs to allow memory cleanup
      await new Promise(resolve => setTimeout(resolve, 200))
    }

    console.log(`\n=== All ${numTranscriptions} transcriptions completed ===\n`)
    t.ok(true, 'All transcriptions completed without errors')
  } finally {
    if (model) {
      console.log('Calling model.unload()...')
      try {
        await model.unload()
        console.log('model.unload() completed')
      } catch (e) {
        console.log('model.unload() error:', e.message)
      }

      console.log('Calling model.destroy()...')
      try {
        await model.destroy()
        console.log('model.destroy() completed')
      } catch (e) {
        console.log('model.destroy() error:', e.message)
      }
    }
    console.log('Test finished')
  }
})
