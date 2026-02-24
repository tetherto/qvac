'use strict'

const { ONNXOcr } = require('../..')
const test = require('brittle')
const { isMobile, getImagePath, ensureModelPath } = require('./utils')

const MOBILE_TIMEOUT = 600 * 1000
const DESKTOP_TIMEOUT = 120 * 1000
const TEST_TIMEOUT = isMobile ? MOBILE_TIMEOUT : DESKTOP_TIMEOUT

async function createAndLoadOcr (t) {
  const detectorPath = await ensureModelPath('detector_craft')
  const recognizerPath = await ensureModelPath('recognizer_latin')
  const imagePath = getImagePath('/test/images/basic_test.bmp')

  const onnxOcr = new ONNXOcr({
    params: {
      pathDetector: detectorPath,
      pathRecognizer: recognizerPath,
      langList: ['en'],
      useGPU: false
    },
    opts: { stats: true }
  })

  return { onnxOcr, imagePath }
}

test('Load, run, unload - basic lifecycle', { timeout: TEST_TIMEOUT }, async function (t) {
  const { onnxOcr, imagePath } = await createAndLoadOcr(t)

  await onnxOcr.load()
  t.pass('Model loaded successfully')

  try {
    const response = await onnxOcr.run({
      path: imagePath,
      options: { paragraph: false }
    })

    await response
      .onUpdate(output => {
        t.ok(Array.isArray(output), 'Output should be an array')
        t.ok(output.length > 0, 'Should detect at least one text region')
      })
      .onError(error => {
        t.fail('Unexpected error: ' + JSON.stringify(error))
      })
      .await()

    t.pass('Run completed successfully')
  } finally {
    await onnxOcr.unload()
    t.pass('Unload completed successfully')
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
})

test('Load, unload, reload - model can be reloaded after unload', { timeout: TEST_TIMEOUT * 2 }, async function (t) {
  const { onnxOcr, imagePath } = await createAndLoadOcr(t)

  // First load
  await onnxOcr.load()
  t.pass('First load successful')

  const response1 = await onnxOcr.run({
    path: imagePath,
    options: { paragraph: false }
  })

  let firstRunTexts = []
  await response1
    .onUpdate(output => {
      firstRunTexts = output.map(o => o[1])
    })
    .await()

  t.ok(firstRunTexts.length > 0, 'First run should produce output')
  t.comment('First run texts: ' + JSON.stringify(firstRunTexts))

  // Unload
  await onnxOcr.unload()
  t.pass('Unload successful')
  await new Promise(resolve => setTimeout(resolve, 2000))

  // Reload
  await onnxOcr.load()
  t.pass('Reload successful')

  try {
    const response2 = await onnxOcr.run({
      path: imagePath,
      options: { paragraph: false }
    })

    let secondRunTexts = []
    await response2
      .onUpdate(output => {
        secondRunTexts = output.map(o => o[1])
      })
      .await()

    t.ok(secondRunTexts.length > 0, 'Second run after reload should produce output')
    t.comment('Second run texts: ' + JSON.stringify(secondRunTexts))

    t.is(firstRunTexts.length, secondRunTexts.length, 'Both runs should detect same number of regions')
    for (const text of firstRunTexts) {
      t.ok(secondRunTexts.includes(text), `Reloaded model should detect "${text}"`)
    }

    t.pass('Model reload produced consistent results')
  } finally {
    await onnxOcr.unload()
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
})

test('Double unload does not crash', { timeout: TEST_TIMEOUT }, async function (t) {
  const { onnxOcr } = await createAndLoadOcr(t)

  await onnxOcr.load()
  t.pass('Model loaded')

  await onnxOcr.unload()
  t.pass('First unload successful')

  try {
    await onnxOcr.unload()
    t.pass('Second unload did not throw')
  } catch (err) {
    t.comment('Second unload threw: ' + err.message)
    t.pass('Second unload threw an error (acceptable behavior)')
  }

  await new Promise(resolve => setTimeout(resolve, 1000))
})

test('Run before load throws error', { timeout: TEST_TIMEOUT }, async function (t) {
  const detectorPath = await ensureModelPath('detector_craft')
  const recognizerPath = await ensureModelPath('recognizer_latin')
  const imagePath = getImagePath('/test/images/basic_test.bmp')

  const onnxOcr = new ONNXOcr({
    params: {
      pathDetector: detectorPath,
      pathRecognizer: recognizerPath,
      langList: ['en'],
      useGPU: false
    }
  })

  try {
    await onnxOcr.run({
      path: imagePath,
      options: { paragraph: false }
    })
    t.fail('Should have thrown when running before load')
  } catch (err) {
    t.ok(err, 'Should throw an error when running before load')
    t.comment('Error: ' + err.message)
    t.pass('Correctly prevented run before load')
  }
})

test('Run after unload throws error', { timeout: TEST_TIMEOUT }, async function (t) {
  const { onnxOcr, imagePath } = await createAndLoadOcr(t)

  await onnxOcr.load()
  await onnxOcr.unload()
  await new Promise(resolve => setTimeout(resolve, 1000))

  try {
    await onnxOcr.run({
      path: imagePath,
      options: { paragraph: false }
    })
    t.fail('Should have thrown when running after unload')
  } catch (err) {
    t.ok(err, 'Should throw an error when running after unload')
    t.comment('Error: ' + err.message)
    t.pass('Correctly prevented run after unload')
  }
})

test('Cancellation during inference does not crash', { timeout: TEST_TIMEOUT }, async function (t) {
  const { onnxOcr, imagePath } = await createAndLoadOcr(t)

  await onnxOcr.load()

  try {
    const response = await onnxOcr.run({
      path: imagePath,
      options: { paragraph: false }
    })

    // Cancel immediately after starting
    if (onnxOcr.addon && onnxOcr.addon.cancel) {
      await onnxOcr.addon.cancel()
      t.pass('Cancel called without crashing')
    } else {
      t.comment('addon.cancel not available, skipping cancel test')
    }

    // After cancel, the response may never settle (no JobEnded event).
    // Race against a short timeout so we don't hang the whole suite.
    const CANCEL_WAIT_MS = 5000
    try {
      await Promise.race([
        response.await(),
        new Promise(function (resolve, reject) {
          setTimeout(function () { reject(new Error('cancel: response did not settle')) }, CANCEL_WAIT_MS)
        })
      ])
      t.comment('Response completed despite cancel (inference may have finished first)')
    } catch (err) {
      t.comment('Response after cancel: ' + err.message)
    }

    t.pass('Cancellation handled gracefully')
  } finally {
    try {
      await onnxOcr.unload()
    } catch (err) {
      t.comment('Unload after cancel: ' + err.message)
    }
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
})

test('Performance parameters are accepted without error', { timeout: TEST_TIMEOUT }, async function (t) {
  const detectorPath = await ensureModelPath('detector_craft')
  const recognizerPath = await ensureModelPath('recognizer_latin')
  const imagePath = getImagePath('/test/images/basic_test.bmp')

  const onnxOcr = new ONNXOcr({
    params: {
      pathDetector: detectorPath,
      pathRecognizer: recognizerPath,
      langList: ['en'],
      useGPU: false,
      magRatio: 1.5,
      recognizerBatchSize: 4,
      lowConfidenceThreshold: 0.3
    },
    opts: { stats: true }
  })

  await onnxOcr.load()

  try {
    const response = await onnxOcr.run({
      path: imagePath,
      options: { paragraph: false }
    })

    await response
      .onUpdate(output => {
        t.ok(Array.isArray(output), 'Output with custom params should be an array')
        t.ok(output.length > 0, 'Should still detect text with custom performance params')
        t.comment('Detected ' + output.length + ' regions with custom performance params')
      })
      .onError(error => {
        t.fail('Unexpected error with performance params: ' + JSON.stringify(error))
      })
      .await()

    t.pass('Performance parameters accepted and inference completed')
  } finally {
    await onnxOcr.unload()
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
})
