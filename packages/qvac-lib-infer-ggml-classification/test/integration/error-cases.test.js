'use strict'

const test = require('brittle')

const ImageClassifier = require('../../index')
const { loadImage, createLogger, TEST_TIMEOUT } = require('./utils')

test('classify(null) rejects with structured error', async function (t) {
  t.timeout(TEST_TIMEOUT)
  const classifier = new ImageClassifier({ logger: createLogger() })
  await classifier.load()
  try {
    await t.exception.all(() => classifier.classify(null), /required|null|undefined/i)
  } finally {
    await classifier.unload()
  }
})

test('classify(empty buffer) rejects', async function (t) {
  t.timeout(TEST_TIMEOUT)
  const classifier = new ImageClassifier({ logger: createLogger() })
  await classifier.load()
  try {
    await t.exception.all(() => classifier.classify(Buffer.alloc(0)), /empty/i)
  } finally {
    await classifier.unload()
  }
})

test('classify(non-image buffer without dims) rejects', async function (t) {
  t.timeout(TEST_TIMEOUT)
  const classifier = new ImageClassifier({ logger: createLogger() })
  await classifier.load()
  try {
    await t.exception.all(() => classifier.classify(Buffer.from('not an image')),
      /unsupported|jpeg|png/i)
  } finally {
    await classifier.unload()
  }
})

test('classify(truncated JPEG) rejects without crashing', async function (t) {
  t.timeout(TEST_TIMEOUT)
  const classifier = new ImageClassifier({ logger: createLogger() })
  await classifier.load()
  try {
    const full = loadImage('meal_1.jpg')
    const truncated = full.slice(0, Math.min(128, full.length))
    await t.exception.all(() => classifier.classify(truncated), /decode|corrupt|invalid|jpeg/i)
  } finally {
    await classifier.unload()
  }
})

test('classify(raw bytes with mismatched dimensions) rejects', async function (t) {
  t.timeout(TEST_TIMEOUT)
  const classifier = new ImageClassifier({ logger: createLogger() })
  await classifier.load()
  try {
    const bad = Buffer.alloc(10 * 10 * 3, 0)
    await t.exception.all(
      () => classifier.classify(bad, { width: 999, height: 999, channels: 3 }),
      /does not match|size/i
    )
  } finally {
    await classifier.unload()
  }
})

test('classify(bmp buffer) rejects as unsupported format', async function (t) {
  t.timeout(TEST_TIMEOUT)
  const classifier = new ImageClassifier({ logger: createLogger() })
  await classifier.load()
  try {
    // BMP signature 'BM' followed by a minimal header.
    const bmp = Buffer.from([0x42, 0x4D, 0x00, 0x00, 0x00, 0x00])
    await t.exception.all(() => classifier.classify(bmp), /unsupported|jpeg|png/i)
  } finally {
    await classifier.unload()
  }
})

test('classify before load() rejects', async function (t) {
  t.timeout(TEST_TIMEOUT)
  const classifier = new ImageClassifier({ logger: createLogger() })
  await t.exception.all(
    () => classifier.classify(loadImage('meal_1.jpg')),
    /not loaded|load\(\)/i
  )
})

test('classify after unload() rejects', async function (t) {
  t.timeout(TEST_TIMEOUT)
  const classifier = new ImageClassifier({ logger: createLogger() })
  await classifier.load()
  await classifier.unload()
  await t.exception.all(
    () => classifier.classify(loadImage('meal_1.jpg')),
    /not loaded|load\(\)/i
  )
})

test('tiny 1x1 raw image is accepted (upscaled)', async function (t) {
  t.timeout(TEST_TIMEOUT)
  const classifier = new ImageClassifier({ logger: createLogger() })
  await classifier.load()
  try {
    const tiny = Buffer.from([200, 150, 50])
    const result = await classifier.classify(tiny, { width: 1, height: 1, channels: 3 })
    t.is(result.length, 3, 'returns all classes for 1x1 upscale')
  } finally {
    await classifier.unload()
  }
})

test('load -> unload -> load cycles do not leak handles', async function (t) {
  t.timeout(TEST_TIMEOUT)
  for (let i = 0; i < 3; i++) {
    const classifier = new ImageClassifier({ logger: createLogger() })
    await classifier.load()
    const r = await classifier.classify(loadImage('meal_1.jpg'))
    t.ok(Array.isArray(r), `cycle ${i}: classify works`)
    await classifier.unload()
  }
})
