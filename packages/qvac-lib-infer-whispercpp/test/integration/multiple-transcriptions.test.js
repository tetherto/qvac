const test = require('brittle')
const path = require('bare-path')
const fs = require('bare-fs')
const TranscriptionWhispercpp = require('../../index')
const FakeDL = require('../mocks/loader.fake')
const { ensureWhisperModel, getTestPaths, createAudioStream } = require('./helpers.js')

test('Multiple consecutive transcriptions should work without errors', async (t) => {
  t.plan(3)

  // Use standardized test paths
  const { modelPath } = getTestPaths()
  const audioPath = path.join(__dirname, '../../examples/samples/sample.raw')

  // Ensure model is available
  await ensureWhisperModel(modelPath)

  t.ok(fs.existsSync(modelPath), 'Model file should exist')
  t.ok(fs.existsSync(audioPath), 'Audio file should exist')

  const modelsDir = path.dirname(modelPath)
  const loader = new FakeDL({})

  const args = {
    loader,
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    modelName: 'ggml-tiny.bin',
    diskPath: modelsDir
  }

  const config = {
    path: modelPath,
    whisperConfig: {
      language: 'en'
    }
  }

  const model = new TranscriptionWhispercpp(args, config)
  await model.load()

  const numTranscriptions = 3
  console.log(`\n=== Starting ${numTranscriptions} consecutive transcriptions ===\n`)

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
    console.log(`Full text: ${transcriptText}`)

    await new Promise(resolve => setTimeout(resolve, 100))
  }

  console.log(`\n=== All ${numTranscriptions} transcriptions completed ===\n`)
  t.ok(true, 'All transcriptions completed without errors')

  console.log('Calling model.unload()...')
  await model.unload()
  console.log('model.unload() completed')

  console.log('Calling model.destroy()...')
  await model.destroy()
  console.log('model.destroy() completed')

  console.log('Test finished')
})
