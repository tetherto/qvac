'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const test = require('brittle')
const os = require('bare-os')
const BCIWhispercpp = require('../../index')
const {
  getTestPaths,
  computeWER,
  detectPlatform,
  readSignal,
  splitHeaderAndBody,
  buildSignal,
  chunkify
} = require('./helpers')
const { flattenSegments } = require('../../lib/util')

const platform = detectPlatform()
const { manifest, getSamplePath } = getTestPaths()

const MODEL_PATH = (os.hasEnv('WHISPER_MODEL_PATH') ? os.getEnv('WHISPER_MODEL_PATH') : null) ||
  path.join(__dirname, '..', '..', 'models', 'ggml-bci-windowed.bin')

const hasModel = fs.existsSync(MODEL_PATH)

// Skipping when the model is missing is fine for local dev, but in CI we
// want a loud failure. Set BCI_REQUIRE_MODEL=1 (e.g. on a runner with the
// assets pre-provisioned) to turn "missing model" into a hard error so the
// tests cannot silently pass with zero assertions.
const requireModel = os.hasEnv('BCI_REQUIRE_MODEL') && os.getEnv('BCI_REQUIRE_MODEL') === '1'

if (requireModel && !hasModel) {
  throw new Error(
    'BCI_REQUIRE_MODEL=1 but model file was not found at ' + MODEL_PATH +
    '. Run `bash scripts/download-models.sh` or set WHISPER_MODEL_PATH.'
  )
}

function bciConfigFor (sample) {
  return typeof sample?.day_idx === 'number' ? { day_idx: sample.day_idx } : undefined
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

test('[BCI] streaming transcription on short signal yields single-window output', { skip: !hasModel, timeout: 120000 }, async (t) => {
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

    const signal = readSignal(samplePath)
    const response = await bci.transcribeStream(chunkify(signal, 4096), {
      windowTimesteps: 1500,
      hopTimesteps: 500
    })

    const updates = []
    response.onUpdate((out) => { updates.push(out) })

    const output = await response.await()
    const segments = flattenSegments(output)
    const text = segments.map(s => s.text).join(' ').trim()

    t.comment('Streamed text: "' + text + '"')
    t.comment('Expected:      "' + sample.expected_text + '"')
    t.comment('Update events: ' + updates.length)

    t.ok(updates.length >= 1, 'At least one onUpdate should fire')
    t.ok(typeof text === 'string' && text.length > 0, 'Should produce a non-empty transcription')
    const wer = computeWER(text, sample.expected_text)
    t.ok(wer < 0.5, 'Streamed WER should be below 50% (got ' + (wer * 100).toFixed(1) + '%)')
  } finally {
    await bci.destroy()
  }
})

test('[BCI] streaming transcription triggers multiple sliding windows on long signal', { skip: !hasModel, timeout: 180000 }, async (t) => {
  t.ok(manifest.samples.length > 0, 'Manifest must contain at least one sample')

  const sample = manifest.samples[0]
  const samplePath = getSamplePath(sample.file)
  t.ok(fs.existsSync(samplePath), 'Fixture ' + sample.file + ' must exist')

  const raw = readSignal(samplePath)
  const { channels, body } = splitHeaderAndBody(raw)

  // Tile the fixture body twice to synthesize a signal long enough that a
  // window=1500 / hop=500 configuration forces at least two decodes.
  const tiled = buildSignal(channels, [body, body])

  const bci = new BCIWhispercpp({
    files: { model: MODEL_PATH }
  }, {
    whisperConfig: { language: 'en', temperature: 0.0 },
    miscConfig: { caption_enabled: false },
    bciConfig: bciConfigFor(sample)
  })

  try {
    await bci.load()

    const updates = []
    const response = await bci.transcribeStream(chunkify(tiled, 8192), {
      windowTimesteps: 1500,
      hopTimesteps: 500,
      emit: 'full'
    })
    response.onUpdate((out) => { updates.push(out) })

    const output = await response.await()
    const segments = flattenSegments(output)
    const text = segments.map(s => s.text).join(' ').trim()

    t.comment('Tiled stream text: "' + text + '"')
    t.comment('Update events: ' + updates.length)

    // emit:'full' fires one update per window decode regardless of seam overlap,
    // so update count is a faithful proxy for "multiple windows ran".
    t.ok(updates.length >= 2, 'Multiple windows should each emit an update (got ' + updates.length + ')')
    t.ok(typeof text === 'string' && text.length > 0, 'Should produce a non-empty merged transcription')
  } finally {
    await bci.destroy()
  }
})

test('[BCI] streaming emits incrementally before the input ends', { skip: !hasModel, timeout: 180000 }, async (t) => {
  const sample = manifest.samples[0]
  const samplePath = getSamplePath(sample.file)
  t.ok(fs.existsSync(samplePath), 'Fixture ' + sample.file + ' must exist')

  const raw = readSignal(samplePath)
  const { channels, body } = splitHeaderAndBody(raw)
  const tiled = buildSignal(channels, [body, body])

  const bci = new BCIWhispercpp({
    files: { model: MODEL_PATH }
  }, {
    whisperConfig: { language: 'en', temperature: 0.0 },
    miscConfig: { caption_enabled: false },
    bciConfig: bciConfigFor(sample)
  })

  try {
    await bci.load()

    let firstUpdateAt = null
    let streamEndedAt = null
    const startedAt = Date.now()

    const response = await bci.transcribeStream(chunkify(tiled, 4096), {
      windowTimesteps: 1500,
      hopTimesteps: 500
    })
    response.onUpdate(() => {
      if (firstUpdateAt === null) firstUpdateAt = Date.now()
    })

    await response.await()
    streamEndedAt = Date.now()

    t.comment('First update after ' + (firstUpdateAt - startedAt) + 'ms')
    t.comment('Stream ended after ' + (streamEndedAt - startedAt) + 'ms')

    t.ok(firstUpdateAt !== null, 'Expected at least one update during the stream')
    t.ok(firstUpdateAt < streamEndedAt, 'First update should arrive before stream completion')
  } finally {
    await bci.destroy()
  }
})
