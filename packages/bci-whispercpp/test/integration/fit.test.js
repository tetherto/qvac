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
const isVerdict = (fit) => fit.status === 'fits' || fit.status === 'does-not-fit'
const hostRow = (fit) => fit.devices[fit.devices.length - 1]
// Every row but the trailing host row.
const deviceRows = (fit) => fit.devices.slice(0, -1)
const demand = (fit) => fit.devices.map((row) => [row.id, row.usedBytes])

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

test('a projection lists the device it uses, the host last', async (t) => {
  const fit = await assessFit({
    modelPath: MODEL_DESCRIPTION_PATH,
    embedderPath: EMBEDDER_DESCRIPTION_PATH
  })

  t.comment(JSON.stringify(fit))
  t.ok(isVerdict(fit), 'a verdict')
  t.ok(fit.devices.length >= 1, 'at least the host row')
  t.is(hostRow(fit).name, 'CPU', 'the host row is last')
  t.ok(hostRow(fit).unified, 'the host row is unified')
  t.alike(fit.stats, {})
  for (const row of fit.devices) {
    t.ok(row.id.length > 0 && row.name.length > 0, `${row.name} is named`)
    t.ok(row.usedBytes > 0, `${row.name} has a demand`)
    t.ok(row.freeBytes <= row.totalBytes, `${row.name} has free within total`)
  }
})

test('the embedder is part of the host demand', async (t) => {
  const small = await assessFit({
    modelPath: MODEL_DESCRIPTION_PATH,
    embedderPath: SMALL_EMBEDDER_PATH
  })
  const full = await assessFit({
    modelPath: MODEL_DESCRIPTION_PATH,
    embedderPath: EMBEDDER_DESCRIPTION_PATH
  })

  t.alike(
    deviceRows(full).map((row) => row.usedBytes),
    deviceRows(small).map((row) => row.usedBytes),
    'the embedder is outside the device demand'
  )
  t.ok(hostRow(full).usedBytes > hostRow(small).usedBytes, 'and inside the host demand')
})

test('with no embedder named, the one beside the model is measured', async (t) => {
  if (skipWithoutModel(t)) return
  if (!fs.existsSync(EMBEDDER_PATH)) {
    t.pass('no embedder on this runner')
    return
  }

  const colocated = await assessFit({ modelPath: MODEL_PATH })
  const named = await assessFit({ modelPath: MODEL_PATH, embedderPath: EMBEDDER_PATH })

  t.alike(demand(colocated), demand(named))
})

test('a model with no embedder beside it rejects', async (t) => {
  await t.exception(
    assessFit({ modelPath: copyIntoEmptyDirectory(t, MODEL_DESCRIPTION_PATH) }),
    /embedder-unreadable/,
    'a load would not find the embedder either'
  )
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

  t.is(descriptions.status, files.status, 'the same verdict')
  t.alike(demand(descriptions), demand(files), 'the same demand on the same devices')
})

test('an embedder description measures like the embedder file', async (t) => {
  const file = await assessFit({
    modelPath: MODEL_DESCRIPTION_PATH,
    embedderPath: SMALL_EMBEDDER_PATH
  })
  const description = await assessFit({
    modelPath: MODEL_DESCRIPTION_PATH,
    embedderPath: SMALL_EMBEDDER_DESCRIPTION_PATH
  })

  t.alike(demand(description), demand(file))
})

test('an embedder that cannot be read rejects', async (t) => {
  await t.exception(
    assessFit({ modelPath: MODEL_DESCRIPTION_PATH, embedderPath: '/nonexistent/embedder.bin' }),
    /embedder-unreadable/
  )
})

test('a model that cannot be read rejects', async (t) => {
  await t.exception(
    assessFit({ modelPath: '/nonexistent/model.bin', embedderPath: SMALL_EMBEDDER_PATH }),
    /assessFit: /
  )
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

  t.ok(isVerdict(fit), 'a real native projection completed')
  t.ok(ticks > 0, 'the loop turned before the fit settled')
  t.comment(`${ticks} loop turns before completion`)
})

test('concurrent fits each keep their own request and all settle', async (t) => {
  const request = { modelPath: MODEL_DESCRIPTION_PATH, embedderPath: SMALL_EMBEDDER_PATH }
  const first = assessFit(request)
  request.embedderPath = '/nonexistent/embedder.bin'
  const second = assessFit(request)
  const third = assessFit({ modelPath: MODEL_DESCRIPTION_PATH, embedderPath: SMALL_EMBEDDER_PATH })

  const [a, b, c] = await Promise.allSettled([first, second, third])

  t.is(a.status, 'fulfilled', 'the first call owns its original request')
  t.is(b.status, 'rejected', 'the second call owns its changed request')
  t.is(c.status, 'fulfilled', 'a rejection does not strand the calls queued behind it')
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

    t.ok(isVerdict(fit), 'the projection outlived the instance')
  }
)
