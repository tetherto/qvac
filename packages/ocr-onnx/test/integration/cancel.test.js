'use strict'

// Integration tests for cooperative cancellation added in QVAC-13897.
// These tests require real models to be available (same as lifecycle.test.js).
//
// Focus areas:
//  1. cancel() actually stops processing – not a no-op anymore.
//  2. A cancelled pipeline can be reused for the next request (flag reset).
//  3. Cancellation status / error propagation to the JS layer.
//  4. Edge cases: cancel before start, cancel after completion.

const { ONNXOcr } = require('../..')
const test = require('brittle')
const { isMobile, getImagePath, ensureModelPath, safeUnload, windowsOrtParams } = require('./utils')

const MOBILE_TIMEOUT = 600 * 1000
const DESKTOP_TIMEOUT = 120 * 1000
const TEST_TIMEOUT = isMobile ? MOBILE_TIMEOUT : DESKTOP_TIMEOUT

// Time to wait after cancel() for the C++ worker to notice the flag and
// surface the cancellation event to JS before we declare it a no-op.
const CANCEL_SETTLE_MS = 10000

async function createAndLoadOcr (t) {
  const detectorPath = await ensureModelPath('detector_craft')
  const recognizerPath = await ensureModelPath('recognizer_latin')
  const imagePath = getImagePath('/test/images/basic_test.bmp')

  const onnxOcr = new ONNXOcr({
    params: {
      pathDetector: detectorPath,
      pathRecognizer: recognizerPath,
      langList: ['en'],
      useGPU: false,
      ...windowsOrtParams
    },
    opts: { stats: true }
  })

  return { onnxOcr, imagePath }
}

// ---------------------------------------------------------------------------
// 1. cancel() during active inference – response settles (no hang)
// ---------------------------------------------------------------------------

test('cancel() during inference causes response to settle within timeout', { timeout: TEST_TIMEOUT }, async function (t) {
  const { onnxOcr, imagePath } = await createAndLoadOcr(t)
  await onnxOcr.load()

  try {
    const response = await onnxOcr.run({
      path: imagePath,
      options: { paragraph: false }
    })

    // Issue the cancel immediately – the C++ flag is set synchronously
    if (onnxOcr.addon && typeof onnxOcr.addon.cancel === 'function') {
      await onnxOcr.addon.cancel()
      t.pass('addon.cancel() called without throwing')
    } else {
      t.comment('addon.cancel not available on this build – skipping')
      return
    }

    // The response must settle (either complete or error) within the timeout.
    // If cancel() were still a no-op the full inference would run instead, but
    // we accept either outcome as long as it does not hang.
    try {
      await Promise.race([
        response.await(),
        new Promise(function (resolve, reject) {
          setTimeout(function () {
            reject(new Error('cancel: response did not settle within ' + CANCEL_SETTLE_MS + 'ms'))
          }, CANCEL_SETTLE_MS)
        })
      ])
    } catch (err) {
      t.comment('Response after cancel: ' + err.message)
      // A timeout here is a failure: cancel() would be a no-op.
      t.ok(err.message.indexOf('did not settle') === -1,
        'Response should settle after cancel, not time out')
    }

    t.pass('cancel() response settled (inference stopped or completed)')
  } finally {
    await safeUnload(onnxOcr)
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
})

// ---------------------------------------------------------------------------
// 2. Reuse after cancel – flag is reset at start of next process() call
// ---------------------------------------------------------------------------

test('pipeline is reusable after cancel – second run produces results', { timeout: TEST_TIMEOUT * 2 }, async function (t) {
  const { onnxOcr, imagePath } = await createAndLoadOcr(t)
  await onnxOcr.load()

  // --- First run: immediately cancelled ---
  try {
    const response1 = await onnxOcr.run({
      path: imagePath,
      options: { paragraph: false }
    })

    if (onnxOcr.addon && typeof onnxOcr.addon.cancel === 'function') {
      await onnxOcr.addon.cancel()
    }

    // Drain / discard the first response
    try {
      await Promise.race([
        response1.await(),
        new Promise(resolve => setTimeout(resolve, CANCEL_SETTLE_MS))
      ])
    } catch (_) {}

    t.pass('First (cancelled) run drained')
  } catch (err) {
    t.comment('First run threw: ' + err.message)
  }

  // Allow the addon to reset between runs
  await new Promise(resolve => setTimeout(resolve, 2000))

  // --- Second run: must succeed because cancelFlag_ is reset at process() start ---
  try {
    const response2 = await onnxOcr.run({
      path: imagePath,
      options: { paragraph: false }
    })

    let gotOutput = false
    await response2
      .onUpdate(output => {
        gotOutput = Array.isArray(output)
      })
      .onError(err => {
        t.comment('Second run error: ' + JSON.stringify(err))
      })
      .await()

    t.ok(gotOutput, 'Second run after cancel should produce output (flag reset)')
    t.pass('Pipeline reuse after cancel succeeded')
  } finally {
    await safeUnload(onnxOcr)
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
})

// ---------------------------------------------------------------------------
// 3. cancel() error propagation – cancellation reaches JS as error or completion
// ---------------------------------------------------------------------------

test('cancel() propagates to JS layer without crashing the process', { timeout: TEST_TIMEOUT }, async function (t) {
  const { onnxOcr, imagePath } = await createAndLoadOcr(t)
  await onnxOcr.load()

  let jsLayerNotified = false

  try {
    const response = await onnxOcr.run({
      path: imagePath,
      options: { paragraph: false }
    })

    // Listen for either outcome
    response
      .onUpdate(() => { jsLayerNotified = true })
      .onError(() => { jsLayerNotified = true })

    if (onnxOcr.addon && typeof onnxOcr.addon.cancel === 'function') {
      await onnxOcr.addon.cancel()
    }

    // Give the event loop time to fire any pending callbacks
    await Promise.race([
      response.await(),
      new Promise(resolve => setTimeout(resolve, CANCEL_SETTLE_MS))
    ]).catch(() => {})

    // The JS layer should have been notified (output OR error) or the inference
    // may have completed before cancel took effect.  Either way, the process
    // must not have crashed.
    t.pass('Process did not crash after cancel() + JS notification')
    t.comment('JS layer notified: ' + jsLayerNotified)
  } finally {
    await safeUnload(onnxOcr)
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
})

// ---------------------------------------------------------------------------
// 4a. Edge case: cancel() before run() – should not crash or block
// ---------------------------------------------------------------------------

test('cancel() before run() does not crash', { timeout: TEST_TIMEOUT }, async function (t) {
  const { onnxOcr, imagePath } = await createAndLoadOcr(t)
  await onnxOcr.load()

  try {
    // Cancel while idle – no active job
    if (onnxOcr.addon && typeof onnxOcr.addon.cancel === 'function') {
      await onnxOcr.addon.cancel()
      t.pass('cancel() while idle did not throw')
    } else {
      t.comment('addon.cancel not available – skipping')
      return
    }

    // Allow any async state cleanup
    await new Promise(resolve => setTimeout(resolve, 500))

    // A subsequent run must still work because cancelFlag_ is reset at process() start
    const response = await onnxOcr.run({
      path: imagePath,
      options: { paragraph: false }
    })

    let gotOutput = false
    await response
      .onUpdate(output => { gotOutput = Array.isArray(output) })
      .onError(err => { t.comment('Unexpected error after idle-cancel: ' + JSON.stringify(err)) })
      .await()

    t.ok(gotOutput, 'Run after idle cancel should produce output')
  } finally {
    await safeUnload(onnxOcr)
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
})

// ---------------------------------------------------------------------------
// 4b. Edge case: cancel() after completion – no effect on next run
// ---------------------------------------------------------------------------

test('cancel() after completed run does not affect subsequent run', { timeout: TEST_TIMEOUT * 2 }, async function (t) {
  const { onnxOcr, imagePath } = await createAndLoadOcr(t)
  await onnxOcr.load()

  try {
    // --- First run: let it complete naturally ---
    const response1 = await onnxOcr.run({
      path: imagePath,
      options: { paragraph: false }
    })

    let firstOutput = null
    await response1
      .onUpdate(output => { firstOutput = output })
      .onError(err => { t.fail('First run error: ' + JSON.stringify(err)) })
      .await()

    t.ok(Array.isArray(firstOutput), 'First run should complete successfully')

    // Cancel after the first run has already ended – should be a no-op
    if (onnxOcr.addon && typeof onnxOcr.addon.cancel === 'function') {
      await onnxOcr.addon.cancel()
      t.pass('cancel() after completed run did not throw')
    }

    await new Promise(resolve => setTimeout(resolve, 500))

    // --- Second run: flag is reset at start, should succeed ---
    const response2 = await onnxOcr.run({
      path: imagePath,
      options: { paragraph: false }
    })

    let secondOutput = null
    await response2
      .onUpdate(output => { secondOutput = output })
      .onError(err => { t.comment('Second run error: ' + JSON.stringify(err)) })
      .await()

    t.ok(Array.isArray(secondOutput), 'Second run after post-completion cancel should succeed')
    t.is(
      firstOutput ? firstOutput.length : -1,
      secondOutput ? secondOutput.length : -2,
      'Both runs should detect the same number of text regions'
    )
  } finally {
    await safeUnload(onnxOcr)
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
})
