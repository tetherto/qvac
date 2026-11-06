import test from 'brittle'
import env from 'bare-env'
import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'
import { z } from 'zod'

import {
  ModelTypeRequiredError,
  PluginLoadConfigValidationFailedError,
  PluginNotFoundError
} from '@/errors/index'
import { assessModelFit, noStubDetail } from '@/model-fit/assess'
import type { AddonFit } from '@/model-fit/run/engine'
import { registerPlugin, unregisterPlugin } from '@/plugins/registry'
import { ModelType } from '@/schemas/index'
import type { FitLoad, QvacPlugin } from '@/schemas/plugin'

env['HOME'] = path.join(os.tmpdir(), `qvac-model-fit-assess-${os.pid()}`)

const GIB = 1024 ** 3

function modelFile(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-model-fit-assess-'))
  const file = path.join(dir, name)
  fs.writeFileSync(file, '')
  return file
}

function onHost(usedGiB: number, freeGiB = 32): AddonFit {
  return {
    status: 'fits',
    devices: [
      { id: 'CPU', name: 'CPU', unified: true, usedBytes: usedGiB * GIB, freeBytes: freeGiB * GIB }
    ],
    stats: {}
  }
}

/** A completion plugin whose fitter answers each model path from `answers`. */
function fakePlugin(answers: Map<string, AddonFit | Error>): QvacPlugin {
  return {
    modelType: ModelType.llamacppCompletion,
    displayName: 'Fake fit',
    addonPackage: '@qvac/fake-fit',
    loadConfigSchema: z.looseObject({}),
    createModel: () => ({ model: { load: async () => {} } }),
    fitRequest: (load: FitLoad) => ({ request: { modelPath: load.modelPath } }),
    assessFit: async (request: { modelPath: string }) => {
      const answer = answers.get(request.modelPath)
      if (answer instanceof Error) throw answer
      return answer
    },
    handlers: {}
  } as unknown as QvacPlugin
}

function withPlugin(t: { teardown(fn: () => void): void }, plugin: QvacPlugin): void {
  registerPlugin(plugin)
  t.teardown(() => unregisterPlugin(plugin.modelType))
}

test('assess: models that fit together fit', async (t) => {
  const first = modelFile('first.gguf')
  const second = modelFile('second.gguf')
  withPlugin(
    t,
    fakePlugin(
      new Map([
        [first, onHost(8)],
        [second, onHost(8)]
      ])
    )
  )

  const result = await assessModelFit([
    { modelSrc: first, modelType: ModelType.llamacppCompletion },
    { modelSrc: second, modelType: ModelType.llamacppCompletion }
  ])

  t.is(result.verdict, 'fits')
  t.alike(result.models, [onHost(8), onHost(8)], "each model is its addon's result")
  t.alike(result.pools, [{ id: 'host', unified: true, usedBytes: 16 * GIB, freeBytes: 32 * GIB }])
})

test('assess: models that fit alone may not fit together', async (t) => {
  const first = modelFile('first.gguf')
  const second = modelFile('second.gguf')
  withPlugin(
    t,
    fakePlugin(
      new Map([
        [first, onHost(16)],
        [second, onHost(16)]
      ])
    )
  )

  const result = await assessModelFit([
    { modelSrc: first, modelType: ModelType.llamacppCompletion },
    { modelSrc: second, modelType: ModelType.llamacppCompletion }
  ])

  t.is(result.verdict, 'does-not-fit')
  t.alike(
    result.models.map((model) => model.status),
    ['fits', 'fits'],
    'each model keeps its own status'
  )
})

test('assess: a fitter that rejects makes the assessment throw', async (t) => {
  const broken = modelFile('broken.gguf')
  withPlugin(t, fakePlugin(new Map([[broken, new Error('assessFit: the model cannot be read')]])))

  await t.exception(
    assessModelFit([{ modelSrc: broken, modelType: ModelType.llamacppCompletion }]),
    /the model cannot be read/
  )
})

test('assess: a transcription workload on an engine other than MOSS is unknown', async (t) => {
  const model = modelFile('model.gguf')
  withPlugin(t, fakePlugin(new Map([[model, onHost(1)]])))

  const result = await assessModelFit([
    {
      modelSrc: model,
      modelType: ModelType.llamacppCompletion,
      transcriptionWorkload: { audioSeconds: 30 }
    }
  ])

  t.is(result.verdict, 'unknown')
})

test('assess: an engine with no fitter is unknown, and so is the set', async (t) => {
  const model = modelFile('model.gguf')
  withPlugin(t, fakePlugin(new Map([[model, onHost(1)]])))
  withPlugin(t, {
    ...fakePlugin(new Map()),
    modelType: ModelType.ggmlClassification,
    fitRequest: undefined
  } as unknown as QvacPlugin)

  const result = await assessModelFit([
    { modelSrc: model, modelType: ModelType.llamacppCompletion },
    { modelSrc: model, modelType: ModelType.ggmlClassification }
  ])

  t.is(result.verdict, 'unknown')
  t.alike(result.models[1], { status: 'unknown', devices: [], stats: {} })
})

test('assess: an engine that builds a fit request but has no fitter is unknown', async (t) => {
  const model = modelFile('model.gguf')
  withPlugin(t, {
    ...fakePlugin(new Map()),
    modelType: ModelType.ggmlClassification,
    addonPackage: '@qvac/fake-request-only',
    assessFit: undefined
  } as unknown as QvacPlugin)

  const result = await assessModelFit([
    { modelSrc: model, modelType: ModelType.ggmlClassification }
  ])

  t.is(result.verdict, 'unknown')
  t.alike(result.models, [{ status: 'unknown', devices: [], stats: {} }])
})

test('assess: a split model is unknown, and the rest of the set is still assessed', async (t) => {
  const split = modelFile('model-00001-of-00002.gguf')
  const whole = modelFile('model.gguf')
  const seen: boolean[] = []
  withPlugin(t, {
    ...fakePlugin(new Map([[whole, onHost(1)]])),
    fitRequest: (load: FitLoad) => {
      seen.push(load.isShardedModel)
      return load.isShardedModel
        ? { unknown: 'the fitter reads one model file, and this model is split' }
        : { request: { modelPath: load.modelPath } }
    }
  } as unknown as QvacPlugin)

  const result = await assessModelFit([
    { modelSrc: split, modelType: ModelType.llamacppCompletion },
    { modelSrc: whole, modelType: ModelType.llamacppCompletion }
  ])

  t.alike(seen, [true, false], 'the split flag comes from the file name')
  t.is(result.verdict, 'unknown')
  t.alike(result.models, [{ status: 'unknown', devices: [], stats: {} }, onHost(1)])
})

test('assess: a catalog constant is split when its registry path names a shard', async (t) => {
  const seen: boolean[] = []
  withPlugin(t, {
    ...fakePlugin(new Map()),
    fitRequest: (load: FitLoad) => {
      seen.push(load.isShardedModel)
      return { unknown: 'recorded' }
    }
  } as unknown as QvacPlugin)

  const shard = modelFile('ab12cd34')
  await assessModelFit([
    {
      modelSrc: {
        src: shard,
        registryPath: 'models/gte-large_fp16-00001-of-00005.gguf'
      } as never,
      modelType: ModelType.llamacppCompletion
    }
  ])

  t.alike(seen, [true])
})

test('assess: the engine is read off the source when the caller omits it', async (t) => {
  const model = modelFile('model.gguf')
  withPlugin(t, fakePlugin(new Map([[model, onHost(1)]])))

  const result = await assessModelFit([
    { modelSrc: { src: model, engine: ModelType.llamacppCompletion } as never }
  ])

  t.is(result.verdict, 'fits')
})

test('assess: a model type with no plugin throws as the load does', async (t) => {
  await t.exception(
    assessModelFit([{ modelSrc: modelFile('model.gguf'), modelType: ModelType.ggmlVla }]),
    PluginNotFoundError as never
  )
})

test('assess: a config the plugin schema refuses throws as the load does', async (t) => {
  const model = modelFile('model.gguf')
  withPlugin(t, {
    ...fakePlugin(new Map([[model, onHost(1)]])),
    loadConfigSchema: z.strictObject({})
  } as unknown as QvacPlugin)

  await t.exception(
    assessModelFit([
      { modelSrc: model, modelType: ModelType.llamacppCompletion, modelConfig: { nope: 1 } }
    ]),
    PluginLoadConfigValidationFailedError as never
  )
})

test('assess: a source naming no engine is refused', async (t) => {
  await t.exception(
    assessModelFit([{ modelSrc: modelFile('model.gguf') }]),
    ModelTypeRequiredError as never
  )
})

test('assess: a files-only engine names the download as what is missing', (t) => {
  t.is(
    noStubDetail('files-only-engine'),
    'the engine measures downloaded files only, and this model is not downloaded'
  )
})

test('assess: a missing description names its reason and detail', (t) => {
  t.is(noStubDetail('timed-out'), 'no registry description (timed-out)')
  t.is(
    noStubDetail('no-fit-blob', 'models/model.gguf'),
    'no registry description (no-fit-blob): models/model.gguf'
  )
})
