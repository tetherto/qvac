import test from 'brittle'
import { handleGetLoadedModelInfo } from '@/handlers/get-loaded-model-info'
import { ModelNotFoundError } from '@/errors'
import {
  ERROR_CODES,
  ModelType,
  loadedModelInfoSchema,
  type CanonicalModelType,
  type NativeProbeFit
} from '@/schemas'
import { registerModel, unregisterModel, type AnyModel } from '@/runtime/model-registry'
import { getPlugin, registerPlugin, unregisterPlugin } from '@/plugins/registry'
import { decisionPlugin } from '@/plugins/builtin/llamacpp-decision/plugin'

let idCounter = 0
function makeId(prefix: string) {
  idCounter++
  return `${prefix}-${idCounter}`
}

function register(
  t: { teardown(fn: () => void): void },
  fitProbe?: NativeProbeFit,
  modelType: CanonicalModelType = ModelType.llamacppCompletion,
  model: unknown = {}
) {
  const modelId = makeId('loaded-info')
  registerModel(modelId, {
    model: model as AnyModel,
    path: '/models/model.gguf',
    config: {},
    modelType,
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
    estimatorVersion: 'native-probe-v2',
    reason: 'fits',
    plan: { nCtx: 4096, nGpuLayers: 33, nGpuDevices: 1 },
    projection: {
      deviceName: 'Metal',
      deviceBytes: 5_368_709_120,
      hostBytes: 268_435_456,
      weightsBytes: 4_294_967_296,
      contextBytes: 1_073_741_824,
      computeBytes: 0
    }
  }
  const modelId = register(t, fitProbe)

  const { info } = handleGetLoadedModelInfo({ type: 'getLoadedModelInfo', modelId })

  t.alike(info.fitProbe, fitProbe)
})

test('getLoadedModelInfo: omits the fit outcome when no probe ran', function (t) {
  const modelId = register(t)

  const { info } = handleGetLoadedModelInfo({ type: 'getLoadedModelInfo', modelId })

  t.is(info.fitProbe, undefined)
  t.is(info.decision, undefined, 'only decision models report decision info')
})

test('getLoadedModelInfo: reports what a decision model supports', function (t) {
  // The field follows the plugin's decide handler.
  if (!getPlugin(ModelType.llamacppDecision)) {
    registerPlugin(decisionPlugin)
    t.teardown(() => {
      unregisterPlugin(ModelType.llamacppDecision)
    })
  }
  const addonInfo = {
    decision_type: 'lev',
    noul: 'expected_rating',
    joint: false,
    shared_prefix: true,
    images: false,
    audio: false,
    score_levels: { min: 2, max: 10 },
    max_json_depth: 128,
    n_ctx: 4096,
    max_input_tokens: 4095,
    model: 'lev'
  }
  const levId = register(t, undefined, ModelType.llamacppDecision, { info: addonInfo })
  t.alike(handleGetLoadedModelInfo({ type: 'getLoadedModelInfo', modelId: levId }).info.decision, {
    decisionType: 'lev',
    noul: 'expectedRating',
    scoreLevels: { min: 2, max: 10 },
    maxInputTokens: 4095
  })

  // A meaning this SDK does not know is reported as unknown.
  const futureId = register(t, undefined, ModelType.llamacppDecision, {
    info: { ...addonInfo, decision_type: 'future', noul: 'something-new' }
  })
  t.is(
    handleGetLoadedModelInfo({ type: 'getLoadedModelInfo', modelId: futureId }).info.decision?.noul,
    'unknown'
  )
  const loadedSchema = loadedModelInfoSchema.safeParse(
    handleGetLoadedModelInfo({ type: 'getLoadedModelInfo', modelId: levId }).info
  )
  t.ok(loadedSchema.success, 'the response matches the contract')
})
