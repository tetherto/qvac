'use strict'

const test = require('brittle')

const ImageClassifier = require('../../index')
const {
  IMAGE_SAMPLES,
  loadImage,
  createLogger,
  TEST_TIMEOUT,
  recordMetric,
  recordLoadTime,
  resolveModelPath
} = require('./utils')

test('load() + classify() returns a shaped result for every sample image', async function (t) {
  t.timeout(TEST_TIMEOUT)
  const modelPath = resolveModelPath()
  const classifier = new ImageClassifier({ modelPath, logger: createLogger() })
  const loadStart = Date.now()
  await classifier.load()
  const loadElapsed = Date.now() - loadStart
  recordLoadTime('load:cold', loadElapsed)
  try {
    for (const sample of IMAGE_SAMPLES) {
      const buffer = loadImage(sample.file)
      const start = Date.now()
      const result = await classifier.classify(buffer)
      const elapsed = Date.now() - start

      // Always emit the full result into the TAP stream so CI logs
      // contain the actual model output for every platform, even on
      // success. When an assertion fails (e.g. the win32 CI meal_1
      // anomaly), this line is what lets us diagnose without needing
      // to add instrumentation in a follow-up commit.
      t.comment(
        `${sample.file} elapsed=${elapsed}ms result=` +
        JSON.stringify(
          Array.isArray(result)
            ? result.map((r) => ({
              label: r && r.label,
              confidence: typeof r?.confidence === 'number'
                ? r.confidence.toFixed(6)
                : String(r?.confidence)
            }))
            : result
        )
      )

      // Shape + per-entry validity: distinguish "not a number / NaN /
      // Inf" from "number outside [0,1]" so a future failure tells us
      // the kind of corruption rather than just "bad value".
      t.ok(Array.isArray(result), `${sample.file}: result is an array`)
      t.is(result.length, 3, `${sample.file}: 3 classes returned`)
      for (let idx = 0; idx < result.length; idx++) {
        const entry = result[idx]
        t.is(typeof entry.label, 'string',
          `${sample.file}[${idx}]: label is a string`)
        t.ok(typeof entry.confidence === 'number',
          `${sample.file}[${idx}]: confidence is a number`)
        t.ok(Number.isFinite(entry.confidence),
          `${sample.file}[${idx}]: confidence is finite (not NaN/Inf)`)
        t.ok(entry.confidence >= 0 && entry.confidence <= 1,
          `${sample.file}[${idx}]: confidence is in [0, 1] (got ${entry.confidence})`)
      }

      // Sum-to-one guarantee from the C++ softmax. If this ever fails
      // the diagnostic comment above tells us the per-element values.
      const sum = result.reduce((acc, r) => acc + r.confidence, 0)
      t.ok(Number.isFinite(sum), `${sample.file}: probability sum is finite (got ${sum})`)
      t.ok(Math.abs(sum - 1) < 1e-3,
        `${sample.file}: probabilities sum ≈ 1.0 (sum=${sum.toFixed(6)})`)

      // Sort order. We split the two pairwise comparisons so a failure
      // tells us which adjacent pair is misordered.
      t.ok(result[0].confidence >= result[1].confidence,
        `${sample.file}: sorted desc [0]>=[1] (got ${result[0].confidence.toFixed(6)} vs ${result[1].confidence.toFixed(6)})`)
      t.ok(result[1].confidence >= result[2].confidence,
        `${sample.file}: sorted desc [1]>=[2] (got ${result[1].confidence.toFixed(6)} vs ${result[2].confidence.toFixed(6)})`)

      t.is(result[0].label, sample.expected,
        `${sample.file}: top class should be '${sample.expected}'`)

      recordMetric(`classify:${sample.file}`, elapsed, sample.file)
    }
  } finally {
    await classifier.unload()
  }
})

test('topK limits output count', async function (t) {
  t.timeout(TEST_TIMEOUT)
  const classifier = new ImageClassifier({ modelPath: resolveModelPath(), logger: createLogger() })
  await classifier.load()
  try {
    const buffer = loadImage('meal_1.jpg')
    const top1 = await classifier.classify(buffer, { topK: 1 })
    t.comment(`topK=1 result=${JSON.stringify(top1)}`)
    t.is(top1.length, 1, 'topK=1 returns exactly one entry')
    t.ok(Number.isFinite(top1[0].confidence),
      `topK=1 [0].confidence is finite (got ${top1[0].confidence})`)
    t.ok(top1[0].confidence > 0,
      `topK=1 top entry has nonzero confidence (got ${top1[0].confidence})`)

    const top2 = await classifier.classify(buffer, { topK: 2 })
    t.comment(`topK=2 result=${JSON.stringify(top2)}`)
    t.is(top2.length, 2, 'topK=2 returns exactly two entries')
    t.ok(Number.isFinite(top2[0].confidence) && Number.isFinite(top2[1].confidence),
      'topK=2 both confidences are finite')
    t.ok(top2[0].confidence >= top2[1].confidence,
      `topK=2 sorted desc (got ${top2[0].confidence} vs ${top2[1].confidence})`)
  } finally {
    await classifier.unload()
  }
})

test('multiple sequential classifications produce consistent output', async function (t) {
  t.timeout(TEST_TIMEOUT)
  const classifier = new ImageClassifier({ modelPath: resolveModelPath(), logger: createLogger() })
  await classifier.load()
  try {
    const buffer = loadImage('report_1.jpg')
    const a = await classifier.classify(buffer)
    const b = await classifier.classify(buffer)
    t.comment(`a=${JSON.stringify(a)}`)
    t.comment(`b=${JSON.stringify(b)}`)
    t.ok(Number.isFinite(a[0].confidence) && Number.isFinite(b[0].confidence),
      'both top confidences are finite')
    t.is(a[0].label, b[0].label, 'top class is stable across calls')
    t.ok(Math.abs(a[0].confidence - b[0].confidence) < 1e-5,
      `top confidence is deterministic on CPU (a=${a[0].confidence}, b=${b[0].confidence})`)
  } finally {
    await classifier.unload()
  }
})

test('raw RGB bytes path', async function (t) {
  t.timeout(TEST_TIMEOUT)
  const classifier = new ImageClassifier({ modelPath: resolveModelPath(), logger: createLogger() })
  await classifier.load()
  try {
    const width = 10
    const height = 10
    const channels = 3
    const raw = Buffer.alloc(width * height * channels, 128)
    const result = await classifier.classify(raw, { width, height, channels })
    t.comment(`raw RGB result=${JSON.stringify(result)}`)
    t.is(result.length, 3, 'returns all classes for raw input')
    for (let idx = 0; idx < result.length; idx++) {
      t.ok(Number.isFinite(result[idx].confidence),
        `raw RGB [${idx}].confidence is finite (got ${result[idx].confidence})`)
    }
    const sum = result.reduce((acc, r) => acc + r.confidence, 0)
    t.ok(Math.abs(sum - 1) < 1e-3,
      `raw input probabilities sum ≈ 1.0 (sum=${sum.toFixed(6)})`)
  } finally {
    await classifier.unload()
  }
})
