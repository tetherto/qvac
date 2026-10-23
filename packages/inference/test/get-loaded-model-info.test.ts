import test from 'brittle'
import { handleGetLoadedModelInfo } from '@/handlers/get-loaded-model-info'
import { ModelNotFoundError } from '@/errors'
import { ERROR_CODES, ModelType, type ModelFitProbe } from '@/schemas'
import { registerModel, unregisterModel, type AnyModel } from '@/runtime/model-registry'

let idCounter = 0
function makeId(prefix: string) {
  idCounter++
  return `${prefix}-${idCounter}`
}

function register(t: { teardown(fn: () => void): void }, fitProbe?: ModelFitProbe) {
  const modelId = makeId('loaded-info')
  registerModel(modelId, {
    model: {} as unknown as AnyModel,
    path: '/models/model.gguf',
    config: {},
    modelType: ModelType.llamacppCompletion,
    ...(fitProbe && { fitProbe })
  })
  t.teardown(() => {
    unregisterModel(modelId)
  })
  return modelId
}

test('getLoadedModelInfo: unknown modelId throws ModelNotFoundError', function (t) {
  const modelId = makeId('nonexistent-loaded-info')

  try {
    handleGetLoadedModelInfo({ type: 'getLoadedModelInfo', modelId })
    t.fail('Expected handleGetLoadedModelInfo to throw')
  } catch (error) {
    t.ok(error instanceof ModelNotFoundError)
    t.is((error as ModelNotFoundError).code, ERROR_CODES.MODEL_NOT_FOUND)
  }
})

test('getLoadedModelInfo: returns the fit check recorded at load', function (t) {
  const fitProbe: ModelFitProbe = {
    verdict: 'fits',
    pools: [{ id: 'host', unified: true, usedBytes: 1024, freeBytes: 4096 }],
    models: [
      {
        status: 'fits',
        devices: [{ id: 'CPU', name: 'CPU', unified: true, usedBytes: 1024, freeBytes: 4096 }],
        stats: {}
      }
    ]
  }
  const modelId = register(t, fitProbe)

  const { info } = handleGetLoadedModelInfo({ type: 'getLoadedModelInfo', modelId })

  t.alike(info.fitProbe, fitProbe)
})

test('getLoadedModelInfo: omits the fit outcome when no probe ran', function (t) {
  const modelId = register(t)

  const { info } = handleGetLoadedModelInfo({ type: 'getLoadedModelInfo', modelId })

  t.is(info.fitProbe, undefined)
})
