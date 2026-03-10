'use strict'

const { ONNXOcr } = require('../..')
const test = require('brittle')
const { isMobile, getImagePath, ensureDoctrModels, safeUnload } = require('./utils')

const MOBILE_TIMEOUT = 600 * 1000
const DESKTOP_TIMEOUT = 180 * 1000
const TEST_TIMEOUT = isMobile ? MOBILE_TIMEOUT : DESKTOP_TIMEOUT

let DOCTR_DETECTOR
let DOCTR_RECOGNIZER

async function createDoctrOcr (opts = {}) {
  const imagePath = getImagePath('/test/images/basic_test.bmp')

  const onnxOcr = new ONNXOcr({
    params: {
      pathDetector: DOCTR_DETECTOR,
      pathRecognizer: DOCTR_RECOGNIZER,
      langList: ['en'],
      useGPU: false,
      pipelineMode: 'doctr',
      decodingMethod: 'ctc',
      ...opts
    },
    opts: { stats: true }
  })

  return { onnxOcr, imagePath }
}

test('DocTR lifecycle - download models', { timeout: TEST_TIMEOUT }, async function (t) {
  // Use lighter mobilenet models to reduce memory pressure across many load/unload cycles
  const models = await ensureDoctrModels(['db_mobilenet_v3_large.onnx', 'crnn_mobilenet_v3_small.onnx'])
  DOCTR_DETECTOR = models.db_mobilenet_v3_large
  DOCTR_RECOGNIZER = models.crnn_mobilenet_v3_small
  t.ok(DOCTR_DETECTOR, 'db_mobilenet model available')
  t.ok(DOCTR_RECOGNIZER, 'crnn_mobilenet model available')
})

test('DocTR lifecycle - load, run, unload', { timeout: TEST_TIMEOUT }, async function (t) {
  const { onnxOcr, imagePath } = await createDoctrOcr()

  await onnxOcr.load()
  t.pass('DocTR model loaded successfully')

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

    t.pass('DocTR run completed successfully')
  } finally {
    await safeUnload(onnxOcr)
    await new Promise(resolve => setTimeout(resolve, 2000))
  }
})

test('DocTR lifecycle - load, unload, reload produces consistent results', { timeout: TEST_TIMEOUT * 2 }, async function (t) {
  const { onnxOcr, imagePath } = await createDoctrOcr()

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

  await safeUnload(onnxOcr)
  t.pass('Unload successful')
  await new Promise(resolve => setTimeout(resolve, 2000))

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

    t.pass('DocTR model reload produced consistent results')
  } finally {
    await safeUnload(onnxOcr)
    await new Promise(resolve => setTimeout(resolve, 2000))
  }
})

test('DocTR lifecycle - double unload does not crash', { timeout: TEST_TIMEOUT }, async function (t) {
  const { onnxOcr } = await createDoctrOcr()

  await onnxOcr.load()
  t.pass('DocTR model loaded')

  await safeUnload(onnxOcr)
  t.pass('First unload successful')

  try {
    await onnxOcr.unload()
    t.pass('Second unload did not throw')
  } catch (err) {
    t.comment('Second unload threw: ' + err.message)
    t.pass('Second unload threw an error (acceptable behavior)')
  }

  await new Promise(resolve => setTimeout(resolve, 2000))
})

test('DocTR lifecycle - run before load throws error', { timeout: TEST_TIMEOUT }, async function (t) {
  const { onnxOcr, imagePath } = await createDoctrOcr()

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

test('DocTR lifecycle - run after unload throws error', { timeout: TEST_TIMEOUT }, async function (t) {
  const { onnxOcr, imagePath } = await createDoctrOcr()

  await onnxOcr.load()
  await safeUnload(onnxOcr)
  await new Promise(resolve => setTimeout(resolve, 2000))

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

test('DocTR lifecycle - cancellation during inference does not crash', { timeout: TEST_TIMEOUT }, async function (t) {
  const { onnxOcr, imagePath } = await createDoctrOcr()

  await onnxOcr.load()

  try {
    const response = await onnxOcr.run({
      path: imagePath,
      options: { paragraph: false }
    })

    if (onnxOcr.addon && onnxOcr.addon.cancel) {
      await onnxOcr.addon.cancel()
      t.pass('Cancel called without crashing')
    } else {
      t.comment('addon.cancel not available, skipping cancel test')
    }

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

    t.pass('DocTR cancellation handled gracefully')
  } finally {
    try {
      await safeUnload(onnxOcr)
    } catch (err) {
      t.comment('Unload after cancel: ' + err.message)
    }
    await new Promise(resolve => setTimeout(resolve, 2000))
  }
})

test('DocTR lifecycle - recognizerBatchSize is accepted', { timeout: TEST_TIMEOUT }, async function (t) {
  const imagePath = getImagePath('/test/images/english.bmp')
  const { onnxOcr } = await createDoctrOcr({ recognizerBatchSize: 8 })

  await onnxOcr.load()

  try {
    const response = await onnxOcr.run({
      path: imagePath,
      options: { paragraph: false }
    })

    await response
      .onUpdate(output => {
        t.ok(Array.isArray(output), 'Output with recognizerBatchSize=8 should be an array')
        t.ok(output.length > 0, 'Should still detect text with recognizerBatchSize=8')
        t.comment('Detected ' + output.length + ' regions with recognizerBatchSize=8')
      })
      .onError(error => {
        t.fail('Unexpected error with recognizerBatchSize: ' + JSON.stringify(error))
      })
      .await()

    t.pass('recognizerBatchSize parameter accepted by DocTR pipeline')
  } finally {
    await safeUnload(onnxOcr)
    await new Promise(resolve => setTimeout(resolve, 2000))
  }
})
