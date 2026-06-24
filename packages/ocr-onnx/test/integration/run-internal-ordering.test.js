'use strict'

// Regression test for #1756.
//
// The native OCR binding fires output/stats/error callbacks synchronously
// from inside `binding.runJob(...)`. If `_runInternal` awaits `runJob` before
// calling `_job.start()`, those callbacks land while the job handler has no
// active QvacResponse and are silently dropped. This test pins the ordering
// by stubbing `this.addon` with a `runJob` that mirrors the native semantics
// (callbacks fired synchronously inside the call) and asserts the response
// receives them.

const test = require('brittle')
const { ONNXOcr } = require('../..')

function createOcr () {
  const ocr = new ONNXOcr({
    params: {
      pathDetector: 'unused',
      pathRecognizer: 'unused',
      langList: ['en']
    },
    opts: { stats: true }
  })

  ocr.getImage = () => ({ data: Buffer.from('stub'), isEncoded: true })

  return ocr
}

test('output callbacks fired synchronously inside runJob are not dropped', async t => {
  const ocr = createOcr()
  const expectedOutput = [[[[0, 0], [10, 0], [10, 10], [0, 10]], 'hello', 0.99]]

  ocr.addon = {
    runJob: async () => {
      ocr._addonOutputCallback(ocr.addon, 'Output', expectedOutput)
      ocr._addonOutputCallback(ocr.addon, 'JobEnded', { totalTime: 1 })
    },
    cancel: () => {}
  }

  const response = await ocr.run({ path: 'stub' })
  const result = await response.await()

  t.alike(result, [expectedOutput], 'output emitted before runJob await must reach the response')
  t.alike(response.stats, { totalTime: 1 }, 'stats emitted before runJob await must reach the response')
})

test('error callbacks fired synchronously inside runJob are not dropped', async t => {
  const ocr = createOcr()

  ocr.addon = {
    runJob: async () => {
      ocr._addonOutputCallback(ocr.addon, 'Error', null, 'native failure')
    },
    cancel: () => {}
  }

  const response = await ocr.run({ path: 'stub' })
  await t.exception(response.await(), /native failure/, 'error emitted before runJob await must reach the response')
})

test('runJob rejection is routed through _job.fail and clears the active response', async t => {
  const ocr = createOcr()
  const failure = new Error('runJob rejected')

  ocr.addon = {
    runJob: async () => { throw failure },
    cancel: () => {}
  }

  await t.exception(ocr.run({ path: 'stub' }), /runJob rejected/, 'runJob rejection must propagate to the caller')
  t.is(ocr._job.active, null, 'failed run must clear the active response so the next start() does not see a stale job')
})
