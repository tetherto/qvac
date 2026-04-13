'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const test = require('brittle')
const os = require('bare-os')
const BCIWhispercpp = require('../../index')
const { getTestPaths, computeWER, detectPlatform } = require('./helpers')

const platform = detectPlatform()
const { manifest, getSamplePath } = getTestPaths()

const MODEL_PATH = (os.hasEnv('WHISPER_MODEL_PATH') ? os.getEnv('WHISPER_MODEL_PATH') : null) ||
  path.join(__dirname, '..', '..', 'models', 'ggml-tiny.en.bin')

const hasModel = fs.existsSync(MODEL_PATH)

test('[BCI] load and destroy via package interface', { skip: !hasModel }, async (t) => {
  const bci = new BCIWhispercpp({ modelPath: MODEL_PATH }, {
    whisperConfig: { language: 'en', temperature: 0.0 },
    miscConfig: { caption_enabled: false }
  })

  await bci.load()
  t.ok(bci, 'BCIWhispercpp should be created and loaded')

  await bci.destroy()
  t.pass('BCIWhispercpp destroyed successfully')
})

test('[BCI] batch transcription from neural signal file', { skip: !hasModel }, async (t) => {
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

test('[BCI] streaming transcription from neural signal chunks', { skip: !hasModel }, async (t) => {
  if (manifest.samples.length === 0) {
    t.skip('No neural signal test fixtures found')
    return
  }

  const sample = manifest.samples[1] || manifest.samples[0]
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

    const fullData = fs.readFileSync(samplePath)
    const chunkSize = Math.ceil(fullData.length / 3)

    async function * generateChunks () {
      for (let i = 0; i < fullData.length; i += chunkSize) {
        const end = Math.min(i + chunkSize, fullData.length)
        yield new Uint8Array(fullData.buffer, fullData.byteOffset + i, end - i)
      }
    }

    const result = await bci.transcribeStream(generateChunks())

    console.log('\n=== Streaming Transcription Result ===')
    console.log(`Expected:  "${sample.expected_text}"`)
    console.log(`Got:       "${result.text}"`)

    const wer = computeWER(result.text, sample.expected_text)
    console.log(`WER:       ${(wer * 100).toFixed(1)}%`)

    t.ok(typeof result.text === 'string', 'Streaming should produce transcription')
    t.ok(typeof wer === 'number', 'WER should be computable')
  } finally {
    await bci.destroy()
  }
})

test('[BCI] WER measurement across all test samples', { skip: !hasModel }, async (t) => {
  if (manifest.samples.length === 0) {
    t.skip('No neural signal test fixtures found')
    return
  }

  console.log(`\n=== WER Report (${manifest.samples.length} samples) ===`)
  console.log(`Platform: ${platform.label}`)
  console.log(`Model:    ${MODEL_PATH}\n`)

  const bci = new BCIWhispercpp({ modelPath: MODEL_PATH }, {
    whisperConfig: { language: 'en', temperature: 0.0 },
    miscConfig: { caption_enabled: false }
  })

  const results = []

  try {
    await bci.load()

    for (const sample of manifest.samples) {
      const samplePath = getSamplePath(sample.file)
      if (!fs.existsSync(samplePath)) continue

      const result = await bci.transcribeFile(samplePath)
      const wer = computeWER(result.text, sample.expected_text)
      results.push({ expected: sample.expected_text, got: result.text, wer })

      console.log(`  [${sample.file}]`)
      console.log(`    Expected: "${sample.expected_text}"`)
      console.log(`    Got:      "${result.text}"`)
      console.log(`    WER:      ${(wer * 100).toFixed(1)}%\n`)
    }
  } finally {
    await bci.destroy()
  }

  const avgWER = results.reduce((sum, r) => sum + r.wer, 0) / results.length
  console.log(`  Average WER: ${(avgWER * 100).toFixed(1)}%`)
  console.log(`  Samples tested: ${results.length}`)

  t.ok(results.length > 0, 'Should have tested at least one sample')
  t.ok(typeof avgWER === 'number', 'Average WER should be computable')
})
