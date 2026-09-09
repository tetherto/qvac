import test from 'brittle'
import { handleGetLoadedModelInfo } from '@/handlers/get-loaded-model-info'
import { ModelNotFoundError } from '@/errors'
import { ERROR_CODES, ModelType } from '@/schemas'
import { registerModel, unregisterModel } from '@/runtime/model-registry'

let idCounter = 0
function makeId(prefix: string) {
  idCounter++
  return `${prefix}-${idCounter}`
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

test('getLoadedModelInfo: returns the fit probe verdict recorded at load', function (t) {
  const modelId = makeId('fit-probe-loaded-info')
  const fitProbe = {
    verdict: 'does-not-fit' as const,
    basis: 'native-probe' as const,
    estimatorVersion: 'native-probe-v1',
    reason: 'does-not-fit'
  }

  registerModel(modelId, {
    model: {
      load: () => Promise.resolve(),
      run: () => Promise.reject(),
      unload: () => {}
    } as never,
    path: '/models/model.gguf',
    config: { ctx_size: 4096 },
    modelType: ModelType.llamacppCompletion,
    fitProbe
  })
  t.teardown(() => {
    unregisterModel(modelId)
  })

  const { info } = handleGetLoadedModelInfo({ type: 'getLoadedModelInfo', modelId })

  // The point of the field: a caller reads the verdict off the API instead of
  // substring-matching an engine log line.
  t.alike(info.fitProbe, fitProbe)
})

test('getLoadedModelInfo: omits the fit probe when no verdict was recorded', function (t) {
  const modelId = makeId('no-fit-probe-loaded-info')

  registerModel(modelId, {
    model: {
      load: () => Promise.resolve(),
      run: () => Promise.reject(),
      unload: () => {}
    } as never,
    path: '/models/model.gguf',
    config: {},
    modelType: ModelType.llamacppCompletion
  })
  t.teardown(() => {
    unregisterModel(modelId)
  })

  const { info } = handleGetLoadedModelInfo({ type: 'getLoadedModelInfo', modelId })

  t.is(info.fitProbe, undefined)
})
