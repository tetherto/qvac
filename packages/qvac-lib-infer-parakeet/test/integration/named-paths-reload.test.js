'use strict'

const test = require('brittle')
const path = require('bare-path')
const fs = require('bare-fs')
const binding = require('../../binding')
const TranscriptionParakeet = require('../../index.js')
const {
  setupJsLogger,
  getTestPaths,
  ensureModel,
  createAudioStream,
  validateAccuracy
} = require('./helpers.js')

const { modelPath, samplesDir } = getTestPaths()

const expectedText = 'Alice was beginning to get very tired of sitting by her sister on the bank and of having nothing to do. Once or twice she had peeped into the book her sister was reading, but it had no pictures or conversations in it. And what is the use of a book thought Alice without pictures or conversations'

test('Named paths: reload preserves file paths and transcription still works', { timeout: 600000 }, async (t) => {
  const loggerBinding = setupJsLogger(binding)
  let model = null

  try {
    await ensureModel(modelPath)

    const samplePath = path.join(samplesDir, 'sample.raw')
    if (!fs.existsSync(samplePath)) {
      t.pass('Test skipped - sample audio not found')
      return
    }

    model = new TranscriptionParakeet({
      files: {
        encoder: path.join(modelPath, 'encoder-model.onnx'),
        encoderData: path.join(modelPath, 'encoder-model.onnx.data'),
        decoder: path.join(modelPath, 'decoder_joint-model.onnx'),
        vocab: path.join(modelPath, 'vocab.txt'),
        preprocessor: path.join(modelPath, 'preprocessor.onnx')
      },
      config: {
        parakeetConfig: {
          modelType: 'tdt',
          maxThreads: 4,
          useGPU: false
        }
      },
      exclusiveRun: true
    })

    await model.load()

    async function transcribeToText () {
      const segments = []
      const audioStream = createAudioStream(samplePath)
      const response = await model.run(audioStream)
      await response
        .onUpdate((outputArr) => {
          const items = Array.isArray(outputArr) ? outputArr : [outputArr]
          for (const seg of items) {
            if (seg && seg.text) segments.push(seg)
          }
        })
        .await()
      return segments.map(s => s.text).join(' ').trim().replace(/\s+/g, ' ')
    }

    const textBefore = await transcribeToText()
    t.ok(textBefore.length > 50, 'Transcription after load should produce text')
    const werBefore = validateAccuracy(expectedText, textBefore, 0.35)
    t.ok(werBefore.wer <= 0.35, `WER after load OK (got ${werBefore.werPercent})`)

    await model.reload({ parakeetConfig: { maxThreads: 4 } })

    const textAfter = await transcribeToText()
    t.ok(textAfter.length > 50, 'Transcription after reload should produce text')
    const werAfter = validateAccuracy(expectedText, textAfter, 0.35)
    t.ok(werAfter.wer <= 0.35, `WER after reload OK (got ${werAfter.werPercent})`)
  } finally {
    if (model) {
      try {
        await model.unload()
      } catch (e) {}
    }
    try {
      loggerBinding.releaseLogger()
    } catch (e) {}
  }
})
