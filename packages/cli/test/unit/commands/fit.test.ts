import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { FitSettingError, parseSettings, settingsFor } from '@/fit/settings'
import { formatCatalog, formatFit } from '@/fit/format'
import { assessCatalog, catalogModels } from '@/fit/catalog'
import type { ModelFitResponse } from '@/serve/core/fit'

const GIB = 1024 ** 3

describe('parseSettings', () => {
  it('reads a setting for every model and one for a named model', () => {
    const settings = parseSettings(['ctx_size=8192', 'big:ctx_size=0'])
    assert.deepEqual(settingsFor(settings, 'big', 'llm'), { ctx_size: 0 })
    assert.deepEqual(settingsFor(settings, 'small', 'llm'), { ctx_size: 8192 })
  })

  it('applies a setting for a model type to the models of that type only', () => {
    const settings = parseSettings(['llm:ctx_size=0', 'verbosity=1'])
    assert.deepEqual(settingsFor(settings, 'big', 'llm'), { verbosity: 1, ctx_size: 0 })
    assert.deepEqual(settingsFor(settings, 'voice', 'tts'), { verbosity: 1 })
  })

  it('lets a model setting win over its type and over every model, whatever the order', () => {
    const settings = parseSettings(['big:ctx_size=0', 'llm:ctx_size=4096', 'ctx_size=8192'])
    assert.deepEqual(settingsFor(settings, 'big', 'llm'), { ctx_size: 0 })
    assert.deepEqual(settingsFor(settings, 'small', 'llm'), { ctx_size: 4096 })
  })

  it('nests dotted keys and merges siblings', () => {
    const settings = parseSettings(['contextParams.n_ctx=4096', 'contextParams.use_gpu=false'])
    assert.deepEqual(settings.all, { contextParams: { n_ctx: 4096, use_gpu: false } })
  })

  it('takes a value as JSON when it parses, as a string otherwise', () => {
    const settings = parseSettings([
      'language=en',
      'projectionModelSrc=MMPROJ_X',
      'stop=["a","b"]',
      'temp=0.5'
    ])
    assert.deepEqual(settings.all, {
      language: 'en',
      projectionModelSrc: 'MMPROJ_X',
      stop: ['a', 'b'],
      temp: 0.5
    })
  })

  it('splits the model at the last colon, so an alias may hold one', () => {
    const settings = parseSettings(['qwen:8b:ctx_size=2048'])
    assert.deepEqual(settingsFor(settings, 'qwen:8b', 'llm'), { ctx_size: 2048 })
  })

  it('refuses a setting with no value, an empty model or an empty key', () => {
    for (const setting of ['ctx_size', ':ctx_size=1', 'big:=1', 'a..b=1']) {
      assert.throws(() => parseSettings([setting]), FitSettingError, setting)
    }
  })
})

const fitted: ModelFitResponse = {
  object: 'model_fit',
  verdict: 'does-not-fit',
  pools: [{ id: 'host', unified: true, usedBytes: 19 * GIB, freeBytes: 17 * GIB }],
  models: [
    {
      model: 'BIG',
      status: 'fits',
      devices: [
        { id: 'MTL0', name: 'MTL0', unified: true, usedBytes: 16 * GIB, freeBytes: 17 * GIB }
      ],
      stats: { ctxSize: 8192, gpuLayers: 36 }
    },
    {
      model: 'VOICE',
      status: 'unknown',
      devices: [],
      stats: {},
      reason: 'the engine fitter could not size this load'
    }
  ]
}

describe('formatFit', () => {
  it('shows each model with its context and rows, the reason when unknown, and the pools', () => {
    const text = formatFit(fitted)
    assert.match(text, /✔ BIG {2}fits · context 8192 · 36 GPU layers/)
    assert.match(text, /MTL0 +16\.00 GiB of 17\.00 GiB free/)
    assert.match(text, /\? VOICE {2}unknown — the engine fitter could not size this load/)
    assert.match(text, /✖ Loaded together: does-not-fit/)
    assert.match(text, /host +19\.00 GiB of 17\.00 GiB free/)
  })

  it('names the last block the verdict when there is one model', () => {
    const text = formatFit({ ...fitted, verdict: 'fits', models: [fitted.models[0]!] })
    assert.match(text, /✔ Verdict: fits/)
    assert.doesNotMatch(text, /Loaded together/)
  })
})

describe('assessCatalog', () => {
  it('judges every SDK constant by name with no serve.models alias loaded', async () => {
    const judged: { model: string; aliases: number }[] = []
    const report = await assessCatalog(parseSettings([]), undefined, (serveConfig, [only]) => {
      judged.push({ model: only!.model, aliases: serveConfig.models.size })
      return Promise.resolve({
        object: 'model_fit',
        verdict: 'fits',
        pools: [],
        models: [{ model: only!.model, status: 'fits', devices: [], stats: {} }]
      })
    })

    assert.deepEqual(
      judged.map((entry) => entry.model),
      catalogModels()
    )
    assert.ok(judged.every((entry) => entry.aliases === 0))
    assert.equal(report.withVerdict.length, judged.length)
  })
})

describe('formatCatalog', () => {
  it('lists models with a verdict apart from those without, each with its reason', () => {
    const text = formatCatalog({
      object: 'model_fit_catalog',
      withVerdict: [
        {
          model: 'BIG',
          verdict: 'fits',
          pools: fitted.pools,
          devices: [],
          stats: { ctxSize: 131072, gpuLayers: 25 }
        }
      ],
      withoutVerdict: [
        { model: 'VOICE', reason: 'the engine fitter could not size this load' },
        { model: 'MMPROJ', reason: 'cannot be read', code: 'MODEL_FIT_REJECTED' }
      ]
    })
    assert.match(
      text,
      /Models with a verdict \(1\)\n {2}✔ BIG {2}fits {2}19\.00 GiB · context 131072/
    )
    assert.match(text, /Models without a verdict \(2\)/)
    assert.match(text, /\? VOICE {2}the engine fitter could not size this load/)
    assert.match(text, /\? MMPROJ {2}MODEL_FIT_REJECTED: cannot be read/)
  })
})
