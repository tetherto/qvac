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
  path.join(__dirname, '..', '..', 'models', 'ggml-bci-windowed.bin')

const hasModel = fs.existsSync(MODEL_PATH)

function bciConfigFor (sample) {
  return typeof sample?.day_idx === 'number' ? { day_idx: sample.day_idx } : undefined
}

function flattenSegments (output) {
  const segments = []
  for (const entry of output) {
    if (Array.isArray(entry)) {
      segments.push(...entry)
    } else if (entry && typeof entry.text === 'string') {
      segments.push(entry)
    }
  }
  return segments
}

test('[BCI] load and destroy via package interface', { skip: !hasModel, timeout: 120000 }, async (t) => {
  const bci = new BCIWhispercpp({
    files: { model: MODEL_PATH }
  }, {
    whisperConfig: { language: 'en', temperature: 0.0 },
    miscConfig: { caption_enabled: false }
  })

  await bci.load()
  t.ok(bci, 'BCIWhispercpp should be created and loaded')

  await bci.destroy()
  t.pass('BCIWhispercpp destroyed successfully')
})

test('[BCI] batch transcription from neural signal file', { skip: !hasModel, timeout: 120000 }, async (t) => {
  t.ok(manifest.samples.length > 0, 'Manifest must contain at least one sample')

  const sample = manifest.samples[0]
  const samplePath = getSamplePath(sample.file)
  t.ok(fs.existsSync(samplePath), 'Fixture ' + sample.file + ' must exist')

  const bci = new BCIWhispercpp({
    files: { model: MODEL_PATH }
  }, {
    whisperConfig: { language: 'en', temperature: 0.0 },
    miscConfig: { caption_enabled: false },
    bciConfig: bciConfigFor(sample)
  })

  try {
    await bci.load()

    const response = await bci.transcribeFile(samplePath)
    const output = await response.await()
    const segments = flattenSegments(output)
    const text = segments.map(s => s.text).join('').trim()

    t.comment('Expected: "' + sample.expected_text + '"')
    t.comment('Got:      "' + text + '"')

    const wer = computeWER(text, sample.expected_text)
    t.comment('WER:      ' + (wer * 100).toFixed(1) + '%')

    t.ok(typeof text === 'string' && text.length > 0, 'Should produce a transcription string')
    t.ok(segments.length > 0, 'Should have segments')
    t.ok(typeof wer === 'number' && wer >= 0, 'WER should be a non-negative number')
  } finally {
    await bci.destroy()
  }
})

test('[BCI] streaming transcription from neural signal chunks', { skip: !hasModel, timeout: 120000 }, async (t) => {
  t.ok(manifest.samples.length > 0, 'Manifest must contain at least one sample')

  const sample = manifest.samples[1] || manifest.samples[0]
  const samplePath = getSamplePath(sample.file)
  t.ok(fs.existsSync(samplePath), 'Fixture ' + sample.file + ' must exist')

  const bci = new BCIWhispercpp({
    files: { model: MODEL_PATH }
  }, {
    whisperConfig: { language: 'en', temperature: 0.0 },
    miscConfig: { caption_enabled: false },
    bciConfig: bciConfigFor(sample)
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

    const response = await bci.transcribeStream(generateChunks())
    const output = await response.await()
    const segments = flattenSegments(output)
    const text = segments.map(s => s.text).join('').trim()

    t.comment('Expected: "' + sample.expected_text + '"')
    t.comment('Got:      "' + text + '"')

    const wer = computeWER(text, sample.expected_text)
    t.comment('WER:      ' + (wer * 100).toFixed(1) + '%')

    t.ok(typeof text === 'string' && text.length > 0, 'Streaming should produce transcription')
    t.ok(typeof wer === 'number', 'WER should be computable')
  } finally {
    await bci.destroy()
  }
})

test('[BCI] WER measurement across all test samples', { skip: !hasModel, timeout: 180000 }, async (t) => {
  t.ok(manifest.samples.length > 0, 'Manifest must contain at least one sample')

  t.comment('Platform: ' + platform.label)
  t.comment('Model:    ' + MODEL_PATH)

  const results = []

  const byDay = new Map()
  for (const sample of manifest.samples) {
    const key = typeof sample.day_idx === 'number' ? sample.day_idx : -1
    if (!byDay.has(key)) byDay.set(key, [])
    byDay.get(key).push(sample)
  }

  for (const [day, samples] of byDay) {
    const bci = new BCIWhispercpp({
      files: { model: MODEL_PATH }
    }, {
      whisperConfig: { language: 'en', temperature: 0.0 },
      miscConfig: { caption_enabled: false },
      bciConfig: day >= 0 ? { day_idx: day } : undefined
    })

    try {
      await bci.load()

      for (const sample of samples) {
        const samplePath = getSamplePath(sample.file)
        if (!fs.existsSync(samplePath)) {
          t.fail('Fixture ' + sample.file + ' is missing')
          continue
        }

        const response = await bci.transcribeFile(samplePath)
        const output = await response.await()
        const segments = flattenSegments(output)
        const text = segments.map(s => s.text).join('').trim()
        const wer = computeWER(text, sample.expected_text)
        results.push({ file: sample.file, expected: sample.expected_text, got: text, wer })

        t.comment('[' + sample.file + '] expected=' + JSON.stringify(sample.expected_text) +
          ' got=' + JSON.stringify(text) + ' WER=' + (wer * 100).toFixed(1) + '%')
      }
    } finally {
      await bci.destroy()
    }
  }

  const avgWER = results.reduce((sum, r) => sum + r.wer, 0) / results.length
  t.comment('Average WER: ' + (avgWER * 100).toFixed(1) + '%  (n=' + results.length + ')')

  t.ok(results.length === manifest.samples.length, 'All manifest samples should have been evaluated')
  t.ok(typeof avgWER === 'number' && avgWER < 0.5, 'Average WER should be below 50%')
})
