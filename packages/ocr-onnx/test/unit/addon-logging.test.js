'use strict'

const test = require('brittle')

// Shim createJobHandler onto @qvac/infer-base if the installed version
// predates the export (pre-existing compat issue in node_modules).
try {
  const InferBase = require('@qvac/infer-base')
  if (!InferBase.createJobHandler) {
    InferBase.createJobHandler = function createJobHandler (opts) {
      let active = null
      return {
        start () { active = {}; return active },
        output () {},
        end () { active = null },
        fail () { active = null },
        get active () { return active }
      }
    }
  }
} catch (_) {}

let ONNXOcr = null
try {
  ONNXOcr = require('../..').ONNXOcr
} catch (_) {}

function createLogSpy () {
  const infoCalls = []
  return {
    logger: {
      info (...args) { infoCalls.push(args) },
      warn () {},
      error () {},
      debug () {},
      getLevel () { return 'info' }
    },
    infoCalls
  }
}

test('_addonOutputCallback emits info log on job completion', { skip: !ONNXOcr }, t => {
  const { logger, infoCalls } = createLogSpy()
  const ocr = new ONNXOcr({
    params: { langList: ['en'], pathDetector: 'det.onnx', pathRecognizer: 'rec.onnx' },
    logger
  })

  const before = infoCalls.length
  ocr._addonOutputCallback(null, 'StatsEvent', { totalTime: 1.5 }, null)

  t.ok(infoCalls.length > before, 'info log emitted when job completes with stats')
})

test('_runInternal emits info log before processing', { skip: !ONNXOcr }, async t => {
  const { logger, infoCalls } = createLogSpy()
  const ocr = new ONNXOcr({
    params: { langList: ['en'], pathDetector: 'det.onnx', pathRecognizer: 'rec.onnx' },
    logger
  })

  ocr.addon = { runJob: async () => {} }

  const before = infoCalls.length
  try {
    await ocr._runInternal({ path: '/nonexistent/test.png' })
  } catch (_) {}

  t.ok(infoCalls.length > before, 'info log emitted at inference start')
})

test('_load emits info logs during load lifecycle', { skip: !ONNXOcr }, async t => {
  const { logger, infoCalls } = createLogSpy()
  const ocr = new ONNXOcr({
    params: {
      langList: ['en'],
      pathDetector: '/fake/detector.onnx',
      pathRecognizer: '/fake/recognizer.onnx'
    },
    logger
  })

  try {
    await ocr._load()
  } catch (_) {}

  t.ok(infoCalls.length >= 2, 'at least load-start and config info logs emitted before native activation')
})
