'use strict'

const fs = require('bare-fs')
const os = require('bare-os')
const path = require('bare-path')
const test = require('brittle')

const BCIWhispercpp = require('../../index.js')
const { assessFit } = require('../../index.js')
const {
  BCI_TEST_THREADS,
  getMobileAssetPath,
  getMobileAssetsDir,
  getModelPath,
  isMobile
} = require('./helpers.js')

const MODEL_FILE = 'ggml-bci-windowed.bin'
const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures')
const SMALL_EMBEDDER_DIR = path.join(__dirname, '..', '..', 'addon', 'tests', 'fixtures')
const SCRATCH_PREFIX = 'bci-fit-'

function testAssetPath(directory, filename) {
  return isMobile ? getMobileAssetPath(filename) : path.join(directory, filename)
}

const MODEL_PATH =
  (os.hasEnv('WHISPER_MODEL_PATH') ? os.getEnv('WHISPER_MODEL_PATH') : null) ||
  getModelPath(MODEL_FILE)

const EMBEDDER_PATH = path.join(path.dirname(MODEL_PATH), 'bci-embedder.bin')

const MODEL_DESCRIPTION_PATH = testAssetPath(FIXTURES_DIR, 'ggml-bci-windowed.fit.gguf')
const EMBEDDER_DESCRIPTION_PATH = testAssetPath(FIXTURES_DIR, 'bci-embedder.fit.gguf')

const SMALL_EMBEDDER_PATH = testAssetPath(SMALL_EMBEDDER_DIR, 'bci-embedder-small.bin')
const SMALL_EMBEDDER_DESCRIPTION_PATH = testAssetPath(
  SMALL_EMBEDDER_DIR,
  'bci-embedder-small.fit.gguf'
)
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

function scratchRoot() {
  return isMobile ? getMobileAssetsDir() : os.tmpdir()
}

function copyIntoEmptyDirectory(t, filePath) {
  const directory = fs.mkdtempSync(path.join(scratchRoot(), SCRATCH_PREFIX))
  t.teardown(() => fs.rmSync(directory, { recursive: true, force: true }))

  const copy = path.join(directory, path.basename(filePath))
  fs.copyFileSync(filePath, copy)
  return copy
}

test('a projection is internally consistent', async (t) => {
  if (skipWithoutModel(t)) return

  const fit = await assessFit({ modelPath: MODEL_PATH })

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

test('the embedder is part of the host demand', async (t) => {
  if (skipWithoutModel(t)) return
  if (!fs.existsSync(EMBEDDER_PATH)) {
    t.pass('no embedder on this runner')
    return
  }

  const small = await assessFit({ modelPath: MODEL_PATH, embedderPath: SMALL_EMBEDDER_PATH })
  const full = await assessFit({ modelPath: MODEL_PATH, embedderPath: EMBEDDER_PATH })

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

test('with no embedder named, the one beside the model is measured', async (t) => {
  if (skipWithoutModel(t)) return
  if (!fs.existsSync(EMBEDDER_PATH)) {
    t.pass('no embedder on this runner')
    return
  }

  const colocated = await assessFit({ modelPath: MODEL_PATH })
  const named = await assessFit({ modelPath: MODEL_PATH, embedderPath: EMBEDDER_PATH })

  t.is(colocated.embedderBytes, named.embedderBytes)
  t.is(colocated.hostBytes, named.hostBytes)
})

test('a model with no embedder beside it is an outcome, not a rejection', async (t) => {
  const fit = await assessFit({ modelPath: copyIntoEmptyDirectory(t, MODEL_DESCRIPTION_PATH) })

  t.is(fit.status, 'error')
  t.is(fit.reason, 'embedder-unreadable', 'a load would not find the embedder either')
})

test('the registry descriptions project like the model and embedder they describe', async (t) => {
  if (skipWithoutModel(t)) return
  if (!fs.existsSync(EMBEDDER_PATH)) {
    t.pass('no embedder on this runner')
    return
  }

  const files = await assessFit({ modelPath: MODEL_PATH, embedderPath: EMBEDDER_PATH })
  const descriptions = await assessFit({
    modelPath: MODEL_DESCRIPTION_PATH,
    embedderPath: EMBEDDER_DESCRIPTION_PATH
  })

  for (const field of PROJECTED_FIELDS) {
    t.is(descriptions[field], files[field], `${field} matches`)
  }
})

test('an embedder description measures like the embedder file', async (t) => {
  const file = await assessFit({
    modelPath: '/nonexistent/model.bin',
    embedderPath: SMALL_EMBEDDER_PATH
  })
  const description = await assessFit({
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

test('an embedder that cannot be read is an outcome, not a rejection', async (t) => {
  if (skipWithoutModel(t)) return

  const fit = await assessFit({ modelPath: MODEL_PATH, embedderPath: '/nonexistent/embedder.bin' })

  t.is(fit.status, 'error')
  t.is(fit.reason, 'embedder-unreadable')
  t.is(fit.embedderBytes, 0)
})

test('a model that cannot be read is an outcome, not a rejection', async (t) => {
  const fit = await assessFit({ modelPath: '/nonexistent/model.bin' })

  t.is(fit.status, 'error')
  t.ok(fit.reason.length > 0, 'the engine gave a reason')
})

test('every projected field is present on an unreadable model', async (t) => {
  const fit = await assessFit({ modelPath: '/nonexistent/model.bin' })

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

test('a count that is not a count is refused', async (t) => {
  const pending = assessFit({ modelPath: '/models/model.bin', decoders: -1 })

  t.ok(pending instanceof Promise, 'the refusal is a rejection, not a throw')
  await t.exception(pending, /non-negative count/)
})

test('a request without a model path rejects', async (t) => {
  await t.exception.all(assessFit({}))
})

test('the event loop keeps running while a fit is projected', async (t) => {
  const modelPath = hasModel ? MODEL_PATH : MODEL_DESCRIPTION_PATH
  let pending = true
  let ticks = 0
  const tick = () => {
    if (!pending) return
    ticks++
    setImmediate(tick)
  }
  setImmediate(tick)

  const fit = await assessFit({ modelPath, embedderPath: SMALL_EMBEDDER_PATH })
  pending = false

  t.ok(fit.weightsBytes > 0, 'a real native projection completed')
  t.ok(ticks > 0, 'the loop turned before the fit settled')
  t.comment(`${ticks} loop turns before completion`)
})

test('concurrent fits each keep their own request and all settle', async (t) => {
  const request = { modelPath: '/nonexistent/model.bin', embedderPath: SMALL_EMBEDDER_PATH }
  const first = assessFit(request)
  request.embedderPath = '/nonexistent/embedder.bin'
  const second = assessFit(request)
  const third = assessFit({ modelPath: '/nonexistent/model.bin' })

  const [a, b, c] = await Promise.all([first, second, third])

  t.is(a.embedderBytes, SMALL_EMBEDDER_HOST_BYTES, 'the first call owns its original request')
  t.is(b.embedderBytes, 0, 'the second call owns its changed request')
  t.is(c.status, 'error', 'an error outcome does not strand the calls queued behind it')
})

test(
  'a fit settles while a loaded model is destroyed',
  { skip: !hasModel, timeout: 120000 },
  async (t) => {
    const bci = new BCIWhispercpp(
      { files: { model: MODEL_PATH, embedder: EMBEDDER_PATH } },
      {
        whisperConfig: { language: 'en', temperature: 0.0, n_threads: BCI_TEST_THREADS },
        miscConfig: { caption_enabled: false }
      }
    )
    await bci.load()

    const pending = assessFit({ modelPath: MODEL_PATH, embedderPath: SMALL_EMBEDDER_PATH })
    await bci.destroy()
    const fit = await pending

    t.ok(fit.status === 'fits' || fit.status === 'does-not-fit', 'a verdict, not an error')
    t.ok(fit.weightsBytes > 0, 'the projection outlived the instance')
  }
)
