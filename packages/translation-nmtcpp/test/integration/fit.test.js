'use strict'

const test = require('brittle')
const fs = require('bare-fs')
const os = require('bare-os')
const path = require('bare-path')
const process = require('bare-process')
const TranslationNmtcpp = require('../../index.js')
const { ensureIndicTransModel, ensureBergamotModel, TEST_TIMEOUT } = require('./utils')

test('fit rejects a relative model path before native use', (t) => {
  let error
  try {
    TranslationNmtcpp.assessFit({
      files: { model: 'model.bin' },
      config: { modelType: TranslationNmtcpp.ModelTypes.IndicTrans }
    })
  } catch (caught) {
    error = caught
  }
  t.ok(error instanceof TypeError)
  t.ok(error && error.message.includes('absolute path'))
})

test('fit reports a missing model without loading it', (t) => {
  const result = TranslationNmtcpp.assessFit({
    files: { model: path.resolve(__dirname, 'missing-model.bin') },
    config: { modelType: TranslationNmtcpp.ModelTypes.IndicTrans }
  })
  t.is(result.status, 'error')
  t.is(result.reason, 'model-unreadable')
  t.is(result.modelBytes, 0)
})

test('fit reads model, pivot, and vocab files below a Unicode directory', (t) => {
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

    const fit = TranslationNmtcpp.assessFit({
      files,
      config: { modelType: TranslationNmtcpp.ModelTypes.Bergamot }
    })
    t.is(fit.modelBytes, 64 * 6)
    t.ok(!fit.report.includes('unreadable'), 'every UTF-8 path was inspected')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

function checkRealModelFit(t, request) {
  const fit = TranslationNmtcpp.assessFit(request)
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
  const reserved = TranslationNmtcpp.assessFit({
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
    checkRealModelFit(t, {
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
    const automatic = TranslationNmtcpp.assessFit({ files, config })
    const conflicting = TranslationNmtcpp.assessFit({
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

    checkRealModelFit(t, {
      files: {
        model: path.join(modelDir, modelName),
        srcVocab: path.join(modelDir, vocabName),
        dstVocab: path.join(modelDir, vocabName)
      },
      config: { modelType: TranslationNmtcpp.ModelTypes.Bergamot }
    })
  }
)
