import test from 'brittle'
import { handleGetLoadedModelInfo } from '@/handlers/get-loaded-model-info'
import { ModelNotFoundError } from '@/errors'
import { ERROR_CODES, ModelType, type NativeProbeFit } from '@/schemas'
import { registerModel, unregisterModel, type AnyModel } from '@/runtime/model-registry'

let idCounter = 0
function makeId(prefix: string) {
  idCounter++
  return `${prefix}-${idCounter}`
}

function register(t: { teardown(fn: () => void): void }, fitProbe?: NativeProbeFit) {
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

test('getLoadedModelInfo: returns the advisory fit outcome recorded at load', function (t) {
  const fitProbe: NativeProbeFit = {
    verdict: 'fit',
    basis: 'native-probe',
    engine: '@qvac/llm-llamacpp',
    estimatorVersion: 'native-probe-v1',
    reason: 'fits',
    plan: { nCtx: 4096, nGpuLayers: 33, nGpuDevices: 1 },
    projection: { deviceName: 'Metal', deviceBytes: 5_368_709_120 }
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
