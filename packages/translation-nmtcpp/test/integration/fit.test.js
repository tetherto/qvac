'use strict'

const test = require('brittle')
const fs = require('bare-fs')
const os = require('bare-os')
const path = require('bare-path')
const process = require('bare-process')
const TranslationNmtcpp = require('../../index.js')
const { ensureIndicTransModel, ensureBergamotModel, TEST_TIMEOUT } = require('./utils')

test('fit rejects a relative model path before native use', async (t) => {
  let error
  try {
    await TranslationNmtcpp.assessFit({
      files: { model: 'model.bin' },
      config: { modelType: TranslationNmtcpp.ModelTypes.IndicTrans }
    })
  } catch (caught) {
    error = caught
  }
  t.ok(error instanceof TypeError)
  t.ok(error && error.message.includes('absolute path'))
})

test('a malformed native request rejects', async (t) => {
  const promise = TranslationNmtcpp.assessFit({
    files: { model: path.resolve(__dirname, 'missing-model.bin') },
    config: { modelType: TranslationNmtcpp.ModelTypes.IndicTrans },
    marginBytes: -1
  })
  t.ok(promise instanceof Promise)
  await t.exception(promise, /marginBytes/)
})

test('fit reports a missing model without loading it', async (t) => {
  const result = await TranslationNmtcpp.assessFit({
    files: { model: path.resolve(__dirname, 'missing-model.bin') },
    config: { modelType: TranslationNmtcpp.ModelTypes.IndicTrans }
  })
  t.is(result.status, 'error')
  t.is(result.reason, 'model-unreadable')
  t.is(result.modelBytes, 0)
})

test('fit reads model, pivot, and vocab files below a Unicode directory', async (t) => {
  const dir = path.join(os.tmpdir(), `nmt-fit-${process.pid}-${Date.now()}-módèles-日本語`)
  fs.mkdirSync(dir, { recursive: true })
  try {
    const files = {
      model: path.join(dir, 'model.intgemm.bin'),
      pivotModel: path.join(dir, 'pivot.intgemm.bin'),
      srcVocab: path.join(dir, 'src.spm'),
      dstVocab: path.join(dir, 'dst.spm'),
      pivotSrcVocab: path.join(dir, 'pivot-src.spm'),
      pivotDstVocab: path.join(dir, 'pivot-dst.spm')
    }
    for (const file of Object.values(files)) fs.writeFileSync(file, Buffer.alloc(64))

    const fit = await TranslationNmtcpp.assessFit({
      files,
      config: { modelType: TranslationNmtcpp.ModelTypes.Bergamot }
    })
    t.is(fit.modelBytes, 64 * 6)
    t.ok(!fit.report.includes('unreadable'), 'every UTF-8 path was inspected')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('queued fits keep their own requests and all settle', async (t) => {
  const dir = path.join(os.tmpdir(), `nmt-fit-queue-${process.pid}-${Date.now()}`)
  fs.mkdirSync(dir, { recursive: true })
  try {
    const files = {
      model: path.join(dir, 'model.intgemm.bin'),
      srcVocab: path.join(dir, 'src.spm'),
      dstVocab: path.join(dir, 'dst.spm')
    }
    for (const file of Object.values(files)) fs.writeFileSync(file, Buffer.alloc(64))
    const request = { files, config: { modelType: TranslationNmtcpp.ModelTypes.Bergamot } }

    const first = TranslationNmtcpp.assessFit(request)
    request.files = { ...files, dstVocab: path.join(dir, 'missing.spm') }
    const second = TranslationNmtcpp.assessFit(request)
    const missing = TranslationNmtcpp.assessFit({
      files: { model: path.join(dir, 'missing.bin') },
      config: { modelType: TranslationNmtcpp.ModelTypes.IndicTrans }
    })
    const [a, b, c] = await Promise.all([first, second, missing])
    t.is(a.modelBytes, 64 * 3, 'the first call owns its original files')
    t.ok(b.report.includes('dstVocab'), 'the second call owns its changed files')
    t.is(c.reason, 'model-unreadable', 'an error outcome does not strand queued callers')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

async function checkRealModelFit(t, request) {
  const fit = await TranslationNmtcpp.assessFit(request)
  t.comment(`backend=${fit.backend} status=${fit.status} reason=${fit.reason}`)
  t.ok(fit.modelBytes > 0, 'model file bytes were inspected')
  if (fit.freeBytes === 0) {
    t.is(fit.status, 'error')
    t.is(fit.reason, 'device-memory-unavailable')
    return
  }
  t.ok(fit.requiredBytes > fit.modelBytes, 'load allowance includes overhead')
  t.ok(fit.freeBytes > 0, 'current device memory was queried')
  t.ok(fit.report.includes('Translation load estimate:'), 'a readable report was returned')
  t.ok(
    fit.status === 'fits' ||
      fit.status === 'does-not-fit' ||
      (fit.status === 'error' && fit.reason === 'insufficient-evidence'),
    'the ordinary assessment has a capacity verdict or explicitly reports uncertainty'
  )

  // The same real model cannot fit when the caller reserves every available
  // byte. This checks the capacity decision without assuming a runner's RAM.
  const reserved = await TranslationNmtcpp.assessFit({
    ...request,
    marginBytes: Number.MAX_SAFE_INTEGER
  })
  t.is(reserved.status, 'does-not-fit')
  t.is(reserved.reason, 'does-not-fit')
  t.ok(reserved.modelBytes >= fit.modelBytes)
}

test(
  'fit assesses a real IndicTrans model without loading it',
  { timeout: TEST_TIMEOUT },
  async (t) => {
    const model = await ensureIndicTransModel()
    await checkRealModelFit(t, {
      files: { model },
      config: { modelType: TranslationNmtcpp.ModelTypes.IndicTrans, use_gpu: false }
    })
  }
)

test(
  'fit gives an empty canonical GPU backend precedence over its alias',
  { timeout: TEST_TIMEOUT },
  async (t) => {
    const model = await ensureIndicTransModel()
    const files = { model }
    const config = { modelType: TranslationNmtcpp.ModelTypes.IndicTrans, use_gpu: true }
    const automatic = await TranslationNmtcpp.assessFit({ files, config })
    const conflicting = await TranslationNmtcpp.assessFit({
      files,
      config: { ...config, gpu_backend: '', gpuBackend: 'no-such-backend' }
    })
    t.is(conflicting.status, automatic.status)
    t.is(conflicting.reason, automatic.reason)
    t.is(conflicting.backend, automatic.backend)
  }
)

test(
  'fit assesses a real Bergamot model without loading it',
  { timeout: TEST_TIMEOUT },
  async (t) => {
    const modelDir = await ensureBergamotModel()
    const names = fs.readdirSync(modelDir)
    const modelName = names.find((name) => name.includes('.intgemm'))
    const vocabName = names.find((name) => name.endsWith('.spm'))
    t.ok(modelName, 'Bergamot weights are available')
    t.ok(vocabName, 'Bergamot vocabulary is available')
    if (!modelName || !vocabName) return

    await checkRealModelFit(t, {
      files: {
        model: path.join(modelDir, modelName),
        srcVocab: path.join(modelDir, vocabName),
        dstVocab: path.join(modelDir, vocabName)
      },
      config: { modelType: TranslationNmtcpp.ModelTypes.Bergamot }
    })
  }
)

// A fit that ran on the JS thread would settle every call before a timer could
// fire, so a timer tick while fits are pending shows the loop stayed free.
test('fitting keeps the event loop responsive', { timeout: TEST_TIMEOUT }, async (t) => {
  const model = await ensureIndicTransModel()
  const request = {
    files: { model },
    config: { modelType: TranslationNmtcpp.ModelTypes.IndicTrans, use_gpu: false }
  }
  let pending = false
  let ticks = 0
  const timer = setInterval(() => {
    if (pending) ticks++
  }, 1)
  try {
    let fits = []
    for (let round = 0; round < 50 && ticks === 0; round++) {
      pending = true
      fits = await Promise.all(
        Array.from({ length: 16 }, () => TranslationNmtcpp.assessFit(request))
      )
      pending = false
    }
    t.ok(ticks > 0, 'timers ran before fitting settled')
    t.ok(
      fits.every((fit) => fit.modelBytes > 0),
      'every queued fit measured the model'
    )
    t.comment(`${ticks} timer ticks before completion`)
  } finally {
    pending = false
    clearInterval(timer)
  }
})

test(
  'a fit keeps the backend while a loaded model unloads',
  { timeout: TEST_TIMEOUT },
  async (t) => {
    const modelPath = await ensureIndicTransModel()
    const config = { modelType: TranslationNmtcpp.ModelTypes.IndicTrans, use_gpu: false }
    const model = new TranslationNmtcpp({
      files: { model: modelPath },
      params: { mode: 'full', srcLang: 'eng_Latn', dstLang: 'hin_Deva' },
      config
    })
    try {
      await model.load()
      const fit = TranslationNmtcpp.assessFit({ files: { model: modelPath }, config })
      await model.unload()
      const result = await fit
      t.ok(result.backend.length > 0, 'the backend name survives the model unloading')
      t.not(result.reason, 'device-unavailable', 'the fit device stayed available')
    } finally {
      await model.destroy()
    }
  }
)
