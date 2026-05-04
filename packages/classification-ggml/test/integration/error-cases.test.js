'use strict'

const test = require('brittle')

const ImageClassifier = require('../..')
const { loadImage, TEST_TIMEOUT, makeClassifier, cleanupClassifier } = require('./utils')

test('classify(null) rejects with structured error', async function (t) {
  t.timeout(TEST_TIMEOUT)
  const classifier = makeClassifier()
  await classifier.load()
  try {
    await t.exception.all(() => classifier.classify(null), /required|null|undefined/i)
  } finally {
    await cleanupClassifier(classifier)
  }
})

test('classify(empty buffer) rejects', async function (t) {
  t.timeout(TEST_TIMEOUT)
  const classifier = makeClassifier()
  await classifier.load()
  try {
    await t.exception.all(() => classifier.classify(Buffer.alloc(0)), /empty/i)
  } finally {
    await cleanupClassifier(classifier)
  }
})

test('classify(non-image buffer without dims) rejects', async function (t) {
  t.timeout(TEST_TIMEOUT)
  const classifier = makeClassifier()
  await classifier.load()
  try {
    await t.exception.all(() => classifier.classify(Buffer.from('not an image')),
      /unsupported|jpeg|png/i)
  } finally {
    await cleanupClassifier(classifier)
  }
})

test('classify(truncated JPEG) rejects without crashing', async function (t) {
  t.timeout(TEST_TIMEOUT)
  const classifier = makeClassifier()
  await classifier.load()
  try {
    const full = loadImage('meal_1.jpg')
    const truncated = full.slice(0, Math.min(128, full.length))
    await t.exception.all(() => classifier.classify(truncated), /decode|corrupt|invalid|jpeg/i)
  } finally {
    await cleanupClassifier(classifier)
  }
})

test('classify(raw bytes with mismatched dimensions) rejects', async function (t) {
  t.timeout(TEST_TIMEOUT)
  const classifier = makeClassifier()
  await classifier.load()
  try {
    const bad = Buffer.alloc(10 * 10 * 3, 0)
    await t.exception.all(
      () => classifier.classify(bad, { width: 999, height: 999, channels: 3 }),
      /does not match|size/i
    )
  } finally {
    await cleanupClassifier(classifier)
  }
})

test('classify(bmp buffer) rejects as unsupported format', async function (t) {
  t.timeout(TEST_TIMEOUT)
  const classifier = makeClassifier()
  await classifier.load()
  try {
    // BMP signature 'BM' followed by a minimal header.
    const bmp = Buffer.from([0x42, 0x4D, 0x00, 0x00, 0x00, 0x00])
    await t.exception.all(() => classifier.classify(bmp), /unsupported|jpeg|png/i)
  } finally {
    await cleanupClassifier(classifier)
  }
})

test('classify before load() rejects', async function (t) {
  t.timeout(TEST_TIMEOUT)
  const classifier = makeClassifier()
  try {
    await t.exception.all(
      () => classifier.classify(loadImage('meal_1.jpg')),
      /not loaded|load\(\)/i
    )
  } finally {
    await cleanupClassifier(classifier)
  }
})

test('classify after unload() rejects', async function (t) {
  t.timeout(TEST_TIMEOUT)
  const classifier = makeClassifier()
  await classifier.load()
  await cleanupClassifier(classifier)
  await t.exception.all(
    () => classifier.classify(loadImage('meal_1.jpg')),
    /not loaded|load\(\)/i
  )
})

test('tiny 1x1 raw image is accepted (upscaled)', async function (t) {
  t.timeout(TEST_TIMEOUT)
  const classifier = makeClassifier()
  await classifier.load()
  try {
    const tiny = Buffer.from([200, 150, 50])
    const result = await classifier.classify(tiny, { width: 1, height: 1, channels: 3 })
    t.is(result.length, 3, 'returns all classes for 1x1 upscale')
  } finally {
    await cleanupClassifier(classifier)
  }
})

test('constructor rejects non-positive integer threads', async function (t) {
  for (const bad of [-1, 0, 4.5, NaN]) {
    await t.exception.all(
      async () => new ImageClassifier({ threads: bad }),
      /threads.*positive integer/i,
      `threads=${bad} is rejected`
    )
  }
})

test('constructor rejects non-number threads', async function (t) {
  for (const bad of ['4', '', null, true, [], {}]) {
    await t.exception.all(
      async () => new ImageClassifier({ threads: bad }),
      /threads.*positive integer/i,
      `threads=${JSON.stringify(bad)} is rejected`
    )
  }
})

test('constructor accepts undefined and positive integer threads', function (t) {
  // No throw expected.
  t.execution(() => new ImageClassifier({}))
  t.execution(() => new ImageClassifier({ threads: undefined }))
  t.execution(() => new ImageClassifier({ threads: 1 }))
  t.execution(() => new ImageClassifier({ threads: 8 }))
})

test('load -> unload -> load cycles do not leak handles', async function (t) {
  t.timeout(TEST_TIMEOUT)
  for (let i = 0; i < 3; i++) {
    const classifier = makeClassifier()
    await classifier.load()
    const r = await classifier.classify(loadImage('meal_1.jpg'))
    t.ok(Array.isArray(r), `cycle ${i}: classify works`)
    await cleanupClassifier(classifier)
  }
})
