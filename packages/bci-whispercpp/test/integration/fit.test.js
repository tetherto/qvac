'use strict'

const fs = require('bare-fs')
const os = require('bare-os')
const path = require('bare-path')
const test = require('brittle')

const { assessFit } = require('../../index.js')
const { getModelPath } = require('./helpers.js')

const MODEL_PATH =
  (os.hasEnv('WHISPER_MODEL_PATH') ? os.getEnv('WHISPER_MODEL_PATH') : null) ||
  getModelPath('ggml-bci-windowed.bin')

const EMBEDDER_PATH = path.join(path.dirname(MODEL_PATH), 'bci-embedder.bin')

const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures')
const MODEL_DESCRIPTION_PATH = path.join(FIXTURES_DIR, 'ggml-bci-windowed.fit.gguf')
const EMBEDDER_DESCRIPTION_PATH = path.join(FIXTURES_DIR, 'bci-embedder.fit.gguf')

const SMALL_EMBEDDER_DIR = path.join(__dirname, '..', '..', 'addon', 'tests', 'fixtures')
const SMALL_EMBEDDER_PATH = path.join(SMALL_EMBEDDER_DIR, 'bci-embedder-small.bin')
const SMALL_EMBEDDER_DESCRIPTION_PATH = path.join(SMALL_EMBEDDER_DIR, 'bci-embedder-small.fit.gguf')
const SMALL_EMBEDDER_HOST_BYTES = 332

const PROJECTED_FIELDS = [
  'status',
  'modelType',
  'deviceName',
  'deviceTotalBytes',
  'deviceBytes',
  'weightsBytes',
  'kvBytes',
  'computeBytes',
  'hostOverflowBytes',
  'hostBytes',
  'embedderBytes'
]

const hasModel = fs.existsSync(MODEL_PATH)
const requireModel = os.hasEnv('BCI_REQUIRE_MODEL') && os.getEnv('BCI_REQUIRE_MODEL') === '1'

if (requireModel && !hasModel) {
  throw new Error(
    'BCI_REQUIRE_MODEL=1 but model file was not found at ' +
      MODEL_PATH +
      '. Run `npm run download-models` or set WHISPER_MODEL_PATH.'
  )
}

function skipWithoutModel(t) {
  if (hasModel) return false
  t.pass('no BCI model on this runner')
  return true
}

test('a projection is internally consistent', (t) => {
  if (skipWithoutModel(t)) return

  const fit = assessFit({ modelPath: MODEL_PATH })

  t.comment(`status=${fit.status} reason=${fit.reason} device=${fit.deviceName}`)
  t.ok(fit.status === 'fits' || fit.status === 'does-not-fit', 'a verdict, not an error')
  t.ok(fit.deviceTotalBytes > 0, 'the device reported its capacity')
  t.ok(fit.deviceFreeBytes <= fit.deviceTotalBytes, 'free never exceeds total')
  t.ok(fit.weightsBytes > 0, 'the weights were measured')
  t.ok(
    fit.deviceBytes >= fit.weightsBytes || fit.hostBytes >= fit.weightsBytes,
    'the weights are part of the demand'
  )
})

test('the embedder is part of the host demand', (t) => {
  if (skipWithoutModel(t)) return
  if (!fs.existsSync(EMBEDDER_PATH)) {
    t.pass('no embedder on this runner')
    return
  }

  const small = assessFit({ modelPath: MODEL_PATH, embedderPath: SMALL_EMBEDDER_PATH })
  const full = assessFit({ modelPath: MODEL_PATH, embedderPath: EMBEDDER_PATH })

  t.ok(full.embedderBytes > small.embedderBytes, 'the embedder weights were measured')
  t.ok(
    full.embedderBytes < fs.statSync(EMBEDDER_PATH).size,
    'only what the embedder keeps, not the convolution weights it drops'
  )
  t.is(full.deviceBytes, small.deviceBytes, 'the embedder is outside the device demand')
  t.is(
    full.hostBytes - small.hostBytes,
    full.embedderBytes - small.embedderBytes,
    'and inside the host demand'
  )
})

test('with no embedder named, the one beside the model is measured', (t) => {
  if (skipWithoutModel(t)) return
  if (!fs.existsSync(EMBEDDER_PATH)) {
    t.pass('no embedder on this runner')
    return
  }

  const colocated = assessFit({ modelPath: MODEL_PATH })
  const named = assessFit({ modelPath: MODEL_PATH, embedderPath: EMBEDDER_PATH })

  t.is(colocated.embedderBytes, named.embedderBytes)
  t.is(colocated.hostBytes, named.hostBytes)
})

test('a model with no embedder beside it is an outcome, not a throw', (t) => {
  const fit = assessFit({ modelPath: MODEL_DESCRIPTION_PATH })

  t.is(fit.status, 'error')
  t.is(fit.reason, 'embedder-unreadable', 'a load would not find the embedder either')
})

test('the registry descriptions project like the model and embedder they describe', (t) => {
  if (skipWithoutModel(t)) return
  if (!fs.existsSync(EMBEDDER_PATH)) {
    t.pass('no embedder on this runner')
    return
  }

  const files = assessFit({ modelPath: MODEL_PATH, embedderPath: EMBEDDER_PATH })
  const descriptions = assessFit({
    modelPath: MODEL_DESCRIPTION_PATH,
    embedderPath: EMBEDDER_DESCRIPTION_PATH
  })

  for (const field of PROJECTED_FIELDS) {
    t.is(descriptions[field], files[field], `${field} matches`)
  }
})

test('an embedder description measures like the embedder file', (t) => {
  const file = assessFit({ modelPath: '/nonexistent/model.bin', embedderPath: SMALL_EMBEDDER_PATH })
  const description = assessFit({
    modelPath: '/nonexistent/model.bin',
    embedderPath: SMALL_EMBEDDER_DESCRIPTION_PATH
  })

  t.is(
    file.embedderBytes,
    SMALL_EMBEDDER_HOST_BYTES,
    'projections, session map and projection cache'
  )
  t.is(description.embedderBytes, file.embedderBytes)
})

test('an embedder that cannot be read is an outcome, not a throw', (t) => {
  if (skipWithoutModel(t)) return

  const fit = assessFit({ modelPath: MODEL_PATH, embedderPath: '/nonexistent/embedder.bin' })

  t.is(fit.status, 'error')
  t.is(fit.reason, 'embedder-unreadable')
  t.is(fit.embedderBytes, 0)
})

test('a model that cannot be read is an outcome, not a throw', (t) => {
  const fit = assessFit({ modelPath: '/nonexistent/model.bin' })

  t.is(fit.status, 'error')
  t.ok(fit.reason.length > 0, 'the engine gave a reason')
})

test('every projected field is present on an unreadable model', (t) => {
  const fit = assessFit({ modelPath: '/nonexistent/model.bin' })

  for (const field of [
    'deviceFreeBytes',
    'deviceTotalBytes',
    'deviceBytes',
    'weightsBytes',
    'kvBytes',
    'computeBytes',
    'hostOverflowBytes',
    'hostBytes',
    'embedderBytes'
  ]) {
    t.is(typeof fit[field], 'number', `${field} is a number`)
  }
})

test('a count that is not a count is refused', (t) => {
  t.exception(
    () => assessFit({ modelPath: '/models/model.bin', decoders: -1 }),
    /non-negative count/
  )
})
