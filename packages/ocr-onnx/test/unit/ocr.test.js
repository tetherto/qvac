'use strict'

const test = require('brittle')
const MockONNXOcr = require('../MockONNXOcr.js')

/**
 * Test that the OCR inference process returns the expected output.
 */
test('OCR inference returns correct output', async t => {
  const args = {
    params: {
      langList: ['en'],
      pathDetector: 'detector.onnx',
      pathRecognizer: 'recognizer_latin.onnx'
    },
    opts: {}
  }
  const model = new MockONNXOcr(args)
  await model.load()

  const input = {
    path: 'test/images/basic_test.bmp'
  }
  const response = await model.run(input)

  response.onUpdate(output => {
    console.log('output: ', output)
    const outputData = [
      [[[25, 61], [62, 6], [82, 20], [46, 75]], 'tilted', 0.7302044630050659]
    ]
    t.alike(output, outputData, 'Output should be an image')
  })

  await response.await()
})

/**
 * Test that the model correctly handles state transitions.
 */
test('OCR model state transitions are handled correctly', async t => {
  const args = {
    params: {
      langList: ['en'],
      pathDetector: 'detector.onnx',
      pathRecognizer: 'recognizer_latin.onnx'
    },
    opts: {}
  }
  const model = new MockONNXOcr(args)
  await model.load()

  t.ok((await model.status()) === 'listening', 'Status: Model should be listening')

  await model.pause()
  t.ok((await model.status()) === 'paused', 'Status: Model should be paused')

  await model.unpause()
  t.ok((await model.status()) === 'listening', 'Status: Model should be listening')

  await model.stop()
  t.ok((await model.status()) === 'stopped', 'Status: Model should be stopped')
})

/**
 * Test that the model correctly validates BMP image input.
 */
test('OCR model validates BMP image input', async t => {
  const args = {
    params: {
      langList: ['en'],
      pathDetector: 'detector.onnx',
      pathRecognizer: 'recognizer_latin.onnx'
    },
    opts: {}
  }
  const model = new MockONNXOcr(args)
  await model.load()

  let errorCaught = false
  try {
    await model.run({ path: 'invalid_path.bmp' })
  } catch (err) {
    errorCaught = true
    t.ok(err.message.includes('no such file or directory'), 'Should throw BMP validation error')
  }
  t.ok(errorCaught, 'Invalid BMP error should be caught')
})

/**
 * Test that the model correctly determines recognizer model name based on language list.
 */
test('OCR model determines correct recognizer model name', async t => {
  const args = {
    params: {
      langList: ['en'],
      pathDetector: 'detector.onnx',
      pathRecognizer: 'recognizer_latin.onnx'
    },
    opts: {}
  }
  const model = new MockONNXOcr(args)

  t.is(model.getRecognizerModelName(['en']), 'latin', 'Should return latin for en')
  t.is(model.getRecognizerModelName(['ar']), 'arabic', 'Should return arabic for ar')
  t.is(model.getRecognizerModelName(['ru']), 'cyrillic', 'Should return cyrillic for ru')
  t.is(model.getRecognizerModelName(['hi']), 'devanagari', 'Should return devanagari for hi')
  t.is(model.getRecognizerModelName(['bn']), 'bengali', 'Should return bengali for bn')
  t.is(model.getRecognizerModelName(['fr']), 'latin', 'Should return latin for fr')
})
