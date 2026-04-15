'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const test = require('brittle')
const os = require('bare-os')
const BCIWhispercpp = require('../../index')
const { getTestPaths, computeWER } = require('./helpers')

const { manifest, getSamplePath } = getTestPaths()

const MODEL_PATH = (os.hasEnv('WHISPER_MODEL_PATH') ? os.getEnv('WHISPER_MODEL_PATH') : null) ||
  path.join(__dirname, '..', '..', 'models', 'ggml-tiny.en.bin')

const hasModel = fs.existsSync(MODEL_PATH)

test('[BCI] load and destroy via package interface', { skip: !hasModel, timeout: 120000 }, async (t) => {
  const bci = new BCIWhispercpp({ modelPath: MODEL_PATH }, {
    whisperConfig: { language: 'en', temperature: 0.0 },
    miscConfig: { caption_enabled: false }
  })

  await bci.load()
  t.ok(bci, 'BCIWhispercpp should be created and loaded')

  await bci.destroy()
  t.pass('BCIWhispercpp destroyed successfully')
})

test('[BCI] batch transcription from neural signal file', { skip: !hasModel, timeout: 120000 }, async (t) => {
  if (manifest.samples.length === 0) {
    t.skip('No neural signal test fixtures found')
    return
  }

  const sample = manifest.samples[0]
  const samplePath = getSamplePath(sample.file)
  if (!fs.existsSync(samplePath)) {
    t.skip(`Sample file missing: ${samplePath}`)
    return
  }

  const bci = new BCIWhispercpp({ modelPath: MODEL_PATH }, {
    whisperConfig: { language: 'en', temperature: 0.0 },
    miscConfig: { caption_enabled: false }
  })

  try {
    await bci.load()

    const result = await bci.transcribeFile(samplePath)

    console.log('\n=== Batch Transcription Result ===')
    console.log(`Expected:  "${sample.expected_text}"`)
    console.log(`Got:       "${result.text}"`)

    const wer = computeWER(result.text, sample.expected_text)
    console.log(`WER:       ${(wer * 100).toFixed(1)}%`)

    t.ok(typeof result.text === 'string', 'Should produce a transcription string')
    t.ok(result.segments, 'Should have segments')
    t.ok(typeof wer === 'number' && wer >= 0, 'WER should be a non-negative number')
    console.log('\nNote: High WER expected - standard whisper model is not BCI-trained.')
    console.log('A BCI-trained GGML model is needed for meaningful neural-to-text results.')
  } finally {
    await bci.destroy()
  }
})

