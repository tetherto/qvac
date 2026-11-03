'use strict'

const test = require('brittle')
const fs = require('bare-fs')
const os = require('bare-os')
const path = require('bare-path')
const process = require('bare-process')
const TranslationNmtcpp = require('../../index.js')
const { ensureIndicTransModel, ensureBergamotModel, TEST_TIMEOUT } = require('./utils')

const OVERHEAD_BYTES = 512 * 1024 * 1024
const allowance = (sourceBytes) => sourceBytes * 4 + OVERHEAD_BYTES
const isVerdict = (fit) => fit.status === 'fits' || fit.status === 'does-not-fit'
const demand = (fit) => fit.devices.map((row) => [row.id, row.usedBytes])

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

test('a missing model rejects without loading it', async (t) => {
  await t.exception(
    TranslationNmtcpp.assessFit({
      files: { model: path.resolve(__dirname, 'missing-model.bin') },
      config: { modelType: TranslationNmtcpp.ModelTypes.IndicTrans }
    }),
    /cannot read the translation model/
  )
})

test('a main-gpu selection is unknown', async (t) => {
  const fit = await TranslationNmtcpp.assessFit({
    files: { model: path.resolve(__dirname, 'missing-model.bin') },
    config: { modelType: TranslationNmtcpp.ModelTypes.IndicTrans, 'main-gpu': 0 }
  })
  t.is(fit.status, 'unknown')
  t.alike(fit.devices, [])
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
    t.comment(JSON.stringify(fit))
    t.ok(isVerdict(fit), 'a verdict')
    t.is(fit.devices.length, 1, 'Bergamot runs on the CPU alone')
    t.ok(fit.devices[0].unified, 'the CPU row is the host')
    t.is(fit.devices[0].usedBytes, allowance(64 * 6), 'every UTF-8 path was inspected')
    t.alike(fit.stats, {})
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
    const [a, b, c] = await Promise.allSettled([first, second, missing])
    t.is(a.status, 'fulfilled', 'the first call read its files')
    t.is(a.value.devices[0].usedBytes, allowance(64 * 3), 'the first call owns its original files')
    t.ok(String(b.reason).includes('dstVocab'), 'the second call owns its changed files')
    t.is(c.status, 'rejected', 'a rejection does not strand queued callers')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

async function checkRealModelFit(t, request, sourceBytes) {
  const fit = await TranslationNmtcpp.assessFit(request)
  t.comment(JSON.stringify(fit))
  t.ok(isVerdict(fit) || fit.status === 'unknown', 'a verdict, or an explicit unknown')
  if (isVerdict(fit)) {
    t.is(fit.devices.length, 1, 'a CPU load is one row')
    t.ok(fit.devices[0].usedBytes > sourceBytes, 'the load allowance includes overhead')
    t.ok(fit.devices[0].freeBytes > 0, 'current memory was queried')
  } else {
    t.alike(fit.devices, [], 'an unknown carries no rows')
  }

  // The same real model cannot fit when the caller reserves every available
  // byte. This checks the capacity decision without assuming a runner's RAM.
  const reserved = await TranslationNmtcpp.assessFit({
    ...request,
    marginBytes: Number.MAX_SAFE_INTEGER
  })
  t.is(reserved.status, 'does-not-fit')
  t.is(reserved.devices.length, 1)
}

test(
  'fit assesses a real IndicTrans model without loading it',
  { timeout: TEST_TIMEOUT },
  async (t) => {
    const model = await ensureIndicTransModel()
    await checkRealModelFit(
      t,
      {
        files: { model },
        config: { modelType: TranslationNmtcpp.ModelTypes.IndicTrans, use_gpu: false }
      },
      fs.statSync(model).size
    )
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
    t.alike(
      conflicting.devices.map((row) => row.id),
      automatic.devices.map((row) => row.id)
    )
    if (isVerdict(automatic)) {
      t.is(automatic.devices.at(-1).name, 'CPU', 'the host row is last')
    }
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

    const model = path.join(modelDir, modelName)
    await checkRealModelFit(
      t,
      {
        files: {
          model,
          srcVocab: path.join(modelDir, vocabName),
          dstVocab: path.join(modelDir, vocabName)
        },
        config: { modelType: TranslationNmtcpp.ModelTypes.Bergamot }
      },
      fs.statSync(model).size
    )
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
  const expected = await TranslationNmtcpp.assessFit(request)
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
      fits.every((fit) => JSON.stringify(demand(fit)) === JSON.stringify(demand(expected))),
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
      t.ok(
        ['fits', 'does-not-fit', 'unknown'].includes(result.status),
        'the fit settled after the model unloaded'
      )
    } finally {
      await model.destroy()
    }
  }
)
