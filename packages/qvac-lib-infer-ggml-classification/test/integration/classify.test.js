'use strict'

const test = require('brittle')

const ImageClassifier = require('../../index')
const { IMAGE_SAMPLES, loadImage, createLogger, TEST_TIMEOUT, recordMetric } = require('./utils')

test('load() + classify() returns a shaped result for every sample image', async function (t) {
  t.timeout(TEST_TIMEOUT)
  const classifier = new ImageClassifier({ logger: createLogger() })
  await classifier.load()
  try {
    for (const sample of IMAGE_SAMPLES) {
      const buffer = loadImage(sample.file)
      const start = Date.now()
      const result = await classifier.classify(buffer)
      const elapsed = Date.now() - start

      t.ok(Array.isArray(result), `${sample.file}: result is an array`)
      t.is(result.length, 3, `${sample.file}: 3 classes returned`)
      for (const entry of result) {
        t.is(typeof entry.label, 'string', `${sample.file}: label is a string`)
        t.ok(typeof entry.confidence === 'number' &&
             entry.confidence >= 0 && entry.confidence <= 1,
          `${sample.file}: confidence is in [0, 1]`)
      }
      const sum = result.reduce((acc, r) => acc + r.confidence, 0)
      t.ok(Math.abs(sum - 1) < 1e-3, `${sample.file}: probabilities sum ≈ 1.0`)
      t.ok(result[0].confidence >= result[1].confidence, `${sample.file}: sorted desc`)
      t.ok(result[1].confidence >= result[2].confidence, `${sample.file}: sorted desc`)

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
  const classifier = new ImageClassifier({ logger: createLogger() })
  await classifier.load()
  try {
    const buffer = loadImage('meal_1.jpg')
    const top1 = await classifier.classify(buffer, { topK: 1 })
    t.is(top1.length, 1)
    const top2 = await classifier.classify(buffer, { topK: 2 })
    t.is(top2.length, 2)
  } finally {
    await classifier.unload()
  }
})

test('multiple sequential classifications produce consistent output', async function (t) {
  t.timeout(TEST_TIMEOUT)
  const classifier = new ImageClassifier({ logger: createLogger() })
  await classifier.load()
  try {
    const buffer = loadImage('report_1.jpg')
    const a = await classifier.classify(buffer)
    const b = await classifier.classify(buffer)
    t.is(a[0].label, b[0].label, 'top class is stable across calls')
    t.ok(Math.abs(a[0].confidence - b[0].confidence) < 1e-5,
      'top confidence is deterministic on CPU')
  } finally {
    await classifier.unload()
  }
})

test('raw RGB bytes path', async function (t) {
  t.timeout(TEST_TIMEOUT)
  const classifier = new ImageClassifier({ logger: createLogger() })
  await classifier.load()
  try {
    const width = 10
    const height = 10
    const channels = 3
    const raw = Buffer.alloc(width * height * channels, 128)
    const result = await classifier.classify(raw, { width, height, channels })
    t.is(result.length, 3, 'returns all classes for raw input')
    const sum = result.reduce((acc, r) => acc + r.confidence, 0)
    t.ok(Math.abs(sum - 1) < 1e-3, 'raw input probabilities sum ≈ 1.0')
  } finally {
    await classifier.unload()
  }
})
